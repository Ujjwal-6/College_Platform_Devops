import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { retryTx, withTx, type Executor } from '../../platform/db.js';
import { AppError, errors } from '../../platform/errors.js';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import type { AuthUser } from '../auth/types.js';
import {
  canView,
  canViewWorkflow,
  getEventById,
  listEvents,
  type EventRecord,
} from '../events/index.js';
import {
  countRegistered,
  getRegistrationById,
  getTeamById,
  type RegistrationRecord,
} from '../registrations/index.js';
import * as usersRepo from '../users/repository.js';
import { qrDataUrl, signCheckInToken, verifyCheckInToken } from './qr.js';
import * as repo from './repository.js';

/** Check-in opens two hours before the event starts and closes when it ends (assumption A-3). */
const OPENS_BEFORE_START_MS = 2 * 3_600_000;

export const scanSchema = z.object({ token: z.string().trim().min(1).max(600) }).strict();
export const manualSchema = z
  .object({
    registrationId: z.string().uuid(),
    reason: z.string().trim().min(3, 'Please say why (at least 3 characters)').max(300),
  })
  .strict();
export const volunteerSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(254) })
  .strict();
export const attendanceQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const run = <T>(ctx: AppContext, fn: (tx: PoolClient) => Promise<T>) =>
  retryTx(() => withTx(ctx.pool, fn));

// ---- who may do what ---------------------------------------------------------------------------

const isAdmin = (u: AuthUser) => u.roles.includes('admin');
/** The organizer who owns the event, and admins. They assign volunteers and may check people in by hand. */
const isManager = (u: AuthUser, e: EventRecord) => isAdmin(u) || e.organizerId === u.id;

async function loadEvent(
  db: Executor,
  user: AuthUser,
  eventId: string,
  lock = false,
): Promise<EventRecord> {
  const event = await getEventById(db, eventId, lock);
  if (!event || !canView(user, event)) throw errors.notFound('Event');
  return event;
}

/** Organizer, admins and the volunteers the organizer assigned may scan passes (assumption A-1). */
async function canScan(db: Executor, user: AuthUser, event: EventRecord): Promise<boolean> {
  return isManager(user, event) || (await repo.isVolunteer(db, event.id, user.id));
}

async function assertScanner(db: Executor, user: AuthUser, event: EventRecord): Promise<void> {
  if (!(await canScan(db, user, event))) throw errors.forbidden();
}

export function checkInWindow(event: Pick<EventRecord, 'startAt' | 'endAt'>) {
  return {
    opensAt: new Date(event.startAt.getTime() - OPENS_BEFORE_START_MS),
    closesAt: event.endAt,
  };
}

function assertCheckInOpen(event: EventRecord, now = new Date()): void {
  const { opensAt, closesAt } = checkInWindow(event);
  if (event.status !== 'published') {
    throw errors.conflict('CHECK_IN_CLOSED', 'Check-in is only open for published events');
  }
  if (now < opensAt || now >= closesAt) {
    throw new AppError(409, 'CHECK_IN_CLOSED', 'Check-in is not open right now', {
      opensAt: opensAt.toISOString(),
      closesAt: closesAt.toISOString(),
    });
  }
}

// ---- checking people in ------------------------------------------------------------------------

export interface CheckInResult {
  attendanceId: string;
  registrationId: string;
  attendee: { id: string; name: string };
  team: string | null;
  method: 'qr' | 'manual';
  checkedInAt: string;
  counts: { registered: number; checkedIn: number };
}

async function resultFor(
  db: Executor,
  reg: RegistrationRecord,
  record: repo.AttendanceRecord,
): Promise<CheckInResult> {
  const [person] = await usersRepo.getContacts(db, [reg.userId]);
  const team = reg.teamId ? await getTeamById(db, reg.teamId) : null;
  return {
    attendanceId: record.id,
    registrationId: reg.id,
    attendee: { id: reg.userId, name: person?.name ?? '' },
    team: team?.name ?? null,
    method: record.method,
    checkedInAt: record.checkedInAt.toISOString(),
    counts: {
      registered: await countRegistered(db, reg.eventId),
      checkedIn: await repo.countForEvent(db, reg.eventId),
    },
  };
}

async function alreadyCheckedIn(db: Executor, registrationId: string): Promise<AppError> {
  const existing = await repo.findByRegistration(db, registrationId);
  return new AppError(409, 'ALREADY_CHECKED_IN', 'This person is already checked in', {
    checkedInAt: existing?.checkedInAt.toISOString() ?? null,
    method: existing?.method ?? null,
  });
}

function assertCheckable(reg: RegistrationRecord | null, eventId: string): RegistrationRecord {
  if (!reg || reg.eventId !== eventId) throw errors.notFound('Registration');
  if (reg.status !== 'registered') {
    throw errors.conflict(
      'REGISTRATION_NOT_ACTIVE',
      reg.status === 'waitlisted'
        ? 'This person is on the waitlist, not registered'
        : 'This registration was cancelled',
    );
  }
  return reg;
}

