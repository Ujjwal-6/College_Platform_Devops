import type { Executor } from '../../platform/db.js';
import type { AuthUser, Role } from './types.js';

export interface UserRow extends AuthUser {
  isActive: boolean;
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
}

const USER_SELECT = `
  SELECT u.id, u.email, u.name, u.department_id, u.is_active, u.password_hash,
         u.failed_login_count, u.locked_until,
         COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
  FROM users u
  LEFT JOIN user_roles r ON r.user_id = u.id`;

function mapUser(row: Record<string, unknown>): UserRow {
  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    roles: row.roles as Role[],
    departmentId: (row.department_id as string | null) ?? null,
    isActive: row.is_active as boolean,
    passwordHash: row.password_hash as string,
    failedLoginCount: row.failed_login_count as number,
    lockedUntil: (row.locked_until as Date | null) ?? null,
  };
}

export async function findUserByEmail(db: Executor, email: string): Promise<UserRow | null> {
  const { rows } = await db.query(`${USER_SELECT} WHERE u.email = $1 GROUP BY u.id`, [
    email.toLowerCase(),
  ]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserById(db: Executor, id: string): Promise<UserRow | null> {
  const { rows } = await db.query(`${USER_SELECT} WHERE u.id = $1 GROUP BY u.id`, [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function recordFailedLogin(
  db: Executor,
  userId: string,
  threshold: number,
  lockMinutes: number,
): Promise<{ locked: boolean }> {
  const { rows } = await db.query(
    `UPDATE users
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE WHEN failed_login_count + 1 >= $2
                                THEN now() + make_interval(mins => $3) ELSE locked_until END
      WHERE id = $1
      RETURNING (failed_login_count >= $2) AS locked`,
    [userId, threshold, lockMinutes],
  );
  return { locked: Boolean(rows[0]?.locked) };
}

export async function resetFailedLogins(db: Executor, userId: string): Promise<void> {
  await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [
    userId,
  ]);
}

export async function updatePasswordHash(
  db: Executor,
  userId: string,
  hash: string,
): Promise<void> {
  await db.query(
    'UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1',
    [userId, hash],
  );
}

// ---- refresh tokens -------------------------------------------------------

export interface RefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

function mapToken(row: Record<string, unknown>): RefreshTokenRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    familyId: row.family_id as string,
    expiresAt: row.expires_at as Date,
    rotatedAt: (row.rotated_at as Date | null) ?? null,
    revokedAt: (row.revoked_at as Date | null) ?? null,
  };
}

export async function insertRefreshToken(
  db: Executor,
  input: { userId: string; familyId?: string; tokenHash: string; ttlDays: number },
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, now() + make_interval(days => $4))
     RETURNING id`,
    [input.userId, input.familyId ?? null, input.tokenHash, input.ttlDays],
  );
  return rows[0].id as string;
}

/** Row-locks the token so concurrent refreshes with the same token are serialized. */
export async function lockRefreshTokenByHash(
  db: Executor,
  tokenHash: string,
): Promise<RefreshTokenRow | null> {
  const { rows } = await db.query('SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [
    tokenHash,
  ]);
  return rows[0] ? mapToken(rows[0]) : null;
}

export async function markRotated(db: Executor, oldId: string, newId: string): Promise<void> {
  await db.query('UPDATE refresh_tokens SET rotated_at = now(), replaced_by = $2 WHERE id = $1', [
    oldId,
    newId,
  ]);
}

export async function secondsSinceRotation(db: Executor, tokenId: string): Promise<number> {
  const { rows } = await db.query(
    'SELECT EXTRACT(EPOCH FROM (now() - rotated_at))::float8 AS s FROM refresh_tokens WHERE id = $1',
    [tokenId],
  );
  return (rows[0]?.s as number | null) ?? Number.POSITIVE_INFINITY;
}

export async function revokeFamily(db: Executor, familyId: string): Promise<void> {
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
    [familyId],
  );
}

export async function revokeAllForUser(db: Executor, userId: string): Promise<void> {
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}
