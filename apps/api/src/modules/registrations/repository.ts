import type { Executor } from '../../platform/db.js';
import type { CancelReason, RegistrationRecord, RegistrationStatus, TeamRecord } from './types.js';

function mapRegistration(r: Record<string, unknown>): RegistrationRecord {
  return {
    id: r.id as string,
    eventId: r.event_id as string,
    userId: r.user_id as string,
    teamId: (r.team_id as string | null) ?? null,
    status: r.status as RegistrationStatus,
    cancelReason: (r.cancel_reason as CancelReason | null) ?? null,
    registeredAt: r.registered_at as Date,
    waitlistedAt: (r.waitlisted_at as Date | null) ?? null,
    cancelledAt: (r.cancelled_at as Date | null) ?? null,
  };
}

function mapTeam(r: Record<string, unknown>): TeamRecord {
  return {
    id: r.id as string,
    eventId: r.event_id as string,
    name: r.name as string,
    leaderId: r.leader_id as string,
    status: r.status as TeamRecord['status'],
    invitationHash: (r.invitation_hash as string | null) ?? null,
    invitationExpiresAt: (r.invitation_expires_at as Date | null) ?? null,
  };
}

export async function countRegistered(db: Executor, eventId: string): Promise<number> {
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM registrations WHERE event_id = $1 AND status = 'registered'",
    [eventId],
  );
  return rows[0].n as number;
}

export async function findById(
  db: Executor,
  id: string,
  forUpdate = false,
): Promise<RegistrationRecord | null> {
  const { rows } = await db.query(
    `SELECT * FROM registrations WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? mapRegistration(rows[0]) : null;
}

export async function findByEventUser(
  db: Executor,
  eventId: string,
  userId: string,
): Promise<RegistrationRecord | null> {
  const { rows } = await db.query(
    'SELECT * FROM registrations WHERE event_id = $1 AND user_id = $2',
    [eventId, userId],
  );
  return rows[0] ? mapRegistration(rows[0]) : null;
}

export async function insertRegistration(
  db: Executor,
  v: { eventId: string; userId: string; teamId: string | null },
): Promise<RegistrationRecord> {
  const { rows } = await db.query(
    'INSERT INTO registrations (event_id, user_id, team_id) VALUES ($1, $2, $3) RETURNING *',
    [v.eventId, v.userId, v.teamId],
  );
  return mapRegistration(rows[0]);
}

/** Registering again after cancelling reuses the row (one row per person per event, by constraint). */
export async function reactivate(
  db: Executor,
  id: string,
  teamId: string | null,
  status: 'registered' | 'waitlisted' = 'registered',
): Promise<RegistrationRecord> {
  const { rows } = await db.query(
    `UPDATE registrations SET status = $3, team_id = $2, cancel_reason = NULL, cancelled_at = NULL,
            registered_at = now(),
            waitlisted_at = CASE WHEN $3 = 'waitlisted' THEN clock_timestamp() ELSE NULL END,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, teamId, status],
  );
  return mapRegistration(rows[0]);
}

/** Puts a person at the back of the queue. clock_timestamp() is the real insertion moment, not the transaction start. */
export async function addToWaitlist(
  db: Executor,
  v: { eventId: string; userId: string },
): Promise<RegistrationRecord> {
  const { rows } = await db.query(
    `INSERT INTO registrations (event_id, user_id, status, waitlisted_at)
     VALUES ($1, $2, 'waitlisted', clock_timestamp()) RETURNING *`,
    [v.eventId, v.userId],
  );
  return mapRegistration(rows[0]);
}

export async function firstWaitlisted(
  db: Executor,
  eventId: string,
): Promise<RegistrationRecord | null> {
  const { rows } = await db.query(
    `SELECT * FROM registrations WHERE event_id = $1 AND status = 'waitlisted'
      ORDER BY waitlisted_at, id LIMIT 1`,
    [eventId],
  );
  return rows[0] ? mapRegistration(rows[0]) : null;
}

/** Gives a waiting person the seat. The waitlisted_at value is kept as a record of when they queued. */
export async function promote(db: Executor, id: string): Promise<RegistrationRecord> {
  const { rows } = await db.query(
    `UPDATE registrations SET status = 'registered', registered_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'waitlisted' RETURNING *`,
    [id],
  );
  return mapRegistration(rows[0]);
}

export async function countWaitlisted(db: Executor, eventId: string): Promise<number> {
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM registrations WHERE event_id = $1 AND status = 'waitlisted'",
    [eventId],
  );
  return rows[0].n as number;
}

/** Queue positions (1 = next in line) of everyone waiting for an event. */
export async function waitlistPositions(
  db: Executor,
  eventId: string,
): Promise<Map<string, number>> {
  const { rows } = await db.query(
    `SELECT id, row_number() OVER (ORDER BY waitlisted_at, id)::int AS position
       FROM registrations WHERE event_id = $1 AND status = 'waitlisted'`,
    [eventId],
  );
  return new Map(rows.map((r) => [r.id as string, r.position as number]));
}