/** Records attendance from a scanned gate-pass code. */
export async function checkInByCode(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  token: string,
  meta: RequestMeta,
): Promise<CheckInResult> {
  return run(ctx, async (tx) => {
    // Locks the event row like every other change under an event (see registration-design.md section 3).
    const event = await loadEvent(tx, user, eventId, true);
    await assertScanner(tx, user, event);

    const verified = verifyCheckInToken(ctx.config, token);
    if (!verified.ok) {
      throw verified.reason === 'expired'
        ? errors.validation([{ path: 'token', message: 'This pass has expired' }])
        : errors.validation([{ path: 'token', message: 'This is not a valid gate pass code' }]);
    }
    if (verified.eventId !== event.id) {
      throw errors.validation([{ path: 'token', message: 'This pass is for a different event' }]);
    }
    assertCheckInOpen(event);

    const reg = assertCheckable(await getRegistrationById(tx, verified.registrationId), event.id);
    const record = await repo.insertAttendance(tx, {
      registrationId: reg.id,
      eventId: event.id,
      userId: reg.userId,
      checkedInBy: user.id,
      method: 'qr',
      reason: null,
    });
    if (!record) throw await alreadyCheckedIn(tx, reg.id);

    await recordAudit(tx, {
      actorId: user.id,
      action: 'attendance.checked_in',
      targetType: 'attendance',
      targetId: record.id,
      metadata: { eventId: event.id, registrationId: reg.id, method: 'qr' },
      ...meta,
    });
    return resultFor(tx, reg, record);
  });
}

/** Fallback when a pass cannot be scanned: the organizer or an admin checks the person in and says why. */
export async function checkInManually(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  input: z.infer<typeof manualSchema>,
  meta: RequestMeta,
): Promise<CheckInResult> {
  return run(ctx, async (tx) => {
    const event = await loadEvent(tx, user, eventId, true);
    if (!isManager(user, event)) throw errors.forbidden();
    assertCheckInOpen(event);

    const reg = assertCheckable(await getRegistrationById(tx, input.registrationId), event.id);
    const record = await repo.insertAttendance(tx, {
      registrationId: reg.id,
      eventId: event.id,
      userId: reg.userId,
      checkedInBy: user.id,
      method: 'manual',
      reason: input.reason,
    });
    if (!record) throw await alreadyCheckedIn(tx, reg.id);

    await recordAudit(tx, {
      actorId: user.id,
      action: 'attendance.manual_check_in',
      targetType: 'attendance',
      targetId: record.id,
      metadata: { eventId: event.id, registrationId: reg.id, reason: input.reason },
      ...meta,
    });
    return resultFor(tx, reg, record);
  });
}

// ---- reading -----------------------------------------------------------------------------------

export interface AttendanceSummary {
  registered: number;
  checkedIn: number;
  remaining: number;
  open: boolean;
  opensAt: string;
  closesAt: string;
}

/** Live numbers and the latest check-ins. Scanners and the event's department staff may look. */
export async function overview(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  q: z.infer<typeof attendanceQuerySchema>,
) {
  const event = await loadEvent(ctx.pool, user, eventId);
  if (!(await canScan(ctx.pool, user, event)) && !canViewWorkflow(user, event)) {
    throw errors.forbidden();
  }
  const registered = await countRegistered(ctx.pool, eventId);
  const checkedIn = await repo.countForEvent(ctx.pool, eventId);
  const rows = await repo.listForEvent(ctx.pool, eventId, q.limit, q.offset);
  const contacts = new Map(
    (
      await usersRepo.getContacts(ctx.pool, [
        ...new Set(rows.flatMap((r) => [r.userId, r.checkedInBy])),
      ])
    ).map((c) => [c.id, c.name]),
  );
  const { opensAt, closesAt } = checkInWindow(event);
  const now = new Date();
  const summary: AttendanceSummary = {
    registered,
    checkedIn,
    remaining: Math.max(0, registered - checkedIn),
    open: event.status === 'published' && now >= opensAt && now < closesAt,
    opensAt: opensAt.toISOString(),
    closesAt: closesAt.toISOString(),
  };
  return {
    summary,
    data: rows.map((r) => ({
      id: r.id,
      registrationId: r.registrationId,
      attendee: { id: r.userId, name: contacts.get(r.userId) ?? '' },
      checkedInBy: contacts.get(r.checkedInBy) ?? '',
      method: r.method,
      reason: r.reason,
      checkedInAt: r.checkedInAt.toISOString(),
    })),
    page: { total: checkedIn, limit: q.limit, offset: q.offset },
  };
}

export interface CheckInEvent {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  role: 'admin' | 'organizer' | 'volunteer';
}

