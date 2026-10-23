import type { Executor } from '../db.js';

export interface EnqueueOptions {
  type: string;
  payload?: Record<string, unknown>;
  /**
   * Idempotency key. Enqueueing the same key twice creates one job, so retried requests or
   * re-delivered events cannot duplicate side effects such as emails or certificates.
   */
  key?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/**
 * Adds a job. Call it with the transaction client of the business change that needs the job:
 * if that transaction rolls back, the job disappears with it.
 */
export async function enqueue(
  db: Executor,
  opts: EnqueueOptions,
): Promise<{ id: string | null; created: boolean }> {
  const { rows } = await db.query(
    `INSERT INTO jobs (type, payload, job_key, run_at, max_attempts)
     VALUES ($1, $2, $3, COALESCE($4, now()), COALESCE($5, 5))
     ON CONFLICT (job_key) WHERE job_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      opts.type,
      JSON.stringify(opts.payload ?? {}),
      opts.key ?? null,
      opts.runAt ?? null,
      opts.maxAttempts ?? null,
    ],
  );
  return rows[0] ? { id: rows[0].id as string, created: true } : { id: null, created: false };
}

export interface JobRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}

export function mapJob(row: Record<string, unknown>): JobRecord {
  return {
    id: row.id as string,
    type: row.type as string,
    payload: row.payload as Record<string, unknown>,
    status: row.status as JobRecord['status'],
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    lastError: (row.last_error as string | null) ?? null,
  };
}

/** Failed jobs (retries exhausted or permanent errors) for admin visibility. */
export async function listFailedJobs(db: Executor, limit = 50): Promise<JobRecord[]> {
  const { rows } = await db.query(
    "SELECT * FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT $1",
    [limit],
  );
  return rows.map(mapJob);
}
