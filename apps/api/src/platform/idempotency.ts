import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { Executor } from './db.js';
import { AppError, errors } from './errors.js';

/** A stored answer: what the first successful request returned. */
export interface StoredResponse {
  status: number;
  body: unknown;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** A key is remembered for a day; after that the same key is treated as new. */
const KEY_TTL_HOURS = 24;

/** Reads the optional `Idempotency-Key` header. A malformed key is a client error, never ignored. */
export function idempotencyKey(req: Request): string | undefined {
  const key = req.get('idempotency-key');
  if (key === undefined) return undefined;
  if (!KEY_PATTERN.test(key)) {
    throw errors.validation([
      {
        path: 'Idempotency-Key',
        message: 'Use 8 to 64 letters, digits, "-" or "_" (a random UUID works well)',
      },
    ]);
  }
  return key;
}

/** Identifies "the same request": method, path and body. The same key with another request is refused. */
export function requestFingerprint(req: Request): string {
  return createHash('sha256')
    .update(JSON.stringify([req.method, req.baseUrl + req.path, req.body ?? null]))
    .digest('hex');
}

/**
 * Runs `run` once per (user, key). Call inside the transaction that does the work: the claim and the
 * stored answer commit or roll back together with it.
 *
 * - First call: `run` executes and its answer is stored.
 * - Repeat with the same request: the stored answer is returned and `run` does not execute.
 * - Repeat while the first is still running: the second waits for the first to commit (the claim row
 *   is locked by the first transaction) and then returns the stored answer.
 * - Same key, different request: 422 IDEMPOTENCY_KEY_REUSED.
 * - If `run` throws, nothing is stored, so a corrected retry is evaluated afresh.
 */
export async function withIdempotency(
  tx: Executor,
  scope: { userId: string; key: string | undefined; fingerprint: string },
  run: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  if (!scope.key) return { ...(await run()), replayed: false };

  for (let attempt = 0; attempt < 2; attempt++) {
    const claim = await tx.query(
      `INSERT INTO idempotency_keys (user_id, key, fingerprint) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING 1`,
      [scope.userId, scope.key, scope.fingerprint],
    );
    if (claim.rowCount === 1) {
      const result = await run();
      await tx.query(
        'UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2',
        [scope.userId, scope.key, result.status, JSON.stringify(result.body)],
      );
      return { ...result, replayed: false };
    }

    const { rows } = await tx.query(
      `SELECT fingerprint, status_code, response,
              created_at < now() - make_interval(hours => $3) AS expired
         FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
      [scope.userId, scope.key, KEY_TTL_HOURS],
    );
    const stored = rows[0];
    if (!stored) continue; // removed between the two statements: claim it again
    if (stored.expired) {
      await tx.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [
        scope.userId,
        scope.key,
      ]);
      continue;
    }
    if (stored.fingerprint !== scope.fingerprint) {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request',
      );
    }
    if (stored.status_code === null) {
      throw errors.conflict('REQUEST_IN_PROGRESS', 'The same request is still being processed');
    }
    return {
      status: stored.status_code as number,
      body: stored.response as unknown,
      replayed: true,
    };
  }
  throw errors.conflict('TRY_AGAIN', 'Please try again');
}
