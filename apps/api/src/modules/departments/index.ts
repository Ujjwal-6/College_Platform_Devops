import type { Executor } from '../../platform/db.js';

/** Public surface of the departments module: other features show a department's name (certificates, reports). */
export async function getDepartmentName(db: Executor, id: string): Promise<string | null> {
  const { rows } = await db.query('SELECT name FROM departments WHERE id = $1', [id]);
  return rows[0] ? (rows[0].name as string) : null;
}
