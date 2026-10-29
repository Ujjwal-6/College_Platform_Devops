import type { Executor } from '../../platform/db.js';
import type { Role } from '../auth/types.js';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  departmentId: string | null;
  isActive: boolean;
  createdAt: Date;
}

const SELECT = `
  SELECT u.id, u.email, u.name, u.department_id, u.is_active, u.created_at,
         COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
  FROM users u LEFT JOIN user_roles r ON r.user_id = u.id`;

function map(row: Record<string, unknown>): PublicUser {
  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    roles: row.roles as Role[],
    departmentId: (row.department_id as string | null) ?? null,
    isActive: row.is_active as boolean,
    createdAt: row.created_at as Date,
  };
}

export async function getById(db: Executor, id: string): Promise<PublicUser | null> {
  const { rows } = await db.query(`${SELECT} WHERE u.id = $1 GROUP BY u.id`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

export interface ListFilter {
  limit: number;
  offset: number;
  departmentId?: string;
  role?: Role;
  isActive?: boolean;
}

export async function list(
  db: Executor,
  f: ListFilter,
): Promise<{ rows: PublicUser[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.departmentId) add('u.department_id = ?', f.departmentId);
  if (f.isActive !== undefined) add('u.is_active = ?', f.isActive);
  if (f.role)
    add('EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role = ?)', f.role);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const count = await db.query(`SELECT count(*)::int AS n FROM users u ${clause}`, params);
  const { rows } = await db.query(
    `${SELECT} ${clause} GROUP BY u.id ORDER BY u.created_at, u.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.limit, f.offset],
  );
  return { rows: rows.map(map), total: count.rows[0].n as number };
}

export async function insert(
  db: Executor,
  u: { email: string; name: string; passwordHash: string; departmentId: string | null },
): Promise<string> {
  const { rows } = await db.query(
    'INSERT INTO users (email, name, password_hash, department_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [u.email.toLowerCase(), u.name, u.passwordHash, u.departmentId],
  );
  return rows[0].id as string;
}

export async function setRoles(db: Executor, userId: string, roles: Role[]): Promise<void> {
  await db.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  await db.query('INSERT INTO user_roles (user_id, role) SELECT $1, unnest($2::text[])', [
    userId,
    roles,
  ]);
}

export async function updateProfile(
  db: Executor,
  userId: string,
  patch: { name?: string; departmentId?: string | null },
): Promise<void> {
  await db.query(
    `UPDATE users SET name = COALESCE($2, name),
            department_id = CASE WHEN $3::boolean THEN $4::uuid ELSE department_id END,
            updated_at = now()
      WHERE id = $1`,
    [userId, patch.name ?? null, patch.departmentId !== undefined, patch.departmentId ?? null],
  );
}

export async function setActive(db: Executor, userId: string, active: boolean): Promise<void> {
  await db.query('UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1', [
    userId,
    active,
  ]);
}

/** Locks every active admin row and returns their ids, so concurrent "remove an admin" calls serialize. */
export async function lockActiveAdminIds(db: Executor): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE r.role = 'admin' AND u.is_active ORDER BY u.id FOR UPDATE OF u`,
  );
  return rows.map((r) => r.id as string);
}

export async function lockUser(db: Executor, userId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  return rows.length > 0;
}

export async function departmentExists(db: Executor, id: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM departments WHERE id = $1', [id]);
  return rows.length > 0;
}

export interface UserContact {
  id: string;
  email: string;
  name: string;
}

/** Active users holding a role, optionally limited to one department. Used to find approvers. */
export async function listActiveByRole(
  db: Executor,
  role: Role,
  departmentId: string | null,
): Promise<UserContact[]> {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE r.role = $1 AND u.is_active AND ($2::uuid IS NULL OR u.department_id = $2)
      ORDER BY u.name, u.id`,
    [role, departmentId],
  );
  return rows as UserContact[];
}

/** An account by email address (any case), with whether it is active. */
export async function findContactByEmail(
  db: Executor,
  email: string,
): Promise<(UserContact & { isActive: boolean }) | null> {
  const { rows } = await db.query('SELECT id, email, name, is_active FROM users WHERE email = $1', [
    email.toLowerCase(),
  ]);
  return rows[0]
    ? {
        id: rows[0].id as string,
        email: rows[0].email as string,
        name: rows[0].name as string,
        isActive: rows[0].is_active as boolean,
      }
    : null;
}

/** Name and email for a set of users (to address notifications). */
export async function getContacts(db: Executor, ids: string[]): Promise<UserContact[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query(
    'SELECT id, email, name FROM users WHERE id = ANY($1::uuid[]) ORDER BY name, id',
    [ids],
  );
  return rows as UserContact[];
}

export async function getNames(db: Executor, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query('SELECT id, name FROM users WHERE id = ANY($1::uuid[])', [ids]);
  return new Map(rows.map((r) => [r.id as string, r.name as string]));
}
