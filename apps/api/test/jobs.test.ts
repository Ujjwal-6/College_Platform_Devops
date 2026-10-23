import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { notify, registerNotificationHandlers } from '../src/modules/notifications/notify.js';
import { withTx } from '../src/platform/db.js';
import { enqueue, listFailedJobs } from '../src/platform/jobs/queue.js';
import {
  defaultBackoffSeconds,
  describeError,
  JobWorker,
  PermanentJobError,
} from '../src/platform/jobs/worker.js';
import { buildTestApp, resetDb } from './helpers.js';

const t = buildTestApp();
beforeEach(async () => {
  await resetDb(t.ctx);
  t.mailer.sent.length = 0;
  t.mailer.failNext = 0;
});
afterAll(() => t.close());

const makeWorker = () =>
  new JobWorker({
    pool: t.ctx.pool,
    logger: t.ctx.logger,
    lockSeconds: 60,
    backoffBaseSeconds: 1,
    pollIntervalMs: 100,
    backoffSeconds: () => 0, // retries become due immediately
  });
const jobRow = async () => (await t.ctx.pool.query('SELECT * FROM jobs')).rows[0];

describe('enqueue', () => {
  it('is idempotent for the same key', async () => {
    const a = await enqueue(t.ctx.pool, { type: 'x', key: 'same' });
    const b = await enqueue(t.ctx.pool, { type: 'x', key: 'same' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect((await t.ctx.pool.query('SELECT 1 FROM jobs')).rowCount).toBe(1);
  });

  it('allows unlimited jobs without a key', async () => {
    await enqueue(t.ctx.pool, { type: 'x' });
    await enqueue(t.ctx.pool, { type: 'x' });
    expect((await t.ctx.pool.query('SELECT 1 FROM jobs')).rowCount).toBe(2);
  });

  it('leaves no job behind when the surrounding transaction rolls back', async () => {
    await expect(
      withTx(t.ctx.pool, async (tx) => {
        await enqueue(tx, { type: 'x', key: 'k' });
        throw new Error('business change failed');
      }),
    ).rejects.toThrow();
    expect((await t.ctx.pool.query('SELECT 1 FROM jobs')).rowCount).toBe(0);
  });

  it('does not run jobs scheduled for the future', async () => {
    const w = makeWorker();
    let ran = false;
    w.register('x', async () => void (ran = true));
    await enqueue(t.ctx.pool, { type: 'x', runAt: new Date(Date.now() + 3_600_000) });
    expect(await w.runOnce()).toBe(false);
    expect(ran).toBe(false);
  });
});

describe('job worker', () => {
  it('runs a job once and marks it succeeded', async () => {
    const w = makeWorker();
    const seen: unknown[] = [];
    w.register('x', async (payload) => void seen.push(payload));
    await enqueue(t.ctx.pool, { type: 'x', payload: { a: 1 } });
    expect(await w.drain()).toBe(1);
    expect(seen).toEqual([{ a: 1 }]);
    expect(await jobRow()).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(await w.runOnce()).toBe(false);
  });

  it('retries a failing job and succeeds on a later attempt', async () => {
    const w = makeWorker();
    let calls = 0;
    w.register('flaky', async () => {
      if (++calls < 3) throw new Error('temporary outage');
    });
    await enqueue(t.ctx.pool, { type: 'flaky' });
    await w.drain();
    expect(calls).toBe(3);
    expect(await jobRow()).toMatchObject({ status: 'succeeded', attempts: 3, last_error: null });
  });

  it('moves a job to failed after max attempts and exposes it for admins', async () => {
    const w = makeWorker();
    let calls = 0;
    w.register('broken', async () => {
      calls++;
      throw new Error('always down');
    });
    await enqueue(t.ctx.pool, { type: 'broken', maxAttempts: 3 });
    await w.drain();
    expect(calls).toBe(3);
    const failed = await listFailedJobs(t.ctx.pool);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'failed', attempts: 3, lastError: 'always down' });
  });

  it('fails immediately on a permanent error, without retrying', async () => {
    const w = makeWorker();
    let calls = 0;
    w.register('bad', async () => {
      calls++;
      throw new PermanentJobError('payload is invalid');
    });
    await enqueue(t.ctx.pool, { type: 'bad' });
    await w.drain();
    expect(calls).toBe(1);
    expect(await jobRow()).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('fails jobs with no registered handler', async () => {
    const w = makeWorker();
    await enqueue(t.ctx.pool, { type: 'mystery' });
    await w.drain();
    expect(await jobRow()).toMatchObject({ status: 'failed' });
  });

  it('recovers a job left running by a crashed worker, and fails it if attempts are used up', async () => {
    const w = makeWorker();
    let calls = 0;
    w.register('x', async () => void calls++);
    await enqueue(t.ctx.pool, { type: 'x', maxAttempts: 2 });
    await t.ctx.pool.query(
      "UPDATE jobs SET status = 'running', attempts = 1, locked_until = now() - interval '1 minute'",
    );
    await w.drain();
    expect(calls).toBe(1);
    expect(await jobRow()).toMatchObject({ status: 'succeeded', attempts: 2 });

    await t.ctx.pool.query(
      "UPDATE jobs SET status = 'running', attempts = 2, locked_until = now() - interval '1 minute'",
    );
    await w.drain();
    expect(calls).toBe(1); // not run again
    expect(await jobRow()).toMatchObject({ status: 'failed' });
  });

  it('never runs one job twice when several workers compete', async () => {
    const counts = new Map<string, number>();
    const workers = [makeWorker(), makeWorker(), makeWorker()];
    for (const w of workers) {
      w.register('x', async (p) => {
        const id = String(p.n);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    for (let n = 0; n < 30; n++) await enqueue(t.ctx.pool, { type: 'x', payload: { n } });
    await Promise.all(workers.map((w) => w.drain()));
    expect(counts.size).toBe(30);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
  });

  it('start() processes jobs in the background and stop() waits for them', async () => {
    const w = makeWorker();
    let done = false;
    w.register('x', async () => void (done = true));
    await enqueue(t.ctx.pool, { type: 'x' });
    w.start();
    for (let i = 0; i < 50 && !done; i++) await new Promise((r) => setTimeout(r, 50));
    await w.stop();
    expect(done).toBe(true);
  });

  it('backs off exponentially with a cap', () => {
    const near = (n: number, target: number) => n >= target * 0.8 && n <= target * 1.2;
    expect(near(defaultBackoffSeconds(30, 1), 30)).toBe(true);
    expect(near(defaultBackoffSeconds(30, 3), 120)).toBe(true);
    expect(defaultBackoffSeconds(30, 20)).toBeLessThanOrEqual(4320);
  });
});

describe('describeError', () => {
  it('keeps error codes and nested causes so failed jobs can be diagnosed', () => {
    const refused = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    expect(describeError(new AggregateError([refused, refused], ''))).toBe(
      'ECONNREFUSED; ECONNREFUSED',
    );
    expect(describeError(new Error('plain'))).toBe('plain');
    expect(describeError('text')).toBe('text');
    expect(describeError(new TypeError(''))).toBe('TypeError');
  });
});

describe('email notifications', () => {
  it('sends the rendered email through the mailer', async () => {
    const w = makeWorker();
    registerNotificationHandlers(w, t.mailer);
    await notify(t.ctx.pool, {
      type: 'account.created',
      to: 'new@college.test',
      data: { name: 'Asha', loginUrl: 'http://localhost:5173/login' },
    });
    await w.drain();
    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0]).toMatchObject({
      to: 'new@college.test',
      subject: 'Your College Events account',
    });
    expect(t.mailer.sent[0]!.text).toContain('Asha');
  });

  it('retries when the mail server is down, then delivers exactly one email', async () => {
    const w = makeWorker();
    registerNotificationHandlers(w, t.mailer);
    t.mailer.failNext = 2;
    await notify(t.ctx.pool, {
      type: 'account.created',
      to: 'new@college.test',
      data: { name: 'Asha', loginUrl: 'http://x/login' },
    });
    await w.drain();
    expect(t.mailer.sent).toHaveLength(1);
    expect(await jobRow()).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('does not send duplicates for the same idempotency key', async () => {
    const w = makeWorker();
    registerNotificationHandlers(w, t.mailer);
    const n = {
      type: 'account.created' as const,
      to: 'new@college.test',
      data: { name: 'Asha', loginUrl: 'http://x/login' },
      key: 'once',
    };
    await notify(t.ctx.pool, n);
    await notify(t.ctx.pool, n);
    await w.drain();
    expect(t.mailer.sent).toHaveLength(1);
  });

  it('rejects invalid notification data when queueing, and fails malformed jobs permanently', async () => {
    await expect(
      notify(t.ctx.pool, { type: 'account.created', to: 'a@b.test', data: {} }),
    ).rejects.toThrow();
    const w = makeWorker();
    registerNotificationHandlers(w, t.mailer);
    await enqueue(t.ctx.pool, {
      type: 'email.send',
      payload: { notification: 'does.not.exist', to: 'a@b.test', data: {} },
    });
    await w.drain();
    expect(await jobRow()).toMatchObject({ status: 'failed', attempts: 1 });
    expect(t.mailer.sent).toHaveLength(0);
  });
});
