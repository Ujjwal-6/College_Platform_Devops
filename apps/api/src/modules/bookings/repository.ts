import type { Executor } from '../../platform/db.js';
import type { Booking, BookingLevel, BookingStatus, BookingWarning } from './types.js';

function map(r: Record<string, unknown>): Booking {
  return {
    id: r.id as string,
    eventId: r.event_id as string,
    hallId: r.hall_id as string,
    requestedBy: r.requested_by as string,
    eventOrganizerId: r.event_organizer_id as string,
    departmentId: r.department_id as string,
    startAt: r.start_at as Date,
    endAt: r.end_at as Date,
    requiredFacilities: r.required_facilities as string[],
    notes: r.notes as string,
    status: r.status as BookingStatus,
    approvalLevel: (r.approval_level as BookingLevel | null) ?? null,
    approvalRound: r.approval_round as number,
    warnings: r.warnings as BookingWarning[],
    closingComment: (r.closing_comment as string | null) ?? null,
    decidedAt: (r.decided_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

export interface NewBooking {
  eventId: string;
  hallId: string;
  requestedBy: string;
  eventOrganizerId: string;
  departmentId: string;
  startAt: Date;
  endAt: Date;
  requiredFacilities: string[];
  notes: string;
  warnings: BookingWarning[];
}

/** May throw an exclusion violation (SQLSTATE 23P01) when the hall is already taken for part of the range. */
export async function insert(db: Executor, b: NewBooking): Promise<Booking> {
  const { rows } = await db.query(
    `INSERT INTO hall_bookings (event_id, hall_id, requested_by, event_organizer_id, department_id, start_at, end_at,
                                required_facilities, notes, status, approval_level, warnings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'faculty', $10) RETURNING *`,
    [
      b.eventId,
      b.hallId,
      b.requestedBy,
      b.eventOrganizerId,
      b.departmentId,
      b.startAt,
      b.endAt,
      b.requiredFacilities,
      b.notes,
      JSON.stringify(b.warnings),
    ],
  );
  return map(rows[0]);
}

export async function getById(
  db: Executor,
  id: string,
  forUpdate = false,
): Promise<Booking | null> {
  const { rows } = await db.query(
    `SELECT * FROM hall_bookings WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** The same request made again (a retry): same event, hall and range, still holding the slot. */
export async function findSameActive(
  db: Executor,
  q: { eventId: string; hallId: string; requestedBy: string; startAt: Date; endAt: Date },
): Promise<Booking | null> {
  const { rows } = await db.query(
    `SELECT * FROM hall_bookings
      WHERE event_id = $1 AND hall_id = $2 AND requested_by = $3 AND start_at = $4 AND end_at = $5
        AND status IN ('pending', 'confirmed') LIMIT 1`,
    [q.eventId, q.hallId, q.requestedBy, q.startAt, q.endAt],
  );
  return rows[0] ? map(rows[0]) : null;
}

export interface BookingColumns {
  hallId: string;
  startAt: Date;
  endAt: Date;
  requiredFacilities: string[];
  notes: string;
  status: BookingStatus;
  approvalLevel: BookingLevel | null;
  approvalRound: number;
  warnings: BookingWarning[];
  closingComment: string | null;
  decidedAt: Date | 'now' | null;
  eventOrganizerId: string;
  departmentId: string;
}
const COLUMN: Record<keyof BookingColumns, string> = {
  hallId: 'hall_id',
  startAt: 'start_at',
  endAt: 'end_at',
  requiredFacilities: 'required_facilities',
  notes: 'notes',
  status: 'status',
  approvalLevel: 'approval_level',
  approvalRound: 'approval_round',
  warnings: 'warnings',
  closingComment: 'closing_comment',
  decidedAt: 'decided_at',
  eventOrganizerId: 'event_organizer_id',
  departmentId: 'department_id',
};

/** Updates the named columns (names come from a fixed list, never from the request). */
export async function patch(
  db: Executor,
  id: string,
  changes: Partial<BookingColumns>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, value] of Object.entries(changes) as [keyof BookingColumns, unknown][]) {
    if (value === undefined) continue;
    const column = COLUMN[key];
    if (!column) throw new Error(`Unknown booking column "${key}"`);
    if (value === 'now') {
      sets.push(`${column} = now()`);
    } else {
      params.push(key === 'warnings' ? JSON.stringify(value) : value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (sets.length)
    await db.query(
      `UPDATE hall_bookings SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
      params,
    );
}

export interface OverlapRow {
  id: string;
  eventId: string;
  hallId: string;
  status: BookingStatus;
  startAt: Date;
  endAt: Date;
}

/** Active bookings of the given halls that overlap [startAt, endAt). Used for hints and availability, never as the guarantee. */
export async function findOverlapping(
  db: Executor,
  q: { hallIds: string[]; startAt: Date; endAt: Date; excludeId?: string },
): Promise<OverlapRow[]> {
  const { rows } = await db.query(
    `SELECT id, event_id, hall_id, status, start_at, end_at FROM hall_bookings
      WHERE hall_id = ANY($1::uuid[]) AND status IN ('pending', 'confirmed')
        AND tstzrange(start_at, end_at, '[)') && tstzrange($2, $3, '[)')
        AND ($4::uuid IS NULL OR id <> $4)
      ORDER BY start_at, id`,
    [q.hallIds, q.startAt, q.endAt, q.excludeId ?? null],
  );
  return rows.map((r) => ({
    id: r.id as string,
    eventId: r.event_id as string,
    hallId: r.hall_id as string,
    status: r.status as BookingStatus,
    startAt: r.start_at as Date,
    endAt: r.end_at as Date,
  }));
}

export async function activeForEvent(db: Executor, eventId: string): Promise<Booking[]> {
  const { rows } = await db.query(
    `SELECT * FROM hall_bookings WHERE event_id = $1 AND status IN ('pending', 'confirmed') ORDER BY start_at, id FOR UPDATE`,
    [eventId],
  );
  return rows.map(map);
}

export async function listForEvent(db: Executor, eventId: string): Promise<Booking[]> {
  const { rows } = await db.query(
    'SELECT * FROM hall_bookings WHERE event_id = $1 ORDER BY created_at, id',
    [eventId],
  );
  return rows.map(map);
}

export interface ListFilter {
  limit: number;
  offset: number;
  status?: BookingStatus;
  eventId?: string;
  departmentId?: string;
  mineOf?: string;
  queue?: { actorId: string; levels: { level: BookingLevel; departmentId: string | null }[] };
}

export async function list(
  db: Executor,
  f: ListFilter,
): Promise<{ rows: Booking[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.status) add('b.status = ?', f.status);
  if (f.eventId) add('b.event_id = ?', f.eventId);
  if (f.departmentId) add('b.department_id = ?', f.departmentId);
  if (f.mineOf) add('(b.requested_by = ? OR b.event_organizer_id = ?)', f.mineOf);
  if (f.queue) {
    if (f.queue.levels.length === 0) {
      where.push('false');
    } else {
      params.push(f.queue.actorId);
      const actor = `$${params.length}`;
      const ors = f.queue.levels.map((l) => {
        params.push(l.level);
        const lvl = `$${params.length}`;
        if (l.departmentId === null) return `(b.approval_level = ${lvl})`;
        params.push(l.departmentId);
        return `(b.approval_level = ${lvl} AND b.department_id = $${params.length})`;
      });
      where.push(
        `b.status = 'pending'`,
        `(${ors.join(' OR ')})`,
        `b.requested_by <> ${actor}`,
        `b.event_organizer_id <> ${actor}`,
      );
      where.push(
        `NOT EXISTS (SELECT 1 FROM booking_approvals a WHERE a.booking_id = b.id AND a.round = b.approval_round AND a.approver_id = ${actor})`,
      );
    }
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await db.query(`SELECT count(*)::int AS n FROM hall_bookings b ${clause}`, params);
  const { rows } = await db.query(
    `SELECT b.* FROM hall_bookings b ${clause} ORDER BY b.start_at, b.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.limit, f.offset],
  );
  return { rows: rows.map(map), total: count.rows[0].n as number };
}

// ---- approvals and history ---------------------------------------------------------------------

export interface BookingDecision {
  id: string;
  round: number;
  level: BookingLevel;
  decision: 'approved' | 'rejected';
  approverId: string;
  comment: string | null;
  decidedAt: Date;
}

export async function insertDecision(
  db: Executor,
  d: {
    bookingId: string;
    round: number;
    level: BookingLevel;
    decision: 'approved' | 'rejected';
    approverId: string;
    comment: string | null;
  },
): Promise<void> {
  await db.query(
    'INSERT INTO booking_approvals (booking_id, round, level, decision, approver_id, comment) VALUES ($1, $2, $3, $4, $5, $6)',
    [d.bookingId, d.round, d.level, d.decision, d.approverId, d.comment],
  );
}

export async function decisionsFor(db: Executor, bookingId: string): Promise<BookingDecision[]> {
  const { rows } = await db.query(
    'SELECT * FROM booking_approvals WHERE booking_id = $1 ORDER BY round, decided_at, id',
    [bookingId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    round: r.round as number,
    level: r.level as BookingLevel,
    decision: r.decision as 'approved' | 'rejected',
    approverId: r.approver_id as string,
    comment: (r.comment as string | null) ?? null,
    decidedAt: r.decided_at as Date,
  }));
}

export async function decidersInRound(
  db: Executor,
  bookingId: string,
  round: number,
): Promise<Set<string>> {
  const { rows } = await db.query(
    'SELECT approver_id FROM booking_approvals WHERE booking_id = $1 AND round = $2',
    [bookingId, round],
  );
  return new Set(rows.map((r) => r.approver_id as string));
}

export interface HistoryRow {
  id: number;
  action: string;
  actorId: string | null;
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus | null;
  level: BookingLevel | null;
  comment: string | null;
  createdAt: Date;
}

export async function addHistory(
  db: Executor,
  h: {
    bookingId: string;
    action: string;
    actorId: string | null;
    fromStatus?: BookingStatus | null;
    toStatus?: BookingStatus | null;
    level?: BookingLevel | null;
    comment?: string | null;
  },
): Promise<void> {
  await db.query(
    'INSERT INTO booking_history (booking_id, action, actor_id, from_status, to_status, level, comment) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [
      h.bookingId,
      h.action,
      h.actorId,
      h.fromStatus ?? null,
      h.toStatus ?? null,
      h.level ?? null,
      h.comment ?? null,
    ],
  );
}

export async function historyFor(db: Executor, bookingId: string): Promise<HistoryRow[]> {
  const { rows } = await db.query(
    'SELECT * FROM booking_history WHERE booking_id = $1 ORDER BY id',
    [bookingId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    action: r.action as string,
    actorId: (r.actor_id as string | null) ?? null,
    fromStatus: (r.from_status as BookingStatus | null) ?? null,
    toStatus: (r.to_status as BookingStatus | null) ?? null,
    level: (r.level as BookingLevel | null) ?? null,
    comment: (r.comment as string | null) ?? null,
    createdAt: r.created_at as Date,
  }));
}

/** Names of the halls with a confirmed booking for the event (for display, e.g. on a gate pass), or null. */
export async function confirmedVenue(db: Executor, eventId: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT string_agg(DISTINCT h.name, ', ' ORDER BY h.name) AS venue
       FROM hall_bookings b JOIN halls h ON h.id = b.hall_id
      WHERE b.event_id = $1 AND b.status = 'confirmed'`,
    [eventId],
  );
  return (rows[0]?.venue as string | null) ?? null;
}