export async function markCancelled(
  db: Executor,
  id: string,
  reason: CancelReason,
): Promise<RegistrationRecord> {
  const { rows } = await db.query(
    `UPDATE registrations SET status = 'cancelled', cancel_reason = $2, cancelled_at = now(),
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, reason],
  );
  return mapRegistration(rows[0]);
}

export async function cancelAllForEvent(
  db: Executor,
  eventId: string,
  reason: CancelReason,
): Promise<RegistrationRecord[]> {
  const { rows } = await db.query(
    `UPDATE registrations SET status = 'cancelled', cancel_reason = $2, cancelled_at = now(),
            updated_at = now()
      WHERE event_id = $1 AND status IN ('registered', 'waitlisted') RETURNING *`,
    [eventId, reason],
  );
  return rows.map(mapRegistration);
}

export async function listForUser(db: Executor, userId: string): Promise<RegistrationRecord[]> {
  const { rows } = await db.query(
    'SELECT * FROM registrations WHERE user_id = $1 ORDER BY registered_at DESC, id',
    [userId],
  );
  return rows.map(mapRegistration);
}

export async function listForEvent(
  db: Executor,
  eventId: string,
  opts: { status?: RegistrationStatus; limit: number; offset: number },
): Promise<{ rows: RegistrationRecord[]; total: number }> {
  const params: unknown[] = [eventId];
  let where = 'event_id = $1';
  if (opts.status) {
    params.push(opts.status);
    where += ` AND status = $${params.length}`;
  }
  const total = await db.query(
    `SELECT count(*)::int AS n FROM registrations WHERE ${where}`,
    params,
  );
  const { rows } = await db.query(
    `SELECT * FROM registrations WHERE ${where}
      ORDER BY registered_at, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, opts.offset],
  );
  return { total: total.rows[0].n as number, rows: rows.map(mapRegistration) };
}

export async function registeredUserIds(db: Executor, eventId: string): Promise<string[]> {
  const { rows } = await db.query(
    "SELECT user_id FROM registrations WHERE event_id = $1 AND status = 'registered' ORDER BY registered_at, id",
    [eventId],
  );
  return rows.map((r) => r.user_id as string);
}

// ---- teams -------------------------------------------------------------------------------------

export async function insertTeam(
  db: Executor,
  v: {
    eventId: string;
    name: string;
    leaderId: string;
    invitationHash: string;
    invitationExpiresAt: Date;
  },
): Promise<TeamRecord> {
  const { rows } = await db.query(
    `INSERT INTO teams (event_id, name, leader_id, invitation_hash, invitation_expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [v.eventId, v.name, v.leaderId, v.invitationHash, v.invitationExpiresAt],
  );
  return mapTeam(rows[0]);
}

export async function findTeam(
  db: Executor,
  id: string,
  forUpdate = false,
): Promise<TeamRecord | null> {
  const { rows } = await db.query(
    `SELECT * FROM teams WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? mapTeam(rows[0]) : null;
}

export async function findTeamByInvitationHash(
  db: Executor,
  hash: string,
): Promise<TeamRecord | null> {
  const { rows } = await db.query('SELECT * FROM teams WHERE invitation_hash = $1', [hash]);
  return rows[0] ? mapTeam(rows[0]) : null;
}

export async function setInvitation(
  db: Executor,
  teamId: string,
  hash: string | null,
  expiresAt: Date | null,
): Promise<void> {
  await db.query(
    'UPDATE teams SET invitation_hash = $2, invitation_expires_at = $3, updated_at = now() WHERE id = $1',
    [teamId, hash, expiresAt],
  );
}

export async function activeMembers(db: Executor, teamId: string): Promise<RegistrationRecord[]> {
  const { rows } = await db.query(
    "SELECT * FROM registrations WHERE team_id = $1 AND status = 'registered' ORDER BY registered_at, id",
    [teamId],
  );
  return rows.map(mapRegistration);
}

export async function countActiveMembers(db: Executor, teamId: string): Promise<number> {
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM registrations WHERE team_id = $1 AND status = 'registered'",
    [teamId],
  );
  return rows[0].n as number;
}

export async function setLeader(db: Executor, teamId: string, leaderId: string): Promise<void> {
  await db.query('UPDATE teams SET leader_id = $2, updated_at = now() WHERE id = $1', [
    teamId,
    leaderId,
  ]);
}

export async function dissolveTeam(db: Executor, teamId: string): Promise<void> {
  await db.query(
    `UPDATE teams SET status = 'dissolved', invitation_hash = NULL, invitation_expires_at = NULL,
            updated_at = now() WHERE id = $1`,
    [teamId],
  );
}

export async function dissolveTeamsForEvent(db: Executor, eventId: string): Promise<void> {
  await db.query(
    `UPDATE teams SET status = 'dissolved', invitation_hash = NULL, invitation_expires_at = NULL,
            updated_at = now() WHERE event_id = $1 AND status = 'active'`,
    [eventId],
  );
}

export async function teamsByIds(db: Executor, ids: string[]): Promise<Map<string, TeamRecord>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query('SELECT * FROM teams WHERE id = ANY($1::uuid[])', [ids]);
  return new Map(rows.map((r) => [r.id as string, mapTeam(r)]));
}