/** Events the person can scan passes for right now: published and not finished. */
export async function myCheckInEvents(ctx: AppContext, user: AuthUser): Promise<CheckInEvent[]> {
  const found = new Map<string, CheckInEvent>();
  const add = (e: EventRecord, role: CheckInEvent['role']) => {
    if (e.status !== 'published' || e.endAt <= new Date() || found.has(e.id)) return;
    found.set(e.id, {
      id: e.id,
      title: e.title,
      startAt: e.startAt.toISOString(),
      endAt: e.endAt.toISOString(),
      role,
    });
  };
  const base = {
    limit: 100,
    offset: 0,
    statuses: ['published' as const],
    order: 'start_asc' as const,
  };
  if (isAdmin(user)) for (const e of (await listEvents(ctx.pool, base)).rows) add(e, 'admin');
  for (const e of (await listEvents(ctx.pool, { ...base, organizerId: user.id })).rows) {
    add(e, 'organizer');
  }
  for (const id of await repo.volunteerEventIds(ctx.pool, user.id)) {
    const e = await getEventById(ctx.pool, id);
    if (e) add(e, 'volunteer');
  }
  return [...found.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
}

// ---- volunteers --------------------------------------------------------------------------------

export interface VolunteerView {
  userId: string;
  name: string;
  email: string;
  assignedAt: string;
}

async function volunteerViews(db: Executor, eventId: string): Promise<VolunteerView[]> {
  const rows = await repo.listVolunteers(db, eventId);
  const contacts = new Map(
    (
      await usersRepo.getContacts(
        db,
        rows.map((r) => r.userId),
      )
    ).map((c) => [c.id, c]),
  );
  return rows.map((r) => ({
    userId: r.userId,
    name: contacts.get(r.userId)?.name ?? '',
    email: contacts.get(r.userId)?.email ?? '',
    assignedAt: r.createdAt.toISOString(),
  }));
}

export async function listVolunteers(ctx: AppContext, user: AuthUser, eventId: string) {
  const event = await loadEvent(ctx.pool, user, eventId);
  if (!isManager(user, event)) throw errors.forbidden();
  return volunteerViews(ctx.pool, eventId);
}

export async function addVolunteer(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  input: z.infer<typeof volunteerSchema>,
  meta: RequestMeta,
) {
  return run(ctx, async (tx) => {
    const event = await loadEvent(tx, user, eventId, true);
    if (!isManager(user, event)) throw errors.forbidden();
    if (event.status === 'closed' || event.status === 'cancelled') {
      throw errors.conflict('EVENT_ENDED', 'This event is closed or cancelled');
    }
    const person = await usersRepo.findContactByEmail(tx, input.email);
    if (!person || !person.isActive) throw errors.notFound('Active user with that email');
    const added = await repo.addVolunteer(tx, {
      eventId,
      userId: person.id,
      assignedBy: user.id,
    });
    if (added) {
      await recordAudit(tx, {
        actorId: user.id,
        action: 'volunteer.assigned',
        targetType: 'event',
        targetId: eventId,
        metadata: { userId: person.id },
        ...meta,
      });
    }
    return volunteerViews(tx, eventId); // adding someone who is already a volunteer changes nothing
  });
}

export async function removeVolunteer(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  userId: string,
  meta: RequestMeta,
) {
  return run(ctx, async (tx) => {
    const event = await loadEvent(tx, user, eventId, true);
    if (!isManager(user, event)) throw errors.forbidden();
    if (await repo.removeVolunteer(tx, eventId, userId)) {
      await recordAudit(tx, {
        actorId: user.id,
        action: 'volunteer.removed',
        targetType: 'event',
        targetId: eventId,
        metadata: { userId },
        ...meta,
      });
    }
    return volunteerViews(tx, eventId);
  });
}

// ---- the registrant's own pass -----------------------------------------------------------------

async function ownActiveRegistration(
  db: Executor,
  user: AuthUser,
  registrationId: string,
): Promise<RegistrationRecord> {
  const reg = await getRegistrationById(db, registrationId);
  if (!reg || reg.userId !== user.id) throw errors.notFound('Registration');
  if (reg.status !== 'registered') {
    throw errors.conflict('REGISTRATION_NOT_ACTIVE', 'Only a current registration has a pass');
  }
  return reg;
}

export async function myPass(ctx: AppContext, user: AuthUser, registrationId: string) {
  const reg = await ownActiveRegistration(ctx.pool, user, registrationId);
  const event = await getEventById(ctx.pool, reg.eventId);
  if (!event) throw errors.notFound('Event');
  const token = signCheckInToken(ctx.config, {
    registrationId: reg.id,
    eventId: reg.eventId,
    expiresAt: event.endAt,
  });
  const attended = await repo.findByRegistration(ctx.pool, reg.id);
  return {
    token,
    expiresAt: event.endAt.toISOString(),
    qrImage: await qrDataUrl(token),
    gatePassReady: (await repo.findGatePassKey(ctx.pool, reg.id)) !== null,
    checkedInAt: attended?.checkedInAt.toISOString() ?? null,
  };
}

/** The stored PDF, or null while the worker has not produced it yet. */
export async function myGatePass(ctx: AppContext, user: AuthUser, registrationId: string) {
  const reg = await ownActiveRegistration(ctx.pool, user, registrationId);
  const key = await repo.findGatePassKey(ctx.pool, reg.id);
  return key ? (await ctx.storage.get(key)).data : null;
}
