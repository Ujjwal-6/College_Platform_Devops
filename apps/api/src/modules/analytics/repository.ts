import type { Executor } from '../../platform/db.js';

/**
 * Read-only aggregate queries across the tables of several modules.
 *
 * This is a deliberate exception to "modules never read another module's tables": a summary of every
 * event in a period needs counts per event, and asking each module once per event would be hundreds of
 * queries. Nothing here writes, and anything that is not a plain count or sum is read through the
 * owning module's public interface instead (budget totals, per-event attendance rules).
 */

export interface EventStatsRow {
  id: string;
  title: string;
  status: 'published' | 'closed';
  startAt: Date;
  endAt: Date;
  departmentId: string;
  departmentName: string;
  organizerName: string;
  registered: number;
  checkedIn: number;
  feedbackCount: number;
  /** The sum of the ratings, so averages are exact integer arithmetic until the last division. */
  feedbackTotal: number;
  certificates: number;
}

export const ROW_LIMIT = 500;

export async function eventStats(
  db: Executor,
  q: { from: string; to: string; timezone: string; departmentId?: string; eventId?: string },
): Promise<{ rows: EventStatsRow[]; truncated: boolean }> {
  const params: unknown[] = [q.from, q.timezone, q.to];
  let extra = '';
  if (q.departmentId) {
    params.push(q.departmentId);
    extra += ` AND e.department_id = $${params.length}`;
  }
  if (q.eventId) {
    params.push(q.eventId);
    extra += ` AND e.id = $${params.length}`;
  }
  params.push(ROW_LIMIT + 1);
  const { rows } = await db.query(
    `SELECT e.id, e.title, e.status, e.start_at, e.end_at, e.department_id,
            d.name AS department_name, u.name AS organizer_name,
            coalesce(r.n, 0) AS registered, coalesce(a.n, 0) AS checked_in,
            coalesce(f.n, 0) AS feedback_count, coalesce(f.total, 0) AS feedback_total,
            coalesce(c.n, 0) AS certificates
       FROM events e
       JOIN departments d ON d.id = e.department_id
       JOIN users u ON u.id = e.organizer_id
       LEFT JOIN (SELECT event_id, count(*)::int AS n FROM registrations
                   WHERE status = 'registered' GROUP BY event_id) r ON r.event_id = e.id
       LEFT JOIN (SELECT event_id, count(*)::int AS n FROM attendance GROUP BY event_id) a ON a.event_id = e.id
       LEFT JOIN (SELECT event_id, count(*)::int AS n, sum(rating)::int AS total FROM feedback
                   GROUP BY event_id) f ON f.event_id = e.id
       LEFT JOIN (SELECT event_id, count(*)::int AS n FROM certificates
                   WHERE revoked_at IS NULL GROUP BY event_id) c ON c.event_id = e.id
      WHERE e.status IN ('published', 'closed')
        AND e.start_at >= ($1::date)::timestamp AT TIME ZONE $2
        AND e.start_at < (($3::date + 1))::timestamp AT TIME ZONE $2${extra}
      ORDER BY e.start_at DESC, e.id
      LIMIT $${params.length}`,
    params,
  );
  const truncated = rows.length > ROW_LIMIT;
  return {
    truncated,
    rows: rows.slice(0, ROW_LIMIT).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      status: r.status as EventStatsRow['status'],
      startAt: r.start_at as Date,
      endAt: r.end_at as Date,
      departmentId: r.department_id as string,
      departmentName: r.department_name as string,
      organizerName: r.organizer_name as string,
      registered: r.registered as number,
      checkedIn: r.checked_in as number,
      feedbackCount: r.feedback_count as number,
      feedbackTotal: r.feedback_total as number,
      certificates: r.certificates as number,
    })),
  };
}

/** Registrations made on each local day (people who are registered now), for events in scope. */
export async function registrationsPerDay(
  db: Executor,
  q: { from: string; to: string; timezone: string; departmentId?: string; eventId?: string },
): Promise<Map<string, number>> {
  const params: unknown[] = [q.timezone];
  let where = "r.status = 'registered' AND e.status IN ('published', 'closed')";
  if (q.eventId) {
    params.push(q.eventId);
    where += ` AND e.id = $${params.length}`;
  } else {
    params.push(q.from, q.to);
    where += ` AND r.registered_at >= ($${params.length - 1}::date)::timestamp AT TIME ZONE $1
               AND r.registered_at < (($${params.length}::date + 1))::timestamp AT TIME ZONE $1`;
  }
  if (q.departmentId) {
    params.push(q.departmentId);
    where += ` AND e.department_id = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT ((r.registered_at AT TIME ZONE $1)::date)::text AS day, count(*)::int AS n
       FROM registrations r JOIN events e ON e.id = r.event_id
      WHERE ${where} GROUP BY day ORDER BY day`,
    params,
  );
  return new Map(rows.map((r) => [r.day as string, r.n as number]));
}

export interface HallUsageRow {
  id: string;
  name: string;
  capacity: number;
  bookings: number;
  bookedHours: number;
}

/** Operating hours of a hall, used to say how much of its day was booked (an assumption, see the design doc). */
export const OPERATING_START = '08:00';
export const OPERATING_END = '20:00';
export const OPERATING_HOURS_PER_DAY = 12;

/**
 * Confirmed booked time inside each day's operating window, for every active hall. A booking is clipped
 * to the window, so the hours can never exceed the window and the share can never pass 100%.
 */
export async function hallUsage(
  db: Executor,
  q: { from: string; to: string; timezone: string },
): Promise<HallUsageRow[]> {
  const { rows } = await db.query(
    `WITH days AS (
       SELECT d::date AS day FROM generate_series($1::date, $2::date, interval '1 day') AS d
     ), windows AS (
       SELECT (day + time '${OPERATING_START}') AT TIME ZONE $3 AS ws,
              (day + time '${OPERATING_END}') AT TIME ZONE $3 AS we
         FROM days
     )
     SELECT h.id, h.name, h.capacity,
            count(DISTINCT b.id)::int AS bookings,
            coalesce(sum(extract(epoch FROM (least(b.end_at, w.we) - greatest(b.start_at, w.ws)))) FILTER (WHERE b.id IS NOT NULL), 0) / 3600.0 AS hours
       FROM halls h
       CROSS JOIN windows w
       LEFT JOIN hall_bookings b
              ON b.hall_id = h.id AND b.status = 'confirmed'
             AND b.start_at < w.we AND b.end_at > w.ws
      WHERE h.is_active
      GROUP BY h.id, h.name, h.capacity
      ORDER BY lower(h.name), h.id`,
    [q.from, q.to, q.timezone],
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    capacity: r.capacity as number,
    bookings: r.bookings as number,
    bookedHours: Math.round(Number(r.hours) * 100) / 100,
  }));
}
