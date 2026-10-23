import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { mapJob, type JobRecord } from './queue.js';

export interface JobContext {
  job: JobRecord;
  /** 1 for the first run, 2 for the first retry, and so on. */
  attempt: number;
  logger: Logger;
}
export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

/** Throw from a handler when retrying cannot help (bad payload, missing data). The job fails immediately. */
export class PermanentJobError extends Error {}

export interface WorkerOptions {
  pool: Pool;
  logger: Logger;
  lockSeconds: number;
  backoffBaseSeconds: number;
  pollIntervalMs: number;
  /** Override in tests to make retries immediate. */
  backoffSeconds?: (attempt: number) => number;
}

/** Exponential backoff (base * 2^(attempt-1)) capped at one hour, with +/-20% jitter. */
export function defaultBackoffSeconds(baseSeconds: number, attempt: number): number {
  const raw = Math.min(baseSeconds * 2 ** (attempt - 1), 3600);
  return Math.round(raw * (0.8 + Math.random() * 0.4));
}

/** A useful one-line description of any thrown value (Node's connection errors have empty messages). */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  const nested = err instanceof AggregateError ? err.errors.map(describeError).join('; ') : '';
  const parts = [typeof code === 'string' ? code : '', err.message, nested].filter(Boolean);
  return (parts.join(' - ') || err.name).slice(0, 1000);
}

export class JobWorker {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly opts: WorkerOptions) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Claims and runs at most one due job. Returns false when nothing was due. */
  async runOnce(): Promise<boolean> {
    const { pool, logger } = this.opts;
    await this.failExhaustedStaleJobs();
    const claimed = await pool.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1,
              locked_until = now() + make_interval(secs => $1), updated_at = now()
        WHERE id = (
          SELECT id FROM jobs
           WHERE (status = 'queued' AND run_at <= now())
              OR (status = 'running' AND locked_until < now() AND attempts < max_attempts)
           ORDER BY run_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING *`,
      [this.opts.lockSeconds],
    );
    if (!claimed.rows[0]) return false;

    const job = mapJob(claimed.rows[0]);
    const log = logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.fail(job, `No handler registered for job type "${job.type}"`, log);
      return true;
    }
    try {
      await handler(job.payload, { job, attempt: job.attempts, logger: log });
      await pool.query(
        "UPDATE jobs SET status = 'succeeded', completed_at = now(), locked_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1",
        [job.id],
      );
      log.info('job succeeded');
    } catch (err) {
      const message = describeError(err);
      if (err instanceof PermanentJobError || job.attempts >= job.maxAttempts) {
        await this.fail(job, message, log);
      } else {
        const delay = (
          this.opts.backoffSeconds ??
          ((a) => defaultBackoffSeconds(this.opts.backoffBaseSeconds, a))
        )(job.attempts);
        await pool.query(
          `UPDATE jobs SET status = 'queued', last_error = $2, locked_until = NULL,
                  run_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1`,
          [job.id, message.slice(0, 1000), delay],
        );
        log.warn({ err: message, retryInSeconds: delay }, 'job failed, will retry');
      }
    }
    return true;
  }

  /** Runs due jobs until none are left (used by tests and one-shot runs). */
  async drain(max = 1000): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        // keep working while jobs are due; otherwise sleep until the next poll
        this.inFlight = this.drain(50).then(() => undefined);
        await this.inFlight;
      } catch (err) {
        this.opts.logger.error({ err }, 'job worker poll failed');
      }
      if (this.running) this.timer = setTimeout(tick, this.opts.pollIntervalMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  private async fail(job: JobRecord, message: string, log: Logger): Promise<void> {
    await this.opts.pool.query(
      "UPDATE jobs SET status = 'failed', last_error = $2, locked_until = NULL, updated_at = now() WHERE id = $1",
      [job.id, message.slice(0, 1000)],
    );
    // Failed jobs are visible in the logs (alert on this message) and via listFailedJobs().
    log.error({ err: message }, 'job failed permanently');
  }

  /** A worker that died mid-job leaves status 'running'. After the lock expires, jobs with no attempts left are failed. */
  private async failExhaustedStaleJobs(): Promise<void> {
    await this.opts.pool.query(
      `UPDATE jobs SET status = 'failed', last_error = 'Worker lost while running; attempts exhausted',
              locked_until = NULL, updated_at = now()
        WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts`,
    );
  }
}
