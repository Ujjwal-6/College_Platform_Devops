import type { Executor } from '../../platform/db.js';
import type {
  ApprovalLevel,
  CalendarWarningSnapshot,
  EventRecord,
  EventStatus,
  RegistrationMode,
  Speaker,
} from './types.js';

/** Marker for "set this column to the database clock". */
export const NOW = Symbol('now');

export interface EventColumns {
  title: string;
  description: string;
  category: string;
  departmentId: string;
  status: EventStatus;
  approvalLevel: ApprovalLevel | null;
  submissionRound: number;
  startAt: Date;
  endAt: Date;
  expectedAttendance: number;
  capacity: number | null;
  registrationMode: RegistrationMode;
  teamSizeMin: number | null;
  teamSizeMax: number | null;
  registrationDeadline: Date | null;
  calendarWarnings: CalendarWarningSnapshot[];
  lastRejectionLevel: ApprovalLevel | null;
  lastRejectionComment: string | null;
  lastRejectedBy: string | null;
  lastRejectedAt: Date | typeof NOW | null;
  submittedAt: Date | typeof NOW | null;
  approvedAt: Date | typeof NOW | null;
  publishedAt: Date | typeof NOW | null;
  closedAt: Date | typeof NOW | null;
  cancelledAt: Date | typeof NOW | null;
  cancelReason: string | null;
}

const COLUMN_NAMES: Record<keyof EventColumns, string> = {
  title: 'title',
  description: 'description',
  category: 'category',
  departmentId: 'department_id',
  status: 'status',
  approvalLevel: 'approval_level',
  submissionRound: 'submission_round',
  startAt: 'start_at',
  endAt: 'end_at',
  expectedAttendance: 'expected_attendance',
  capacity: 'capacity',
  registrationMode: 'registration_mode',
  teamSizeMin: 'team_size_min',
  teamSizeMax: 'team_size_max',
  registrationDeadline: 'registration_deadline',
  calendarWarnings: 'calendar_warnings',
  lastRejectionLevel: 'last_rejection_level',
  lastRejectionComment: 'last_rejection_comment',
  lastRejectedBy: 'last_rejected_by',
  lastRejectedAt: 'last_rejected_at',
  submittedAt: 'submitted_at',
  approvedAt: 'approved_at',
  publishedAt: 'published_at',
  closedAt: 'closed_at',
  cancelledAt: 'cancelled_at',
  cancelReason: 'cancel_reason',
};

