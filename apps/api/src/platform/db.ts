import pg from 'pg';

/** Anything that can run a query: the pool itself or a client inside a transaction. */
export type Executor = Pick<pg.Pool, 'query'>;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
}

/**
 * Runs `fn` inside one transaction. Commits on success, rolls back (and rethrows) on any error.
 * Pass the provided client to every repository call that must be atomic.
 */
export async function withTx<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the original error is more useful than a rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

export function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23503';
}

/** SQLSTATE 23P01: an exclusion constraint rejected the row (for example an overlapping hall booking). */
export function isExclusionViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23P01' && (constraint === undefined || e.constraint === constraint);
}

/**
 * SQLSTATE 40P01 (deadlock detected) and 40001 (serialization failure). PostgreSQL aborts one of
 * the competing transactions; the documented remedy is to run it again from the start.
 */
export function isRetryableTxError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === '40P01' || code === '40001';
}

/**
 * Runs `fn` (one whole transaction, including its own BEGIN/COMMIT) again if it was chosen as a
 * deadlock victim. `fn` must be safe to repeat: it may only have effects inside its transaction.
 */
export async function retryTx<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableTxError(err) || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * attempt));
    }
  }
}
