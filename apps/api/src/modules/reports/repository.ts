import type { Executor } from '../../platform/db.js';

export interface ReportRecord {
  id: string;
  eventId: string;
  version: number;
  reason: 'close' | 'manual';
  status: 'pending' | 'ready' | 'failed';
  storageKey: string | null;
  requestedBy: string | null;
  error: string | null;
  createdAt: Date;
  generatedAt: Date | null;
}

function mapReport(r: Record<string, unknown>): ReportRecord {
  return {
    id: r.id as string,
    eventId: r.event_id as string,
    version: r.version as number,
    reason: r.reason as ReportRecord['reason'],
    status: r.status as ReportRecord['status'],
    storageKey: (r.storage_key as string | null) ?? null,
    requestedBy: (r.requested_by as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as Date,
    generatedAt: (r.generated_at as Date | null) ?? null,
  };
}

/**
 * Starts the next version of an event's report. Call it while holding the event lock (the version
 * number is the highest so far plus one). The automatic report of a close is made once: a second
 * attempt does nothing and returns null. A manual request while one is pending raises a unique
 * violation on `event_reports_one_pending_key`.
 */
export async function insertReport(
  db: Executor,
  v: { eventId: string; reason: 'close' | 'manual'; requestedBy: string | null },
): Promise<ReportRecord | null> {
  const { rows } = await db.query(
    `INSERT INTO event_reports (event_id, version, reason, requested_by)
     VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM event_reports WHERE event_id = $1), $2, $3)
     ON CONFLICT (event_id) WHERE reason = 'close' DO NOTHING
     RETURNING *`,
    [v.eventId, v.reason, v.requestedBy],
  );
  return rows[0] ? mapReport(rows[0]) : null;
}

export async function findReport(db: Executor, id: string): Promise<ReportRecord | null> {
  const { rows } = await db.query('SELECT * FROM event_reports WHERE id = $1', [id]);
  return rows[0] ? mapReport(rows[0]) : null;
}

export async function listReports(db: Executor, eventId: string): Promise<ReportRecord[]> {
  const { rows } = await db.query(
    'SELECT * FROM event_reports WHERE event_id = $1 ORDER BY version DESC',
    [eventId],
  );
  return rows.map(mapReport);
}

/** Only a pending version changes; returns false if another worker finished it first. */
export async function markReady(db: Executor, id: string, storageKey: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE event_reports SET status = 'ready', storage_key = $2, generated_at = now(), error = NULL
      WHERE id = $1 AND status = 'pending'`,
    [id, storageKey],
  );
  return rowCount === 1;
}

export async function markFailed(db: Executor, id: string, error: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE event_reports SET status = 'failed', error = $2 WHERE id = $1 AND status = 'pending'",
    [id, error.slice(0, 500) || 'Unknown error'],
  );
  return rowCount === 1;
}

// ---- what the organizer provides ---------------------------------------------------------------

export async function getOutcomes(db: Executor, eventId: string): Promise<string | null> {
  const { rows } = await db.query('SELECT outcomes FROM event_report_inputs WHERE event_id = $1', [
    eventId,
  ]);
  return (rows[0]?.outcomes as string | null) ?? null;
}

export async function saveOutcomes(
  db: Executor,
  eventId: string,
  outcomes: string | null,
  by: string,
): Promise<void> {
  await db.query(
    `INSERT INTO event_report_inputs (event_id, outcomes, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO UPDATE SET outcomes = $2, updated_by = $3, updated_at = now()`,
    [eventId, outcomes, by],
  );
}

export interface PhotoRecord {
  id: string;
  eventId: string;
  storageKey: string;
  caption: string | null;
  uploadedBy: string;
  createdAt: Date;
}

function mapPhoto(r: Record<string, unknown>): PhotoRecord {
  return {
    id: r.id as string,
    eventId: r.event_id as string,
    storageKey: r.storage_key as string,
    caption: (r.caption as string | null) ?? null,
    uploadedBy: r.uploaded_by as string,
    createdAt: r.created_at as Date,
  };
}

export async function insertPhoto(
  db: Executor,
  v: { eventId: string; storageKey: string; caption: string | null; uploadedBy: string },
): Promise<PhotoRecord> {
  const { rows } = await db.query(
    `INSERT INTO event_photos (event_id, storage_key, caption, uploaded_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [v.eventId, v.storageKey, v.caption, v.uploadedBy],
  );
  return mapPhoto(rows[0]);
}

export async function listPhotos(db: Executor, eventId: string): Promise<PhotoRecord[]> {
  const { rows } = await db.query(
    'SELECT * FROM event_photos WHERE event_id = $1 ORDER BY created_at, id',
    [eventId],
  );
  return rows.map(mapPhoto);
}

export async function findPhoto(db: Executor, id: string): Promise<PhotoRecord | null> {
  const { rows } = await db.query('SELECT * FROM event_photos WHERE id = $1', [id]);
  return rows[0] ? mapPhoto(rows[0]) : null;
}

export async function deletePhoto(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM event_photos WHERE id = $1', [id]);
  return rowCount === 1;
}

export async function countPhotos(db: Executor, eventId: string): Promise<number> {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM event_photos WHERE event_id = $1',
    [eventId],
  );
  return rows[0].n as number;
}