function map(r: Record<string, unknown>): EventRecord {
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    category: r.category as string,
    departmentId: r.department_id as string,
    organizerId: r.organizer_id as string,
    status: r.status as EventStatus,
    approvalLevel: (r.approval_level as ApprovalLevel | null) ?? null,
    submissionRound: r.submission_round as number,
    startAt: r.start_at as Date,
    endAt: r.end_at as Date,
    expectedAttendance: r.expected_attendance as number,
    capacity: (r.capacity as number | null) ?? null,
    registrationMode: r.registration_mode as RegistrationMode,
    teamSizeMin: (r.team_size_min as number | null) ?? null,
    teamSizeMax: (r.team_size_max as number | null) ?? null,
    registrationDeadline: (r.registration_deadline as Date | null) ?? null,
    calendarWarnings: r.calendar_warnings as CalendarWarningSnapshot[],
    lastRejection: r.last_rejection_level
      ? {
          level: r.last_rejection_level as ApprovalLevel,
          comment: r.last_rejection_comment as string,
          by: r.last_rejected_by as string,
          at: r.last_rejected_at as Date,
        }
      : null,
    submittedAt: (r.submitted_at as Date | null) ?? null,
    approvedAt: (r.approved_at as Date | null) ?? null,
    publishedAt: (r.published_at as Date | null) ?? null,
    closedAt: (r.closed_at as Date | null) ?? null,
    cancelledAt: (r.cancelled_at as Date | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

export type NewEvent = Pick<
  EventColumns,
  | 'title'
  | 'description'
  | 'category'
  | 'departmentId'
  | 'startAt'
  | 'endAt'
  | 'expectedAttendance'
  | 'capacity'
  | 'registrationMode'
  | 'teamSizeMin'
  | 'teamSizeMax'
  | 'registrationDeadline'
> & { organizerId: string };

export async function insert(db: Executor, e: NewEvent): Promise<EventRecord> {
  const { rows } = await db.query(
    `INSERT INTO events (title, description, category, department_id, organizer_id, start_at, end_at,
                         expected_attendance, capacity, registration_mode, team_size_min, team_size_max, registration_deadline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [
      e.title,
      e.description,
      e.category,
      e.departmentId,
      e.organizerId,
      e.startAt,
      e.endAt,
      e.expectedAttendance,
      e.capacity,
      e.registrationMode,
      e.teamSizeMin,
      e.teamSizeMax,
      e.registrationDeadline,
    ],
  );
  return map(rows[0]);
}

/** Loads an event; with `forUpdate` the row is locked until the transaction ends (serializes concurrent actions). */
export async function getById(
  db: Executor,
  id: string,
  forUpdate = false,
): Promise<EventRecord | null> {
  const { rows } = await db.query(
    `SELECT * FROM events WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Updates the given columns. Keys are checked against a fixed list, so no caller input reaches the SQL text. */
export async function patch(
  db: Executor,
  id: string,
  changes: Partial<EventColumns>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, value] of Object.entries(changes) as [keyof EventColumns, unknown][]) {
    if (value === undefined) continue;
    const column = COLUMN_NAMES[key];
    if (!column) throw new Error(`Unknown event column "${key}"`);
    if (value === NOW) {
      sets.push(`${column} = now()`);
    } else {
      params.push(key === 'calendarWarnings' ? JSON.stringify(value) : value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (sets.length === 0) return;
  await db.query(`UPDATE events SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
}

export async function getSpeakers(db: Executor, eventId: string): Promise<Speaker[]> {
  const { rows } = await db.query(
    'SELECT name, designation, organization FROM event_speakers WHERE event_id = $1 ORDER BY position',
    [eventId],
  );
  return rows.map((r) => ({
    name: r.name as string,
    designation: (r.designation as string | null) ?? null,
    organization: (r.organization as string | null) ?? null,
  }));
}

export async function replaceSpeakers(
  db: Executor,
  eventId: string,
  speakers: Speaker[],
): Promise<void> {
  await db.query('DELETE FROM event_speakers WHERE event_id = $1', [eventId]);
  for (const [i, s] of speakers.entries()) {
    await db.query(
      'INSERT INTO event_speakers (event_id, position, name, designation, organization) VALUES ($1, $2, $3, $4, $5)',
      [eventId, i, s.name, s.designation, s.organization],
    );
  }
}

export interface HistoryRow {
  id: number;
  action: string;
  actorId: string | null;
  fromStatus: EventStatus | null;
  toStatus: EventStatus | null;
  level: ApprovalLevel | null;
  comment: string | null;
  createdAt: Date;
}

export async function addHistory(
  db: Executor,
  h: {
    eventId: string;
    action: string;
    actorId: string | null;
    fromStatus?: EventStatus | null;
    toStatus?: EventStatus | null;
    level?: ApprovalLevel | null;
    comment?: string | null;
  },
): Promise<void> {
  await db.query(
    'INSERT INTO event_history (event_id, action, actor_id, from_status, to_status, level, comment) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [
      h.eventId,
      h.action,
      h.actorId,
      h.fromStatus ?? null,
      h.toStatus ?? null,
      h.level ?? null,
      h.comment ?? null,
    ],
  );
}

export async function getHistory(db: Executor, eventId: string): Promise<HistoryRow[]> {
  const { rows } = await db.query('SELECT * FROM event_history WHERE event_id = $1 ORDER BY id', [
    eventId,
  ]);
  return rows.map((r) => ({
    id: Number(r.id),
    action: r.action as string,
    actorId: (r.actor_id as string | null) ?? null,
    fromStatus: (r.from_status as EventStatus | null) ?? null,
    toStatus: (r.to_status as EventStatus | null) ?? null,
    level: (r.level as ApprovalLevel | null) ?? null,
    comment: (r.comment as string | null) ?? null,
    createdAt: r.created_at as Date,
  }));
}

export interface ListFilter {
  limit: number;
  offset: number;
  organizerId?: string;
  departmentId?: string;
  statuses?: EventStatus[];
  excludeStatuses?: EventStatus[];
  /** Approval queue: events waiting at one of `levels`, not created by and not yet decided (this round) by `actorId`. */
  queue?: { actorId: string; levels: { level: ApprovalLevel; departmentId: string | null }[] };
  order: 'created_desc' | 'start_asc' | 'start_desc' | 'submitted_asc';
}

const ORDER: Record<ListFilter['order'], string> = {
  created_desc: 'e.created_at DESC, e.id',
  start_asc: 'e.start_at, e.id',
  start_desc: 'e.start_at DESC, e.id',
  submitted_asc: 'e.submitted_at, e.id',
};

export async function list(
  db: Executor,
  f: ListFilter,
): Promise<{ rows: EventRecord[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.organizerId) add('e.organizer_id = ?', f.organizerId);
  if (f.departmentId) add('e.department_id = ?', f.departmentId);
  if (f.statuses?.length) add('e.status = ANY(?::text[])', f.statuses);
  if (f.excludeStatuses?.length) add('NOT (e.status = ANY(?::text[]))', f.excludeStatuses);
  if (f.queue) {
    if (f.queue.levels.length === 0) {
      where.push('false');
    } else {
      params.push(f.queue.actorId);
      const actor = `$${params.length}`;
      const ors = f.queue.levels.map((l) => {
        params.push(l.level);
        const lvl = `$${params.length}`;
        if (l.departmentId === null) return `(e.approval_level = ${lvl})`;
        params.push(l.departmentId);
        return `(e.approval_level = ${lvl} AND e.department_id = $${params.length})`;
      });
      where.push(
        `e.status = 'pending_approval'`,
        `(${ors.join(' OR ')})`,
        `e.organizer_id <> ${actor}`,
      );
      where.push(
        `NOT EXISTS (SELECT 1 FROM event_approvals a WHERE a.event_id = e.id AND a.round = e.submission_round AND a.approver_id = ${actor})`,
      );
    }
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await db.query(`SELECT count(*)::int AS n FROM events e ${clause}`, params);
  const { rows } = await db.query(
    `SELECT e.* FROM events e ${clause} ORDER BY ${ORDER[f.order]} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.limit, f.offset],
  );
  return { rows: rows.map(map), total: count.rows[0].n as number };
}
