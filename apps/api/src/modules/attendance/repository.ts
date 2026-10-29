import type { Executor } from '../../platform/db.js';

export type CheckInMethod = 'qr' | 'manual';

export interface AttendanceRecord {
  id: string;
  registrationId: string;
  eventId: string;
  userId: string;
  checkedInBy: string;
  method: CheckInMethod;
  reason: string | null;
  checkedInAt: Date;
}

function map(r: Record<string, unknown>): AttendanceRecord {
  return {
    id: r.id as string,
    registrationId: r.registration_id as string,
    eventId: r.event_id as string,
    userId: r.user_id as string,
    checkedInBy: r.checked_in_by as string,
    method: r.method as CheckInMethod,
    reason: (r.reason as string | null) ?? null,
    checkedInAt: r.checked_in_at as Date,
  };
}

/**
 * Records a check-in. The unique constraint on registration_id decides a race: the second insert
 * does nothing and returns null, so two scans of one pass can never make two rows.
 */
export async function insertAttendance(
  db: Executor,
  v: {
    registrationId: string;
    eventId: string;
    userId: string;
    checkedInBy: string;
    method: CheckInMethod;
    reason: string | null;
  },
): Promise<AttendanceRecord | null> {
  const { rows } = await db.query(
    `INSERT INTO attendance (registration_id, event_id, user_id, checked_in_by, method, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ON CONSTRAINT attendance_registration_key DO NOTHING RETURNING *`,
    [v.registrationId, v.eventId, v.userId, v.checkedInBy, v.method, v.reason],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function findByRegistration(
  db: Executor,
  registrationId: string,
): Promise<AttendanceRecord | null> {
  const { rows } = await db.query('SELECT * FROM attendance WHERE registration_id = $1', [
    registrationId,
  ]);
  return rows[0] ? map(rows[0]) : null;
}

export async function countForEvent(db: Executor, eventId: string): Promise<number> {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM attendance WHERE event_id = $1', [
    eventId,
  ]);
  return rows[0].n as number;
}

export async function listForEvent(
  db: Executor,
  eventId: string,
  limit: number,
  offset: number,
): Promise<AttendanceRecord[]> {
  const { rows } = await db.query(
    `SELECT * FROM attendance WHERE event_id = $1
      ORDER BY checked_in_at DESC, id LIMIT $2 OFFSET $3`,
    [eventId, limit, offset],
  );
  return rows.map(map);
}

export async function attendedUserIds(db: Executor, eventId: string): Promise<string[]> {
  const { rows } = await db.query(
    'SELECT user_id FROM attendance WHERE event_id = $1 ORDER BY checked_in_at, id',
    [eventId],
  );
  return rows.map((r) => r.user_id as string);
}

// ---- volunteers --------------------------------------------------------------------------------

export interface VolunteerRow {
  userId: string;
  assignedBy: string;
  createdAt: Date;
}

/** Returns false if the person was already a volunteer for the event. */
export async function addVolunteer(
  db: Executor,
  v: { eventId: string; userId: string; assignedBy: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO event_volunteers (event_id, user_id, assigned_by) VALUES ($1, $2, $3)
     ON CONFLICT (event_id, user_id) DO NOTHING`,
    [v.eventId, v.userId, v.assignedBy],
  );
  return rowCount === 1;
}

export async function removeVolunteer(
  db: Executor,
  eventId: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    'DELETE FROM event_volunteers WHERE event_id = $1 AND user_id = $2',
    [eventId, userId],
  );
  return rowCount === 1;
}

export async function listVolunteers(db: Executor, eventId: string): Promise<VolunteerRow[]> {
  const { rows } = await db.query(
    'SELECT user_id, assigned_by, created_at FROM event_volunteers WHERE event_id = $1 ORDER BY created_at, user_id',
    [eventId],
  );
  return rows.map((r) => ({
    userId: r.user_id as string,
    assignedBy: r.assigned_by as string,
    createdAt: r.created_at as Date,
  }));
}

export async function isVolunteer(db: Executor, eventId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM event_volunteers WHERE event_id = $1 AND user_id = $2',
    [eventId, userId],
  );
  return rows.length > 0;
}

export async function volunteerEventIds(db: Executor, userId: string): Promise<string[]> {
  const { rows } = await db.query('SELECT event_id FROM event_volunteers WHERE user_id = $1', [
    userId,
  ]);
  return rows.map((r) => r.event_id as string);
}

// ---- gate passes -------------------------------------------------------------------------------

export async function findGatePassKey(
  db: Executor,
  registrationId: string,
): Promise<string | null> {
  const { rows } = await db.query(
    'SELECT storage_key FROM gate_passes WHERE registration_id = $1',
    [registrationId],
  );
  return rows[0] ? (rows[0].storage_key as string) : null;
}

/** Returns false if a pass was already recorded (another worker finished first). */
export async function insertGatePass(
  db: Executor,
  registrationId: string,
  storageKey: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO gate_passes (registration_id, storage_key) VALUES ($1, $2)
     ON CONFLICT (registration_id) DO NOTHING`,
    [registrationId, storageKey],
  );
  return rowCount === 1;
}
