import type { Executor } from '../../platform/db.js';

export interface Hall {
  id: string;
  name: string;
  location: string;
  capacity: number;
  facilities: string[];
  description: string;
  isActive: boolean;
  createdAt: Date;
}

function map(r: Record<string, unknown>): Hall {
  return {
    id: r.id as string,
    name: r.name as string,
    location: r.location as string,
    capacity: r.capacity as number,
    facilities: r.facilities as string[],
    description: r.description as string,
    isActive: r.is_active as boolean,
    createdAt: r.created_at as Date,
  };
}

export interface HallInput {
  name: string;
  location: string;
  capacity: number;
  facilities: string[];
  description: string;
  isActive: boolean;
}

export async function insert(db: Executor, h: HallInput): Promise<Hall> {
  const { rows } = await db.query(
    `INSERT INTO halls (name, location, capacity, facilities, description, is_active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [h.name, h.location, h.capacity, h.facilities, h.description, h.isActive],
  );
  return map(rows[0]);
}

export async function update(db: Executor, id: string, h: HallInput): Promise<Hall> {
  const { rows } = await db.query(
    `UPDATE halls SET name = $2, location = $3, capacity = $4, facilities = $5, description = $6,
            is_active = $7, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, h.name, h.location, h.capacity, h.facilities, h.description, h.isActive],
  );
  return map(rows[0]);
}

/** Lock modes: 'update' for changes to the hall, 'share' to keep it from being changed while a booking is written. */
export async function getById(
  db: Executor,
  id: string,
  lock?: 'update' | 'share',
): Promise<Hall | null> {
  const suffix = lock === 'update' ? ' FOR UPDATE' : lock === 'share' ? ' FOR SHARE' : '';
  const { rows } = await db.query(`SELECT * FROM halls WHERE id = $1${suffix}`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

export async function list(db: Executor, f: { includeInactive: boolean }): Promise<Hall[]> {
  const { rows } = await db.query(
    `SELECT * FROM halls ${f.includeInactive ? '' : 'WHERE is_active'} ORDER BY lower(name), id`,
  );
  return rows.map(map);
}
