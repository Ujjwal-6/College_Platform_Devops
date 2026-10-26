import type { Executor } from '../../platform/db.js';

export const CALENDAR_TYPES = [
  'exam_period',
  'holiday',
  'major_fest',
  'academic_date',
  'other',
] as const;
export type CalendarType = (typeof CALENDAR_TYPES)[number];
export type Severity = 'block' | 'warn';

export interface CalendarEntry {
  id: string;
  type: CalendarType;
  title: string;
  /** Inclusive calendar dates (YYYY-MM-DD) in the application time zone. */
  startDate: string;
  endDate: string;
  severity: Severity;
  departmentId: string | null;
  isActive: boolean;
  createdAt: Date;
}

const COLUMNS = `id, type, title, to_char(start_date, 'YYYY-MM-DD') AS start_date,
  to_char(end_date, 'YYYY-MM-DD') AS end_date, severity, department_id, is_active, created_at`;

function map(r: Record<string, unknown>): CalendarEntry {
  return {
    id: r.id as string,
    type: r.type as CalendarType,
    title: r.title as string,
    startDate: r.start_date as string,
    endDate: r.end_date as string,
    severity: r.severity as Severity,
    departmentId: (r.department_id as string | null) ?? null,
    isActive: r.is_active as boolean,
    createdAt: r.created_at as Date,
  };
}

// A calendar entry covers whole days [start_date 00:00, end_date + 1 day 00:00) in the application
// time zone. Ranges are half-open, so an event ending exactly at an entry's first midnight is allowed.
const ENTRY_RANGE = `tstzrange(start_date::timestamp AT TIME ZONE $TZ, (end_date + 1)::timestamp AT TIME ZONE $TZ, '[)')`;

/** Active entries that overlap [startAt, endAt) and apply to the department. */
export async function findOverlapping(
  db: Executor,
  timezone: string,
  range: { startAt: Date; endAt: Date; departmentId: string | null },
): Promise<CalendarEntry[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM calendar_entries
      WHERE is_active
        AND (department_id IS NULL OR department_id = $4)
        AND ${ENTRY_RANGE.replaceAll('$TZ', '$3')} && tstzrange($1, $2, '[)')
      ORDER BY severity, start_date, id`,
    [range.startAt, range.endAt, timezone, range.departmentId],
  );
  return rows.map(map);
}

export async function list(
  db: Executor,
  f: { from?: string; to?: string; includeInactive: boolean },
): Promise<CalendarEntry[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!f.includeInactive) where.push('is_active');
  if (f.from) {
    params.push(f.from);
    where.push(`end_date >= $${params.length}::date`);
  }
  if (f.to) {
    params.push(f.to);
    where.push(`start_date <= $${params.length}::date`);
  }
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM calendar_entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY start_date, id LIMIT 500`,
    params,
  );
  return rows.map(map);
}

export async function getById(
  db: Executor,
  id: string,
  forUpdate = false,
): Promise<CalendarEntry | null> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM calendar_entries WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

export interface EntryInput {
  type: CalendarType;
  title: string;
  startDate: string;
  endDate: string;
  severity: Severity;
  departmentId: string | null;
  isActive: boolean;
}

export async function insert(
  db: Executor,
  e: EntryInput,
  createdBy: string,
): Promise<CalendarEntry> {
  const { rows } = await db.query(
    `INSERT INTO calendar_entries (type, title, start_date, end_date, severity, department_id, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
    [e.type, e.title, e.startDate, e.endDate, e.severity, e.departmentId, e.isActive, createdBy],
  );
  return map(rows[0]);
}

export async function update(db: Executor, id: string, e: EntryInput): Promise<CalendarEntry> {
  const { rows } = await db.query(
    `UPDATE calendar_entries SET type = $2, title = $3, start_date = $4, end_date = $5, severity = $6,
            department_id = $7, is_active = $8, updated_at = now()
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, e.type, e.title, e.startDate, e.endDate, e.severity, e.departmentId, e.isActive],
  );
  return map(rows[0]);
}

export async function remove(db: Executor, id: string): Promise<void> {
  await db.query('DELETE FROM calendar_entries WHERE id = $1', [id]);
}

export interface ConflictingEvent {
  id: string;
  title: string;
  status: string;
  departmentId: string;
  startAt: Date;
  endAt: Date;
}

/**
 * Read-only report: live events (pending, approved or published) that overlap an entry. Used when an
 * admin adds or changes an entry; existing events are never modified by a calendar change.
 */
export async function findConflictingEvents(
  db: Executor,
  timezone: string,
  entry: CalendarEntry,
): Promise<ConflictingEvent[]> {
  const { rows } = await db.query(
    `SELECT e.id, e.title, e.status, e.department_id, e.start_at, e.end_at
       FROM events e, calendar_entries c
      WHERE c.id = $1
        AND e.status IN ('pending_approval', 'approved', 'published')
        AND (c.department_id IS NULL OR c.department_id = e.department_id)
        AND ${ENTRY_RANGE.replaceAll('$TZ', '$2').replaceAll('start_date', 'c.start_date').replaceAll('end_date', 'c.end_date')} && tstzrange(e.start_at, e.end_at, '[)')
      ORDER BY e.start_at, e.id`,
    [entry.id, timezone],
  );
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    status: r.status as string,
    departmentId: r.department_id as string,
    startAt: r.start_at as Date,
    endAt: r.end_at as Date,
  }));
}
