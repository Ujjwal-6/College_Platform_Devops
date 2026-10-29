import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isUniqueViolation, retryTx, withTx, type Executor } from '../../platform/db.js';
import { AppError, errors } from '../../platform/errors.js';
import { withIdempotency, type StoredResponse } from '../../platform/idempotency.js';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import type { AuthUser } from '../auth/types.js';
import {
  canView,
  canViewWorkflow,
  getEventById,
  isEligibleForRegistration,
  type EventRecord,
} from '../events/index.js';
import { notify } from '../notifications/notify.js';
import { enqueue } from '../../platform/jobs/queue.js';
import { runCancelGuards } from './guards.js';
import { GATE_PASS_JOB } from './jobs.js';
import * as usersRepo from '../users/repository.js';
import { generateInvitationCode, hashInvitationCode, normalizeInvitationCode } from './codes.js';
import * as repo from './repository.js';
import type { RegistrationRecord, TeamRecord } from './types.js';

/** An invitation code works for a week, or until registration closes if that comes first (assumption R-6). */
const INVITATION_TTL_MS = 7 * 86_400_000;

export const createTeamSchema = z.object({ name: z.string().trim().min(2).max(60) }).strict();
/** `waitlist: true` asks for a place in the queue when the event is full (individual events only). */
export const registerSchema = z.object({ waitlist: z.boolean().default(false) }).strict();
export const joinSchema = z.object({ code: z.string().trim().min(1).max(64) }).strict();
export const listQuerySchema = z
  .object({
    status: z.enum(['registered', 'waitlisted', 'cancelled']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

type Idem = { key: string | undefined; fingerprint: string };

const eventUrl = (ctx: AppContext, id: string) => `${ctx.config.WEB_BASE_URL}/events/${id}`;

function formatWhen(ctx: AppContext, start: Date, end: Date): string {
  const f = new Intl.DateTimeFormat('en-IN', {
    timeZone: ctx.config.APP_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${f.format(start)} to ${f.format(end)}`;
}

/** One answer for wrong, expired, revoked and malformed codes, so a guess reveals nothing. */
const invalidInvitation = () =>
  new AppError(404, 'INVALID_INVITATION', 'This invitation code is invalid or has expired');

// ---- shapes returned to clients ----------------------------------------------------------------

export interface RegistrationView {
  id: string;
  eventId: string;
  status: RegistrationRecord['status'];
  cancelReason: RegistrationRecord['cancelReason'];
  registeredAt: string;
  cancelledAt: string | null;
  /** 1 = next in line; null unless the person is waiting. */
  waitlistPosition: number | null;
  team: { id: string; name: string; isLeader: boolean; status: TeamRecord['status'] } | null;
}

function toView(
  reg: RegistrationRecord,
  team: TeamRecord | null | undefined,
  waitlistPosition: number | null = null,
): RegistrationView {
  return {
    id: reg.id,
    eventId: reg.eventId,
    status: reg.status,
    cancelReason: reg.cancelReason,
    registeredAt: reg.registeredAt.toISOString(),
    cancelledAt: reg.cancelledAt?.toISOString() ?? null,
    waitlistPosition: reg.status === 'waitlisted' ? waitlistPosition : null,
    team: team
      ? {
          id: team.id,
          name: team.name,
          isLeader: team.leaderId === reg.userId,
          status: team.status,
        }
      : null,
  };
}

async function viewOf(db: Executor, reg: RegistrationRecord): Promise<RegistrationView> {
  const position =
    reg.status === 'waitlisted'
      ? ((await repo.waitlistPositions(db, reg.eventId)).get(reg.id) ?? null)
      : null;
  return toView(reg, reg.teamId ? await repo.findTeam(db, reg.teamId) : null, position);
}

// ---- guards ------------------------------------------------------------------------------------

/**
 * Loads the event and locks its row until the transaction ends. Event actions (publish, cancel, ...)
 * take the same lock first, so seats and team sizes are only counted while nothing else can change
 * the event or the registrations under it. Always lock the event before anything else.
 */
async function loadVisibleEvent(
  db: Executor,
  user: AuthUser,
  eventId: string,
  lock = false,
): Promise<EventRecord> {
  const event = await getEventById(db, eventId, lock);
  if (!event || !canView(user, event)) throw errors.notFound('Event');
  return event;
}

function assertOpen(event: EventRecord): void {
  if (!isEligibleForRegistration(event)) {
    throw errors.conflict('REGISTRATION_CLOSED', 'Registration is not open for this event');
  }
}

function assertMode(event: EventRecord, mode: 'individual' | 'team'): void {
  if (event.registrationMode === mode) return;
  throw errors.conflict(
    'WRONG_REGISTRATION_MODE',
    mode === 'individual'
      ? 'This is a team event: create a team or join one with an invitation code'
      : 'This is an individual event: register directly',
  );
}

const alreadyRegistered = (existing: RegistrationRecord | null) =>
  errors.conflict(
    'ALREADY_REGISTERED',
    existing?.status === 'waitlisted'
      ? 'You are already on the waitlist for this event'
      : 'You are already registered for this event',
  );

async function isFull(db: Executor, event: EventRecord): Promise<boolean> {
  return event.capacity !== null && (await repo.countRegistered(db, event.id)) >= event.capacity;
}

async function assertSeatFree(db: Executor, event: EventRecord): Promise<void> {
  if (event.capacity === null) return;
  if ((await repo.countRegistered(db, event.id)) >= event.capacity) {
    throw errors.conflict('EVENT_FULL', 'This event is full');
  }
}

/** Gives `user` a seat. The caller already holds the event lock, so the capacity check cannot race. */
async function takeSeat(
  db: Executor,
  event: EventRecord,
  userId: string,
  teamId: string | null,
  opts: { ignoreCapacity?: boolean } = {},
): Promise<RegistrationRecord> {
  const existing = await repo.findByEventUser(db, event.id, userId);
  if (existing && existing.status !== 'cancelled') {
    throw alreadyRegistered(existing);
  }
  if (!opts.ignoreCapacity) await assertSeatFree(db, event);
  if (existing) return repo.reactivate(db, existing.id, teamId);
  try {
    return await repo.insertRegistration(db, { eventId: event.id, userId, teamId });
  } catch (err) {
    // The unique constraint is the last guard; the lock normally makes this unreachable.
    if (isUniqueViolation(err, 'registrations_event_user_key')) {
      throw alreadyRegistered(null);
    }
    throw err;
  }
}

function newInvitation(event: EventRecord): { code: string; hash: string; expiresAt: Date } {
  const code = generateInvitationCode();
  const limit = (event.registrationDeadline ?? event.startAt).getTime();
  return {
    code,
    hash: hashInvitationCode(normalizeInvitationCode(code)!),
    expiresAt: new Date(Math.min(Date.now() + INVITATION_TTL_MS, limit)),
  };
}

async function notifyConfirmed(
  ctx: AppContext,
  tx: Executor,
  user: Pick<AuthUser, 'email' | 'name'>,
  event: EventRecord,
  reg: RegistrationRecord,
  teamName: string,
): Promise<void> {
  await notify(tx, {
    type: 'registration.confirmed',
    to: user.email,
    data: {
      name: user.name,
      eventTitle: event.title,
      when: formatWhen(ctx, event.startAt, event.endAt),
      teamName,
      url: eventUrl(ctx, event.id),
    },
    // A new key per registration period, so registering again after cancelling emails again.
    key: `registration:${reg.id}:confirmed:${reg.registeredAt.getTime()}`,
  });
  await queueGatePass(tx, reg.id);
}

/** Asks the worker for the registration's gate pass (once per registration: the key is the registration). */
async function queueGatePass(tx: Executor, registrationId: string): Promise<void> {
  await enqueue(tx, {
    type: GATE_PASS_JOB,
    payload: { registrationId },
    key: `gate-pass:${registrationId}`,
  });
}

const run = <T>(ctx: AppContext, fn: (tx: PoolClient) => Promise<T>) =>
  retryTx(() => withTx(ctx.pool, fn));

// ---- individual registration ---------------------------------------------------------------------

export async function registerIndividual(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  input: z.infer<typeof registerSchema>,
  idem: Idem,
  meta: RequestMeta,
): Promise<StoredResponse & { replayed: boolean }> {
  return run(ctx, (tx) =>
    withIdempotency(tx, { userId: user.id, ...idem }, async () => {
      const event = await loadVisibleEvent(tx, user, eventId, true);
      assertOpen(event);
      assertMode(event, 'individual');

      if (input.waitlist && (await isFull(tx, event))) {
        const existing = await repo.findByEventUser(tx, eventId, user.id);
        if (existing && existing.status !== 'cancelled') throw alreadyRegistered(existing);
        const waiting = existing
          ? await repo.reactivate(tx, existing.id, null, 'waitlisted')
          : await repo.addToWaitlist(tx, { eventId, userId: user.id });
        await recordAudit(tx, {
          actorId: user.id,
          action: 'registration.waitlisted',
          targetType: 'registration',
          targetId: waiting.id,
          metadata: { eventId },
          ...meta,
        });
        return { status: 201, body: { data: await viewOf(tx, waiting) } };
      }

      // Not full (or no waitlist asked for): a normal registration, which refuses with EVENT_FULL when full.
      const reg = await takeSeat(tx, event, user.id, null);
      await recordAudit(tx, {
        actorId: user.id,
        action: 'registration.created',
        targetType: 'registration',
        targetId: reg.id,
        metadata: { eventId },
        ...meta,
      });
      await notifyConfirmed(ctx, tx, user, event, reg, '');
      return { status: 201, body: { data: await viewOf(tx, reg) } };
    }),
  );
}

/**
 * Gives freed seats to the people waiting, in queue order. Runs inside the transaction that freed the
 * seat and under the event lock, so a seat is never visible as free while someone is waiting. Nobody
 * is promoted once registration has closed (deadline passed): the seat then stays empty.
 */
async function promoteFromWaitlist(
  ctx: AppContext,
  tx: Executor,
  event: EventRecord,
): Promise<void> {
  if (event.capacity === null || !isEligibleForRegistration(event)) return;
  let taken = await repo.countRegistered(tx, event.id);
  while (taken < event.capacity) {
    const next = await repo.firstWaitlisted(tx, event.id);
    if (!next) return;
    const promoted = await repo.promote(tx, next.id);
    taken++;
    await recordAudit(tx, {
      action: 'registration.promoted',
      targetType: 'registration',
      targetId: promoted.id,
      metadata: { eventId: event.id, trigger: 'seat_freed' },
    });
    const [person] = await usersRepo.getContacts(tx, [promoted.userId]);
    if (person) {
      await notify(tx, {
        type: 'registration.promoted',
        to: person.email,
        data: {
          name: person.name,
          eventTitle: event.title,
          when: formatWhen(ctx, event.startAt, event.endAt),
          url: eventUrl(ctx, event.id),
        },
        key: `registration:${promoted.id}:promoted:${promoted.registeredAt.getTime()}`,
      });
    }
    await queueGatePass(tx, promoted.id);
  }
}

/**
 * Registers a person on the spot at the gate (a walk-in the organizer allowed). The caller holds the
 * event lock and has already checked the permission and the check-in window. Unlike a normal
 * registration it ignores the registration deadline, but the event must be published and individual.
 * It needs a free seat unless the organizer allowed walk-ins beyond the capacity (`overCapacity`).
 */
export async function registerWalkIn(
  tx: Executor,
  event: EventRecord,
  userId: string,
  actorId: string,
  meta: RequestMeta,
  opts: { overCapacity?: boolean } = {},
): Promise<RegistrationRecord> {
  if (event.status !== 'published') {
    throw errors.conflict('REGISTRATION_CLOSED', 'Registration is not open for this event');
  }
  if (event.registrationMode !== 'individual') {
    throw errors.conflict(
      'WALK_IN_NOT_AVAILABLE',
      'Walk-ins are only possible for individual events',
    );
  }
  const reg = await takeSeat(tx, event, userId, null, { ignoreCapacity: opts.overCapacity });
  await recordAudit(tx, {
    actorId,
    action: 'registration.created',
    targetType: 'registration',
    targetId: reg.id,
    metadata: {
      eventId: event.id,
      walkIn: true,
      registeredUserId: userId,
      ...(opts.overCapacity ? { overCapacityAllowed: true } : {}),
    },
    ...meta,
  });
  return reg;
}

// ---- teams ---------------------------------------------------------------------------------------

export async function createTeam(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  input: z.infer<typeof createTeamSchema>,
  idem: Idem,
  meta: RequestMeta,
): Promise<StoredResponse & { replayed: boolean }> {
  return run(ctx, (tx) =>
    withIdempotency(tx, { userId: user.id, ...idem }, async () => {
      const event = await loadVisibleEvent(tx, user, eventId, true);
      assertOpen(event);
      assertMode(event, 'team');
      const existing = await repo.findByEventUser(tx, eventId, user.id);
      if (existing && existing.status !== 'cancelled') throw alreadyRegistered(existing);
      await assertSeatFree(tx, event);

      const invitation = newInvitation(event);
      let team: TeamRecord;
      try {
        team = await repo.insertTeam(tx, {
          eventId,
          name: input.name,
          leaderId: user.id,
          invitationHash: invitation.hash,
          invitationExpiresAt: invitation.expiresAt,
        });
      } catch (err) {
        if (isUniqueViolation(err, 'teams_event_name_key')) {
          throw errors.conflict(
            'TEAM_NAME_TAKEN',
            'Another team in this event already uses that name',
          );
        }
        throw err;
      }
      const reg = await takeSeat(tx, event, user.id, team.id);
      await recordAudit(tx, {
        actorId: user.id,
        action: 'team.created',
        targetType: 'team',
        targetId: team.id,
        metadata: { eventId },
        ...meta,
      });
      await recordAudit(tx, {
        actorId: user.id,
        action: 'registration.created',
        targetType: 'registration',
        targetId: reg.id,
        metadata: { eventId, teamId: team.id },
        ...meta,
      });
      await notifyConfirmed(ctx, tx, user, event, reg, team.name);
      return {
        status: 201,
        body: {
          data: {
            registration: toView(reg, team),
            team: await teamView(tx, user, event, team, true),
            // Shown this once; only a hash is kept. The leader can generate a new one later.
            invitationCode: invitation.code,
            invitationExpiresAt: invitation.expiresAt.toISOString(),
          },
        },
      };
    }),
  );
}

export async function joinTeam(
  ctx: AppContext,
  user: AuthUser,
  code: string,
  idem: Idem,
  meta: RequestMeta,
): Promise<StoredResponse & { replayed: boolean }> {
  const normalized = normalizeInvitationCode(code);
  if (!normalized) throw invalidInvitation();
  const hash = hashInvitationCode(normalized);

  return run(ctx, (tx) =>
    withIdempotency(tx, { userId: user.id, ...idem }, async () => {
      // Find the event first (no lock yet), then lock it and read the team again under the lock, so a
      // code revoked a moment ago is not honoured.
      const found = await repo.findTeamByInvitationHash(tx, hash);
      if (!found) throw invalidInvitation();
      const event = await loadVisibleEvent(tx, user, found.eventId, true);
      const team = await repo.findTeam(tx, found.id, true);
      if (
        !team ||
        team.status !== 'active' ||
        team.invitationHash !== hash ||
        !team.invitationExpiresAt ||
        team.invitationExpiresAt.getTime() <= Date.now()
      ) {
        throw invalidInvitation();
      }

      assertOpen(event);
      assertMode(event, 'team');
      const members = await repo.countActiveMembers(tx, team.id);
      if (event.teamSizeMax !== null && members >= event.teamSizeMax) {
        throw errors.conflict('TEAM_FULL', 'This team is already full');
      }
      const reg = await takeSeat(tx, event, user.id, team.id);
      await recordAudit(tx, {
        actorId: user.id,
        action: 'registration.created',
        targetType: 'registration',
        targetId: reg.id,
        metadata: { eventId: event.id, teamId: team.id },
        ...meta,
      });
      await notifyConfirmed(ctx, tx, user, event, reg, team.name);
      return {
        status: 201,
        body: {
          data: {
            registration: toView(reg, team),
            team: await teamView(tx, user, event, team, false),
          },
        },
      };
    }),
  );
}

async function loadLeaderTeam(
  tx: Executor,
  user: AuthUser,
  teamId: string,
): Promise<{ team: TeamRecord; event: EventRecord }> {
  const found = await repo.findTeam(tx, teamId);
  if (!found) throw errors.notFound('Team');
  const event = await getEventById(tx, found.eventId, true);
  if (!event) throw errors.notFound('Team');
  const team = await repo.findTeam(tx, teamId, true);
  if (!team || team.status !== 'active') throw errors.notFound('Team');
  if (team.leaderId !== user.id) {
    // Members and event staff may see the team, so they get 403; everyone else gets 404.
    const mine = await repo.findByEventUser(tx, team.eventId, user.id);
    if (mine?.teamId === team.id || canViewWorkflow(user, event)) throw errors.forbidden();
    throw errors.notFound('Team');
  }
  return { team, event };
}

export async function regenerateInvitation(
  ctx: AppContext,
  user: AuthUser,
  teamId: string,
  meta: RequestMeta,
) {
  return run(ctx, async (tx) => {
    const { team, event } = await loadLeaderTeam(tx, user, teamId);
    assertOpen(event);
    const invitation = newInvitation(event);
    await repo.setInvitation(tx, team.id, invitation.hash, invitation.expiresAt);
    await recordAudit(tx, {
      actorId: user.id,
      action: 'team.invitation_regenerated',
      targetType: 'team',
      targetId: team.id,
      ...meta,
    });
    return {
      invitationCode: invitation.code,
      invitationExpiresAt: invitation.expiresAt.toISOString(),
    };
  });
}

export async function revokeInvitation(
  ctx: AppContext,
  user: AuthUser,
  teamId: string,
  meta: RequestMeta,
) {
  return run(ctx, async (tx) => {
    const { team } = await loadLeaderTeam(tx, user, teamId);
    await repo.setInvitation(tx, team.id, null, null);
    await recordAudit(tx, {
      actorId: user.id,
      action: 'team.invitation_revoked',
      targetType: 'team',
      targetId: team.id,
      ...meta,
    });
    return { revoked: true };
  });
}

export interface TeamView {
  id: string;
  eventId: string;
  name: string;
  status: TeamRecord['status'];
  leader: { id: string; name: string };
  size: number;
  minSize: number | null;
  maxSize: number | null;
  /** Reached the minimum team size. Teams below it are flagged, never removed automatically. */
  complete: boolean;
  members: { userId: string; name: string; registrationId: string; isLeader: boolean }[];
  /** Only the leader sees this. The code itself is never returned here. */
  invitation?: { active: boolean; expiresAt: string | null };
}

async function teamView(
  db: Executor,
  viewer: AuthUser,
  event: EventRecord,
  team: TeamRecord,
  includeInvitation: boolean,
): Promise<TeamView> {
  const members = await repo.activeMembers(db, team.id);
  const names = await usersRepo.getNames(
    db,
    members.map((m) => m.userId),
  );
  const view: TeamView = {
    id: team.id,
    eventId: team.eventId,
    name: team.name,
    status: team.status,
    leader: { id: team.leaderId, name: names.get(team.leaderId) ?? '' },
    size: members.length,
    minSize: event.teamSizeMin,
    maxSize: event.teamSizeMax,
    complete: event.teamSizeMin === null || members.length >= event.teamSizeMin,
    members: members.map((m) => ({
      userId: m.userId,
      name: names.get(m.userId) ?? '',
      registrationId: m.id,
      isLeader: m.userId === team.leaderId,
    })),
  };
  if (includeInvitation && team.leaderId === viewer.id) {
    view.invitation = {
      active:
        team.invitationHash !== null && (team.invitationExpiresAt?.getTime() ?? 0) > Date.now(),
      expiresAt: team.invitationExpiresAt?.toISOString() ?? null,
    };
  }
  return view;
}

export async function getTeam(ctx: AppContext, user: AuthUser, teamId: string): Promise<TeamView> {
  const team = await repo.findTeam(ctx.pool, teamId);
  if (!team) throw errors.notFound('Team');
  const event = await getEventById(ctx.pool, team.eventId);
  if (!event) throw errors.notFound('Team');
  const mine = await repo.findByEventUser(ctx.pool, team.eventId, user.id);
  const isMember = mine?.status === 'registered' && mine.teamId === team.id;
  if (!isMember && !canViewWorkflow(user, event)) throw errors.notFound('Team');
  return teamView(ctx.pool, user, event, team, true);
}

// ---- cancelling ----------------------------------------------------------------------------------

export async function cancelRegistration(
  ctx: AppContext,
  user: AuthUser,
  registrationId: string,
  meta: RequestMeta,
): Promise<RegistrationView> {
  return run(ctx, async (tx) => {
    const peek = await repo.findById(tx, registrationId);
    if (!peek || peek.userId !== user.id) throw errors.notFound('Registration');
    const event = await getEventById(tx, peek.eventId, true);
    const reg = await repo.findById(tx, registrationId, true);
    if (!reg || reg.userId !== user.id) throw errors.notFound('Registration');
    if (reg.status === 'cancelled') return viewOf(tx, reg); // repeating a cancel changes nothing

    if (event && new Date() >= event.startAt) {
      throw errors.conflict(
        'EVENT_STARTED',
        'The event has started, so the registration can no longer be cancelled',
      );
    }
    await runCancelGuards(tx, reg);
    const cancelled = await repo.markCancelled(tx, reg.id, 'self');
    await recordAudit(tx, {
      actorId: user.id,
      action: 'registration.cancelled',
      targetType: 'registration',
      targetId: reg.id,
      metadata: {
        eventId: reg.eventId,
        reason: 'self',
        wasWaitlisted: reg.status === 'waitlisted',
      },
      ...meta,
    });

    if (reg.teamId) {
      const team = await repo.findTeam(tx, reg.teamId, true);
      if (team && team.status === 'active' && team.leaderId === user.id) {
        const next = (await repo.activeMembers(tx, team.id))[0];
        if (next) {
          await repo.setLeader(tx, team.id, next.userId);
          await recordAudit(tx, {
            actorId: user.id,
            action: 'team.leader_changed',
            targetType: 'team',
            targetId: team.id,
            metadata: { from: user.id, to: next.userId },
            ...meta,
          });
        } else {
          await repo.dissolveTeam(tx, team.id);
          await recordAudit(tx, {
            actorId: user.id,
            action: 'team.dissolved',
            targetType: 'team',
            targetId: team.id,
            ...meta,
          });
        }
      }
    }
    // Leaving the queue frees nothing; giving up a seat passes it to the first person waiting.
    if (reg.status === 'registered' && event) await promoteFromWaitlist(ctx, tx, event);
    return viewOf(tx, cancelled);
  });
}

// ---- reading -------------------------------------------------------------------------------------

export interface RegistrationSummary {
  eventId: string;
  registrationMode: EventRecord['registrationMode'];
  capacity: number | null;
  registered: number;
  seatsLeft: number | null;
  /** The event accepts registrations right now (published, before the deadline). */
  open: boolean;
  full: boolean;
  /** People waiting for a seat (individual events only). */
  waitlisted: number;
  /** The event is open, full and takes individual registrations, so a person can join the queue. */
  waitlistOpen: boolean;
  mine: RegistrationView | null;
}

export async function summary(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
): Promise<RegistrationSummary> {
  const event = await loadVisibleEvent(ctx.pool, user, eventId);
  const registered = await repo.countRegistered(ctx.pool, eventId);
  const waitlisted = await repo.countWaitlisted(ctx.pool, eventId);
  const mine = await repo.findByEventUser(ctx.pool, eventId, user.id);
  const seatsLeft = event.capacity === null ? null : Math.max(0, event.capacity - registered);
  return {
    eventId,
    registrationMode: event.registrationMode,
    capacity: event.capacity,
    registered,
    seatsLeft,
    open: isEligibleForRegistration(event),
    full: seatsLeft === 0,
    waitlisted,
    waitlistOpen:
      isEligibleForRegistration(event) &&
      seatsLeft === 0 &&
      event.registrationMode === 'individual',
    mine: mine ? await viewOf(ctx.pool, mine) : null,
  };
}

export interface RegistrantRow extends RegistrationView {
  user: { id: string; name: string; email: string };
}

/** The event's organizer, its department's faculty/HOD and admins see who registered (assumption R-12). */
export async function listForEvent(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  q: z.infer<typeof listQuerySchema>,
) {
  const event = await loadVisibleEvent(ctx.pool, user, eventId);
  if (!canViewWorkflow(user, event)) throw errors.forbidden();
  const { rows, total } = await repo.listForEvent(ctx.pool, eventId, q);
  const contacts = new Map(
    (
      await usersRepo.getContacts(
        ctx.pool,
        rows.map((r) => r.userId),
      )
    ).map((c) => [c.id, c]),
  );
  const teams = await repo.teamsByIds(ctx.pool, [
    ...new Set(rows.map((r) => r.teamId).filter((t): t is string => t !== null)),
  ]);
  const positions = rows.some((r) => r.status === 'waitlisted')
    ? await repo.waitlistPositions(ctx.pool, eventId)
    : new Map<string, number>();
  const data: RegistrantRow[] = rows.map((r) => {
    const c = contacts.get(r.userId);
    return {
      ...toView(r, r.teamId ? teams.get(r.teamId) : null, positions.get(r.id) ?? null),
      user: { id: r.userId, name: c?.name ?? '', email: c?.email ?? '' },
    };
  });
  return { data, page: { total, limit: q.limit, offset: q.offset } };
}

export interface MyRegistration extends RegistrationView {
  event: {
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    status: EventRecord['status'];
  } | null;
}

export async function listMine(ctx: AppContext, user: AuthUser): Promise<MyRegistration[]> {
  const rows = await repo.listForUser(ctx.pool, user.id);
  const teams = await repo.teamsByIds(ctx.pool, [
    ...new Set(rows.map((r) => r.teamId).filter((t): t is string => t !== null)),
  ]);
  const out: MyRegistration[] = [];
  const queues = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const event = await getEventById(ctx.pool, r.eventId);
    if (r.status === 'waitlisted' && !queues.has(r.eventId)) {
      queues.set(r.eventId, await repo.waitlistPositions(ctx.pool, r.eventId));
    }
    out.push({
      ...toView(r, r.teamId ? teams.get(r.teamId) : null, queues.get(r.eventId)?.get(r.id) ?? null),
      event: event
        ? {
            id: event.id,
            title: event.title,
            startAt: event.startAt.toISOString(),
            endAt: event.endAt.toISOString(),
            status: event.status,
          }
        : null,
    });
  }
  return out;
}
