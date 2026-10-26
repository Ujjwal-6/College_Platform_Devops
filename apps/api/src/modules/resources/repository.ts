import type { Executor } from '../../platform/db.js';

export const RESOURCE_STATUSES = ['available', 'maintenance', 'retired'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export interface Resource {
  id: string;
  name: string;
  category: string;
  quantity: number;
  description: string;
  status: ResourceStatus;
  createdAt: Date;
}

const mapResource = (r: Record<string, unknown>): Resource => ({
  id: r.id as string,
  name: r.name as string,
  category: r.category as string,
  quantity: r.quantity as number,
  description: r.description as string,
  status: r.status as ResourceStatus,
  createdAt: r.created_at as Date,
});

export interface ResourceInput {
  name: string;
  category: string;
  quantity: number;
  description: string;
  status: ResourceStatus;
}

export async function insertResource(db: Executor, r: ResourceInput): Promise<Resource> {
  const { rows } = await db.query(
    'INSERT INTO resources (name, category, quantity, description, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [r.name, r.category, r.quantity, r.description, r.status],
  );
  return mapResource(rows[0]);
}

export async function updateResource(
  db: Executor,
  id: string,
  r: ResourceInput,
): Promise<Resource> {
  const { rows } = await db.query(
    'UPDATE resources SET name = $2, category = $3, quantity = $4, description = $5, status = $6, updated_at = now() WHERE id = $1 RETURNING *',
    [id, r.name, r.category, r.quantity, r.description, r.status],
  );
  return mapResource(rows[0]);
}

/**
 * With `forUpdate` the resource row is locked until the transaction ends. Every change to a
 * resource's reservations takes this lock first, which serializes concurrent requests for the
 * same resource and makes the quantity check below race-free.
 */
export async function getResource(
  db: Executor,
  id: string,
  forUpdate = false,
): Promise<Resource | null> {
  const { rows } = await db.query(
    `SELECT * FROM resources WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? mapResource(rows[0]) : null;
}

export async function listResources(
  db: Executor,
  f: { includeRetired: boolean },
): Promise<Resource[]> {
  const { rows } = await db.query(
    `SELECT * FROM resources ${f.includeRetired ? '' : "WHERE status <> 'retired'"} ORDER BY category, lower(name), id`,
  );
  return rows.map(mapResource);
}

/**
 * The most units in use at any single instant inside [startAt, endAt) by confirmed reservations
 * (`endAt = null` means "forever"). Usage only rises where a reservation starts, so it is enough to
 * look at the window's start and at every start inside it. A plain sum of all overlapping
 * reservations would wrongly reject requests that fit between two back-to-back reservations.
 */
export async function peakUsage(
  db: Executor,
  resourceId: string,
  startAt: Date,
  endAt: Date | null,
  excludeReservationId?: string,
): Promise<number> {
  const { rows } = await db.query(
    `WITH overlapping AS (
       SELECT start_at, end_at, quantity FROM resource_reservations
        WHERE resource_id = $1 AND status = 'confirmed'
          AND tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, COALESCE($3::timestamptz, 'infinity'::timestamptz), '[)')
          AND ($4::uuid IS NULL OR id <> $4)
     ), points AS (
       SELECT $2::timestamptz AS p
       UNION
       SELECT start_at FROM overlapping WHERE start_at > $2::timestamptz
     )
     SELECT COALESCE(MAX(used), 0)::int AS peak FROM (
       SELECT (SELECT COALESCE(SUM(o.quantity), 0) FROM overlapping o WHERE o.start_at <= pt.p AND o.end_at > pt.p) AS used
         FROM points pt
     ) u`,
    [resourceId, startAt, endAt, excludeReservationId ?? null],
  );
  return rows[0].peak as number;
}

// ---- reservations ------------------------------------------------------------------------------

export interface Reservation {
  id: string;
  resourceId: string;
  eventId: string;
  requestedBy: string;
  quantity: number;
  startAt: Date;
  endAt: Date;
  notes: string;
  status: 'confirmed' | 'released';
  releaseReason: string | null;
  releasedAt: Date | null;
  createdAt: Date;
}

const mapReservation = (r: Record<string, unknown>): Reservation => ({
  id: r.id as string,
  resourceId: r.resource_id as string,
  eventId: r.event_id as string,
  requestedBy: r.requested_by as string,
  quantity: r.quantity as number,
  startAt: r.start_at as Date,
  endAt: r.end_at as Date,
  notes: r.notes as string,
  status: r.status as Reservation['status'],
  releaseReason: (r.release_reason as string | null) ?? null,
  releasedAt: (r.released_at as Date | null) ?? null,
  createdAt: r.created_at as Date,
});

export async function insertReservation(
  db: Executor,
  r: {
    resourceId: string;
    eventId: string;
    requestedBy: string;
    quantity: number;
    startAt: Date;
    endAt: Date;
    notes: string;
  },
): Promise<Reservation> {
  const { rows } = await db.query(
    `INSERT INTO resource_reservations (resource_id, event_id, requested_by, quantity, start_at, end_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [r.resourceId, r.eventId, r.requestedBy, r.quantity, r.startAt, r.endAt, r.notes],
  );
  return mapReservation(rows[0]);
}

export async function getReservation(
  db: Executor,
  id: string,
  forUpdate = false,
): Promise<Reservation | null> {
  const { rows } = await db.query(
    `SELECT * FROM resource_reservations WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? mapReservation(rows[0]) : null;
}

export async function findSameConfirmed(
  db: Executor,
  q: {
    resourceId: string;
    eventId: string;
    requestedBy: string;
    quantity: number;
    startAt: Date;
    endAt: Date;
  },
): Promise<Reservation | null> {
  const { rows } = await db.query(
    `SELECT * FROM resource_reservations
      WHERE resource_id = $1 AND event_id = $2 AND requested_by = $3 AND quantity = $4 AND start_at = $5 AND end_at = $6
        AND status = 'confirmed' LIMIT 1`,
    [q.resourceId, q.eventId, q.requestedBy, q.quantity, q.startAt, q.endAt],
  );
  return rows[0] ? mapReservation(rows[0]) : null;
}

export async function updateReservation(
  db: Executor,
  id: string,
  r: { quantity: number; startAt: Date; endAt: Date; notes: string },
): Promise<void> {
  await db.query(
    'UPDATE resource_reservations SET quantity = $2, start_at = $3, end_at = $4, notes = $5, updated_at = now() WHERE id = $1',
    [id, r.quantity, r.startAt, r.endAt, r.notes],
  );
}

export async function releaseReservation(db: Executor, id: string, reason: string): Promise<void> {
  await db.query(
    "UPDATE resource_reservations SET status = 'released', release_reason = $2, released_at = now(), updated_at = now() WHERE id = $1 AND status = 'confirmed'",
    [id, reason],
  );
}

export async function listForEvent(
  db: Executor,
  eventId: string,
): Promise<(Reservation & { resourceName: string; resourceCategory: string })[]> {
  const { rows } = await db.query(
    `SELECT r.*, s.name AS resource_name, s.category AS resource_category
       FROM resource_reservations r JOIN resources s ON s.id = r.resource_id
      WHERE r.event_id = $1 ORDER BY r.created_at, r.id`,
    [eventId],
  );
  return rows.map((r) => ({
    ...mapReservation(r),
    resourceName: r.resource_name as string,
    resourceCategory: r.resource_category as string,
  }));
}

/** Confirmed reservations of an event, locked, for release when the event is cancelled or revised. */
export async function confirmedForEvent(db: Executor, eventId: string): Promise<Reservation[]> {
  const { rows } = await db.query(
    "SELECT * FROM resource_reservations WHERE event_id = $1 AND status = 'confirmed' ORDER BY resource_id, id FOR UPDATE",
    [eventId],
  );
  return rows.map(mapReservation);
}
