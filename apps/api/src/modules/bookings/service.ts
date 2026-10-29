import type { PoolClient } from 'pg';
import type { AppContext } from '../../context.js';
import {
  isExclusionViolation,
  isUniqueViolation,
  retryTx,
  withTx,
  type Executor,
} from '../../platform/db.js';
import { AppError, errors } from '../../platform/errors.js';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import type { AuthUser } from '../auth/types.js';
import { checkRange } from '../calendar/service.js';
import { canView, getEventById, type EventRecord, type EventStatus } from '../events/index.js';
import * as hallsRepo from '../halls/repository.js';
import type { Hall } from '../halls/repository.js';
import { notify } from '../notifications/notify.js';
import * as usersRepo from '../users/repository.js';
import {
  canCompleteBookingApproval,
  canSeeBooking,
  checkBookingApprover,
  LEVEL_LABEL,
  NEXT_LEVEL,
  type DenyReason,
} from './policy.js';
import * as repo from './repository.js';
import type { Booking, BookingLevel, BookingStatus, BookingWarning } from './types.js';

/** Events in these states may hold hall bookings. Cancelled and closed events may not. */
const BOOKABLE_EVENT_STATES: readonly EventStatus[] = [
  'draft',
  'pending_approval',
  'approved',
  'published',
];

const bookingUrl = (ctx: AppContext, id: string) => `${ctx.config.WEB_BASE_URL}/bookings/${id}`;

export function formatWhen(ctx: AppContext, start: Date, end: Date): string {
  const f = new Intl.DateTimeFormat('en-IN', {
    timeZone: ctx.config.APP_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${f.format(start)} to ${f.format(end)}`;
}

// ---- guards ------------------------------------------------------------------------------------

async function loadEvent(db: Executor, actor: AuthUser, eventId: string): Promise<EventRecord> {
  const event = await getEventById(db, eventId);
  if (!event || !canView(actor, event)) throw errors.notFound('Event');
  return event;
}

const isAdmin = (a: AuthUser) => a.roles.includes('admin');

/** Only the event's organizer, or an admin, manages its bookings. */
function assertCanManage(actor: AuthUser, event: Pick<EventRecord, 'organizerId'>): void {
  if (actor.id !== event.organizerId && !isAdmin(actor))
    throw errors.forbidden('Only the event organizer or an administrator can manage its bookings');
}

/** Bookings are requested, changed and approved before the event starts, and only for live events. */
function assertWindowOpen(event: Pick<EventRecord, 'status' | 'startAt'>): void {
  if (!BOOKABLE_EVENT_STATES.includes(event.status)) {
    throw errors.conflict(
      'EVENT_NOT_BOOKABLE',
      `A ${event.status} event cannot have hall bookings`,
    );
  }
  if (Date.now() >= event.startAt.getTime()) {
    throw errors.conflict(
      'BOOKING_WINDOW_CLOSED',
      'Bookings can only be made or changed before the event starts',
    );
  }
}

function validateRange(startAt: Date, endAt: Date): void {
  const issues: { path: string; message: string }[] = [];
  if (endAt <= startAt) issues.push({ path: 'endAt', message: 'End must be after start' });
  if (startAt.getTime() <= Date.now())
    issues.push({ path: 'startAt', message: 'Must be in the future' });
  if (issues.length) throw errors.validation(issues);
}

// ---- warnings ----------------------------------------------------------------------------------

/**
 * Things worth knowing before booking. None of them refuses the booking: the organizer acknowledges
 * them and they are stored for the approvers. (The calendar is advisory by decision.)
 */
export async function computeWarnings(
  ctx: AppContext,
  db: Executor,
  event: Pick<EventRecord, 'expectedAttendance' | 'departmentId' | 'startAt' | 'endAt'>,
  hall: Hall,
  range: { startAt: Date; endAt: Date; requiredFacilities: string[] },
): Promise<BookingWarning[]> {
  const warnings: BookingWarning[] = [];
  if (event.expectedAttendance > hall.capacity) {
    warnings.push({
      code: 'CAPACITY',
      message: `${hall.name} seats ${hall.capacity}, but ${event.expectedAttendance} people are expected`,
      details: { capacity: hall.capacity, expectedAttendance: event.expectedAttendance },
    });
  }
  const missing = range.requiredFacilities.filter((f) => !hall.facilities.includes(f));
  if (missing.length) {
    warnings.push({
      code: 'FACILITIES',
      message: `${hall.name} does not list: ${missing.join(', ')}`,
      details: { missing },
    });
  }
  const calendar = await checkRange(db, ctx.config.APP_TIMEZONE, {
    startAt: range.startAt,
    endAt: range.endAt,
    departmentId: event.departmentId,
  });
  for (const e of [...calendar.blocks, ...calendar.warnings]) {
    warnings.push({
      code: 'CALENDAR',
      message: `Overlaps "${e.title}" (${e.startDate}${e.endDate === e.startDate ? '' : ` to ${e.endDate}`})`,
      details: {
        entryId: e.id,
        type: e.type,
        severity: e.severity,
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate,
      },
    });
  }
  if (range.startAt > event.startAt || range.endAt < event.endAt) {
    warnings.push({
      code: 'EVENT_TIME',
      message: 'This booking does not cover the whole event time',
      details: {},
    });
  }
  return warnings;
}

function requireAcknowledged(warnings: BookingWarning[], acknowledged: boolean): void {
  if (warnings.length > 0 && !acknowledged) {
    throw new AppError(
      409,
      'WARNINGS_NEED_ACKNOWLEDGEMENT',
      'Please review the warnings and confirm to continue',
      { warnings },
    );
  }
}

// ---- approvers ---------------------------------------------------------------------------------

type Subject = Pick<Booking, 'departmentId' | 'requestedBy' | 'eventOrganizerId'>;

async function candidates(
  db: Executor,
  s: Subject,
  level: BookingLevel,
): Promise<usersRepo.UserContact[]> {
  const people =
    level === 'faculty'
      ? await usersRepo.listActiveByRole(db, 'faculty', s.departmentId)
      : [
          ...(await usersRepo.listActiveByRole(db, 'hod', s.departmentId)),
          ...(await usersRepo.listActiveByRole(db, 'admin', null)),
        ];
  const seen = new Set<string>();
  return people.filter((p) => {
    if (p.id === s.requestedBy || p.id === s.eventOrganizerId || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

/** Refuses a booking whose approval could never complete (nobody eligible, or the same person twice). */
async function assertApprovable(db: Executor, s: Subject): Promise<void> {
  const faculty = await candidates(db, s, 'faculty');
  const hodAdmin = await candidates(db, s, 'hod_admin');
  const missing = [
    ...(faculty.length ? [] : ['faculty']),
    ...(hodAdmin.length ? [] : ['hod_admin']),
  ];
  if (
    missing.length ||
    !canCompleteBookingApproval(
      faculty.map((p) => p.id),
      hodAdmin.map((p) => p.id),
    )
  ) {
    throw new AppError(
      409,
      'NO_APPROVER_AVAILABLE',
      'No eligible approvers are available for this booking; ask an administrator to add them',
      { levels: missing },
    );
  }
}

async function notifyApprovers(
  ctx: AppContext,
  tx: PoolClient,
  b: Booking,
  hall: Hall,
  event: EventRecord,
  level: BookingLevel,
): Promise<void> {
  const decided = await repo.decidersInRound(tx, b.id, b.approvalRound);
  const requester =
    (await usersRepo.getNames(tx, [b.requestedBy])).get(b.requestedBy) ?? 'The organizer';
  for (const person of await candidates(tx, b, level)) {
    if (decided.has(person.id)) continue;
    await notify(tx, {
      type: 'booking.approval_requested',
      to: person.email,
      data: {
        name: person.name,
        eventTitle: event.title,
        hallName: hall.name,
        when: formatWhen(ctx, b.startAt, b.endAt),
        level,
        requesterName: requester,
        url: bookingUrl(ctx, b.id),
      },
      key: `booking.approval_requested:${b.id}:${b.approvalRound}:${level}:${person.id}`,
    });
  }
}

// ---- reading -----------------------------------------------------------------------------------

async function conflictDetails(
  db: Executor,
  actor: AuthUser,
  hallId: string,
  startAt: Date,
  endAt: Date,
  excludeId?: string,
) {
  const overlapping = await repo.findOverlapping(db, {
    hallIds: [hallId],
    startAt,
    endAt,
    excludeId,
  });
  return Promise.all(
    overlapping.slice(0, 5).map(async (o) => {
      const ev = await getEventById(db, o.eventId);
      return {
        bookingId: o.id,
        startAt: o.startAt,
        endAt: o.endAt,
        status: o.status,
        eventTitle: ev && canView(actor, ev) ? ev.title : null,
      };
    }),
  );
}

async function conflictError(
  ctx: AppContext,
  actor: AuthUser,
  err: unknown,
  hallId: string,
  startAt: Date,
  endAt: Date,
  excludeId?: string,
): Promise<unknown> {
  if (!isExclusionViolation(err, 'hall_bookings_no_overlap')) return err;
  const conflicts = await conflictDetails(ctx.pool, actor, hallId, startAt, endAt, excludeId);
  return new AppError(409, 'HALL_UNAVAILABLE', 'The hall is already booked for part of this time', {
    conflicts,
  });
}

/** Early, friendly "already booked" answer. Not a guarantee: the database constraint decides. */
async function assertSlotLooksFree(
  ctx: AppContext,
  actor: AuthUser,
  db: Executor,
  hallId: string,
  startAt: Date,
  endAt: Date,
  excludeId?: string,
): Promise<void> {
  const taken = await repo.findOverlapping(db, { hallIds: [hallId], startAt, endAt, excludeId });
  if (taken.length === 0) return;
  throw new AppError(409, 'HALL_UNAVAILABLE', 'The hall is already booked for part of this time', {
    conflicts: await conflictDetails(db, actor, hallId, startAt, endAt, excludeId),
  });
}

export async function getBookingDetail(ctx: AppContext, actor: AuthUser, id: string) {
  const b = await repo.getById(ctx.pool, id);
  if (!b || !canSeeBooking(actor, b)) throw errors.notFound('Booking');
  const [hall, event, decisions, history, decided] = await Promise.all([
    hallsRepo.getById(ctx.pool, b.hallId),
    getEventById(ctx.pool, b.eventId),
    repo.decisionsFor(ctx.pool, b.id),
    repo.historyFor(ctx.pool, b.id),
    repo.decidersInRound(ctx.pool, b.id, b.approvalRound),
  ]);
  const names = await usersRepo.getNames(ctx.pool, [
    b.requestedBy,
    ...decisions.map((d) => d.approverId),
    ...history.flatMap((h) => (h.actorId ? [h.actorId] : [])),
  ]);
  const active = b.status === 'pending' || b.status === 'confirmed';
  const windowOpen =
    !!event && BOOKABLE_EVENT_STATES.includes(event.status) && Date.now() < event.startAt.getTime();
  const manager = actor.id === b.eventOrganizerId || isAdmin(actor);
  return {
    ...b,
    requestedByName: names.get(b.requestedBy) ?? null,
    hall: hall && {
      id: hall.id,
      name: hall.name,
      location: hall.location,
      capacity: hall.capacity,
      facilities: hall.facilities,
      isActive: hall.isActive,
    },
    event: event && {
      id: event.id,
      title: event.title,
      status: event.status,
      startAt: event.startAt,
      endAt: event.endAt,
      expectedAttendance: event.expectedAttendance,
    },
    coversEvent: !!event && b.startAt <= event.startAt && b.endAt >= event.endAt,
    approvals: decisions.map((d) => ({ ...d, approverName: names.get(d.approverId) ?? null })),
    history: history.map((h) => ({
      ...h,
      actorName: h.actorId ? (names.get(h.actorId) ?? null) : null,
    })),
    actions: {
      canEdit: manager && active && windowOpen,
      canCancel: manager && active,
      canApprove:
        b.status === 'pending' &&
        b.approvalLevel !== null &&
        windowOpen &&
        checkBookingApprover(actor, b, b.approvalLevel, decided).ok,
    },
  };
}

export async function listBookings(
  ctx: AppContext,
  actor: AuthUser,
  q: {
    scope: 'mine' | 'event' | 'department' | 'approvals';
    eventId?: string;
    status?: BookingStatus;
    limit: number;
    offset: number;
  },
) {
  const paging = { limit: q.limit, offset: q.offset, status: q.status };
  let filter: repo.ListFilter;
  switch (q.scope) {
    case 'mine':
      filter = { ...paging, mineOf: actor.id };
      break;
    case 'event': {
      if (!q.eventId)
        throw errors.validation([
          { path: 'eventId', message: 'eventId is required for this scope' },
        ]);
      filter = { ...paging, eventId: q.eventId };
      break;
    }
    case 'department':
      if (isAdmin(actor)) filter = { ...paging };
      else if (actor.departmentId && actor.roles.some((r) => r === 'faculty' || r === 'hod'))
        filter = { ...paging, departmentId: actor.departmentId };
      else throw errors.forbidden();
      break;
    case 'approvals': {
      const levels: { level: BookingLevel; departmentId: string | null }[] = [];
      if (actor.departmentId && actor.roles.includes('faculty'))
        levels.push({ level: 'faculty', departmentId: actor.departmentId });
      if (actor.departmentId && actor.roles.includes('hod'))
        levels.push({ level: 'hod_admin', departmentId: actor.departmentId });
      if (isAdmin(actor)) levels.push({ level: 'hod_admin', departmentId: null });
      if (levels.length === 0) throw errors.forbidden();
      filter = { ...paging, queue: { actorId: actor.id, levels } };
      break;
    }
  }
  const { rows, total } = await repo.list(ctx.pool, filter);
  // Event scope may be asked for any event id, so show only bookings the caller is allowed to see.
  const visible = rows.filter((b) => canSeeBooking(actor, b));
  const halls = new Map(
    (await hallsRepo.list(ctx.pool, { includeInactive: true })).map((h) => [h.id, h]),
  );
  const events = new Map<string, EventRecord | null>();
  for (const id of new Set(visible.map((b) => b.eventId)))
    events.set(id, await getEventById(ctx.pool, id));
  return {
    data: visible.map((b) => ({
      ...b,
      hallName: halls.get(b.hallId)?.name ?? null,
      eventTitle: events.get(b.eventId)?.title ?? null,
    })),
    page: { limit: q.limit, offset: q.offset, total: q.scope === 'event' ? visible.length : total },
  };
}

/** Which halls are free for a time range, and who holds the ones that are not. Informational: the database decides at booking time. */
export async function availability(
  ctx: AppContext,
  actor: AuthUser,
  q: {
    startAt: Date;
    endAt: Date;
    attendance?: number;
    facilities: string[];
    onlyAvailable: boolean;
  },
) {
  const halls = await hallsRepo.list(ctx.pool, { includeInactive: false });
  const busy = await repo.findOverlapping(ctx.pool, {
    hallIds: halls.map((h) => h.id),
    startAt: q.startAt,
    endAt: q.endAt,
  });
  const titles = new Map<string, string | null>();
  for (const id of new Set(busy.map((b) => b.eventId))) {
    const ev = await getEventById(ctx.pool, id);
    titles.set(id, ev && canView(actor, ev) ? ev.title : null); // others' drafts show as "Reserved"
  }
  const rows = halls.map((hall) => {
    const conflicts = busy
      .filter((b) => b.hallId === hall.id)
      .slice(0, 5)
      .map((b) => ({
        bookingId: b.id,
        startAt: b.startAt,
        endAt: b.endAt,
        status: b.status,
        eventTitle: titles.get(b.eventId) ?? null,
      }));
    return {
      hall,
      available: busy.every((b) => b.hallId !== hall.id),
      conflicts,
      capacityOk: q.attendance === undefined || q.attendance <= hall.capacity,
      missingFacilities: q.facilities.filter((f) => !hall.facilities.includes(f)),
    };
  });
  return { data: q.onlyAvailable ? rows.filter((r) => r.available) : rows };
}

// ---- writing -----------------------------------------------------------------------------------

export interface CreateInput {
  eventId: string;
  hallId: string;
  startAt: string;
  endAt: string;
  requiredFacilities: string[];
  notes: string;
  acknowledgeWarnings: boolean;
}

async function createBookingOnce(
  ctx: AppContext,
  actor: AuthUser,
  input: CreateInput,
  meta: RequestMeta,
) {
  const event = await loadEvent(ctx.pool, actor, input.eventId);
  assertCanManage(actor, event);
  assertWindowOpen(event);
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  validateRange(startAt, endAt);

  try {
    const out = await withTx(ctx.pool, async (tx) => {
      // Locking the hall row exclusively keeps it from being deactivated between this check and the
      // insert, and makes everyone who writes a booking for this hall go one after another. Without
      // that, two overlapping inserts can each wait for the other's uncommitted row and deadlock
      // (under load some requests ran out of retries). The exclusion constraint below is still the
      // guard against a double booking; this only removes the deadlocks.
      const hall = await hallsRepo.getById(tx, input.hallId, 'update');
      if (!hall) throw errors.validation([{ path: 'hallId', message: 'Hall does not exist' }]);
      if (!hall.isActive)
        throw errors.conflict('HALL_INACTIVE', 'This hall is not available for new bookings');

      // A retry of the same request returns the booking it already made instead of a conflict.
      const existing = await repo.findSameActive(tx, {
        eventId: event.id,
        hallId: hall.id,
        requestedBy: actor.id,
        startAt,
        endAt,
      });
      if (existing) return { booking: existing, created: false };

      // Report a taken slot before asking about warnings. This is only a hint for a clear message;
      // the exclusion constraint on the insert below is what actually prevents a double booking.
      await assertSlotLooksFree(ctx, actor, tx, hall.id, startAt, endAt);

      const warnings = await computeWarnings(ctx, tx, event, hall, {
        startAt,
        endAt,
        requiredFacilities: input.requiredFacilities,
      });
      requireAcknowledged(warnings, input.acknowledgeWarnings);
      const subject = {
        departmentId: event.departmentId,
        requestedBy: actor.id,
        eventOrganizerId: event.organizerId,
      };
      await assertApprovable(tx, subject);

      const booking = await repo.insert(tx, {
        ...subject,
        eventId: event.id,
        hallId: hall.id,
        startAt,
        endAt,
        requiredFacilities: input.requiredFacilities,
        notes: input.notes,
        warnings,
      });
      await repo.addHistory(tx, {
        bookingId: booking.id,
        action: 'request',
        actorId: actor.id,
        toStatus: 'pending',
        level: 'faculty',
      });
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'booking.requested',
        targetType: 'booking',
        targetId: booking.id,
        metadata: { eventId: event.id, hallId: hall.id, warnings: warnings.map((w) => w.code) },
        ...meta,
      });
      await notifyApprovers(ctx, tx, booking, hall, event, 'faculty');
      return { booking, created: true };
    });
    return { detail: await getBookingDetail(ctx, actor, out.booking.id), created: out.created };
  } catch (err) {
    if (isExclusionViolation(err, 'hall_bookings_no_overlap')) {
      // A retry that raced with its own first attempt: the winner is this same request, so return it.
      const same = await repo.findSameActive(ctx.pool, {
        eventId: event.id,
        hallId: input.hallId,
        requestedBy: actor.id,
        startAt,
        endAt,
      });
      if (same) return { detail: await getBookingDetail(ctx, actor, same.id), created: false };
    }
    throw await conflictError(ctx, actor, err, input.hallId, startAt, endAt);
  }
}

export interface UpdateInput {
  hallId?: string;
  startAt?: string;
  endAt?: string;
  requiredFacilities?: string[];
  notes?: string;
  acknowledgeWarnings: boolean;
}

const sameInstant = (a: Date, b: Date) => a.getTime() === b.getTime();

async function updateBookingOnce(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  patch: UpdateInput,
  meta: RequestMeta,
) {
  let target: { hallId: string; startAt: Date; endAt: Date } | undefined;
  try {
    await withTx(ctx.pool, async (tx) => {
      const booking = await repo.getById(tx, id, true);
      if (!booking || !canSeeBooking(actor, booking)) throw errors.notFound('Booking');
      const event = await getEventById(tx, booking.eventId);
      if (!event) throw errors.notFound('Event');
      assertCanManage(actor, event);
      if (booking.status !== 'pending' && booking.status !== 'confirmed')
        throw errors.conflict('BOOKING_CLOSED', `A ${booking.status} booking cannot be changed`);
      assertWindowOpen(event);

      const next = {
        hallId: patch.hallId ?? booking.hallId,
        startAt: patch.startAt ? new Date(patch.startAt) : booking.startAt,
        endAt: patch.endAt ? new Date(patch.endAt) : booking.endAt,
        requiredFacilities: patch.requiredFacilities ?? booking.requiredFacilities,
        notes: patch.notes ?? booking.notes,
      };
      target = next;
      const scheduleChanged =
        next.hallId !== booking.hallId ||
        !sameInstant(next.startAt, booking.startAt) ||
        !sameInstant(next.endAt, booking.endAt);
      const facilitiesChanged =
        next.requiredFacilities.join('|') !== booking.requiredFacilities.join('|');
      if (scheduleChanged) validateRange(next.startAt, next.endAt);

      const hall = await hallsRepo.getById(tx, next.hallId, 'update'); // same reason as when creating
      if (!hall) throw errors.validation([{ path: 'hallId', message: 'Hall does not exist' }]);
      if (scheduleChanged && !hall.isActive)
        throw errors.conflict('HALL_INACTIVE', 'This hall is not available for new bookings');

      if (scheduleChanged)
        await assertSlotLooksFree(ctx, actor, tx, next.hallId, next.startAt, next.endAt, id);
      let warnings = booking.warnings;
      if (scheduleChanged || facilitiesChanged) {
        warnings = await computeWarnings(ctx, tx, event, hall, next);
        requireAcknowledged(warnings, patch.acknowledgeWarnings);
      }
      if (scheduleChanged) await assertApprovable(tx, booking);

      // A new hall or time is a new request: it goes back to the first approval step.
      await repo.patch(tx, id, {
        ...next,
        warnings,
        ...(scheduleChanged
          ? {
              status: 'pending' as const,
              approvalLevel: 'faculty' as const,
              approvalRound: booking.approvalRound + 1,
              decidedAt: null,
              closingComment: null,
            }
          : {}),
      });
      const fields = Object.keys(patch).filter((k) => k !== 'acknowledgeWarnings');
      await repo.addHistory(tx, {
        bookingId: id,
        action: 'update',
        actorId: actor.id,
        fromStatus: booking.status,
        toStatus: scheduleChanged ? 'pending' : booking.status,
        level: scheduleChanged ? 'faculty' : null,
        comment: fields.join(', '),
      });
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'booking.updated',
        targetType: 'booking',
        targetId: id,
        metadata: { fields, resubmitted: scheduleChanged, from: booking.status },
        ...meta,
      });
      if (scheduleChanged) {
        const updated = (await repo.getById(tx, id))!;
        await notifyApprovers(ctx, tx, updated, hall, event, 'faculty');
      }
    });
  } catch (err) {
    throw await conflictError(
      ctx,
      actor,
      err,
      target?.hallId ?? patch.hallId ?? '',
      target?.startAt ?? new Date(),
      target?.endAt ?? new Date(),
      id,
    );
  }
  return getBookingDetail(ctx, actor, id);
}

export async function cancelBooking(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  comment: string | undefined,
  meta: RequestMeta,
) {
  await withTx(ctx.pool, async (tx) => {
    const booking = await repo.getById(tx, id, true);
    if (!booking || !canSeeBooking(actor, booking)) throw errors.notFound('Booking');
    assertCanManage(actor, { organizerId: booking.eventOrganizerId });
    if (booking.status !== 'pending' && booking.status !== 'confirmed')
      throw errors.conflict('BOOKING_CLOSED', `A ${booking.status} booking cannot be cancelled`);
    const byOrganizer = actor.id === booking.eventOrganizerId;
    if (!byOrganizer && !comment)
      throw errors.validation([
        { path: 'comment', message: "Please give a reason when cancelling someone else's booking" },
      ]);

    await repo.patch(tx, id, {
      status: 'cancelled',
      approvalLevel: null,
      closingComment: comment ?? null,
      decidedAt: 'now',
    });
    await repo.addHistory(tx, {
      bookingId: id,
      action: 'cancel',
      actorId: actor.id,
      fromStatus: booking.status,
      toStatus: 'cancelled',
      comment,
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: 'booking.cancelled',
      targetType: 'booking',
      targetId: id,
      metadata: { from: booking.status },
      ...meta,
    });
    if (!byOrganizer) await notifyCancelled(ctx, tx, booking, actor.name, comment ?? '');
  });
  return getBookingDetail(ctx, actor, id);
}

/** Tells the event's organizer their booking was cancelled by someone else (or by the system). */
export async function notifyCancelled(
  ctx: AppContext,
  tx: Executor,
  b: Booking,
  cancelledBy: string,
  reason: string,
): Promise<void> {
  const organizer = (
    await tx.query('SELECT name, email FROM users WHERE id = $1', [b.eventOrganizerId])
  ).rows[0] as { name: string; email: string } | undefined;
  const hall = await hallsRepo.getById(tx, b.hallId);
  const event = await getEventById(tx, b.eventId);
  if (!organizer || !hall || !event) return;
  await notify(tx, {
    type: 'booking.cancelled',
    to: organizer.email,
    data: {
      name: organizer.name,
      eventTitle: event.title,
      hallName: hall.name,
      when: formatWhen(ctx, b.startAt, b.endAt),
      cancelledBy,
      reason,
      url: bookingUrl(ctx, b.id),
    },
    key: `booking.cancelled:${b.id}:${b.approvalRound}`,
  });
}

const DENY: Record<DenyReason, { status: number; code: string; message: string }> = {
  wrong_role: {
    status: 403,
    code: 'FORBIDDEN',
    message: 'You do not hold the role required for this approval step',
  },
  wrong_department: {
    status: 403,
    code: 'FORBIDDEN',
    message: 'This booking belongs to another department',
  },
  own_booking: {
    status: 403,
    code: 'SELF_APPROVAL',
    message: "You cannot decide your own booking or your own event's booking",
  },
  already_decided: {
    status: 409,
    code: 'ALREADY_DECIDED',
    message: 'You have already decided another step of this request',
  },
};

/**
 * Approves or rejects the booking's current step. The booking row is locked first, so concurrent
 * decisions are processed one at a time; `level` is the step the user was looking at (409 if stale).
 */
export async function decideBooking(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  input: { decision: 'approved' | 'rejected'; level: BookingLevel; comment?: string },
  meta: RequestMeta,
) {
  try {
    await withTx(ctx.pool, async (tx) => {
      const booking = await repo.getById(tx, id, true);
      if (!booking || !canSeeBooking(actor, booking)) throw errors.notFound('Booking');
      if (booking.status !== 'pending' || !booking.approvalLevel) {
        throw errors.conflict(
          'INVALID_TRANSITION',
          `This booking is not waiting for approval (status: ${booking.status})`,
        );
      }
      if (booking.approvalLevel !== input.level) {
        throw errors.conflict(
          'STALE_DECISION',
          `This booking is now waiting for ${LEVEL_LABEL[booking.approvalLevel]} approval, not ${LEVEL_LABEL[input.level]}`,
        );
      }
      const event = await getEventById(tx, booking.eventId);
      if (!event) throw errors.notFound('Event');
      assertWindowOpen(event);

      const decided = await repo.decidersInRound(tx, id, booking.approvalRound);
      const verdict = checkBookingApprover(actor, booking, booking.approvalLevel, decided);
      if (!verdict.ok) {
        const d = DENY[verdict.reason];
        throw new AppError(d.status, d.code, d.message);
      }
      await repo.insertDecision(tx, {
        bookingId: id,
        round: booking.approvalRound,
        level: booking.approvalLevel,
        decision: input.decision,
        approverId: actor.id,
        comment: input.comment || null,
      });

      const hall = (await hallsRepo.getById(tx, booking.hallId))!;
      const organizer = (
        await tx.query('SELECT name, email FROM users WHERE id = $1', [booking.eventOrganizerId])
      ).rows[0] as { name: string; email: string };
      const base = {
        name: organizer.name,
        eventTitle: event.title,
        hallName: hall.name,
        when: formatWhen(ctx, booking.startAt, booking.endAt),
        approverName: actor.name,
        comment: input.comment ?? '',
        url: bookingUrl(ctx, id),
      };
      const decisionKey = `booking.decision:${id}:${booking.approvalRound}:${booking.approvalLevel}`;
      const level = booking.approvalLevel;

      if (input.decision === 'rejected') {
        await repo.patch(tx, id, {
          status: 'rejected',
          approvalLevel: null,
          closingComment: input.comment ?? null,
          decidedAt: 'now',
        });
        await repo.addHistory(tx, {
          bookingId: id,
          action: 'reject',
          actorId: actor.id,
          fromStatus: 'pending',
          toStatus: 'rejected',
          level,
          comment: input.comment,
        });
        await recordAudit(tx, {
          actorId: actor.id,
          action: 'booking.approval_rejected',
          targetType: 'booking',
          targetId: id,
          metadata: { level },
          ...meta,
        });
        await notify(tx, {
          type: 'booking.decision',
          to: organizer.email,
          data: { ...base, decision: 'rejected' },
          key: decisionKey,
        });
        return;
      }
      const next = NEXT_LEVEL[level];
      if (next) {
        await repo.patch(tx, id, { approvalLevel: next });
        await repo.addHistory(tx, {
          bookingId: id,
          action: 'approve',
          actorId: actor.id,
          fromStatus: 'pending',
          toStatus: 'pending',
          level,
          comment: input.comment,
        });
        await recordAudit(tx, {
          actorId: actor.id,
          action: 'booking.approval_granted',
          targetType: 'booking',
          targetId: id,
          metadata: { level },
          ...meta,
        });
        await notify(tx, {
          type: 'booking.decision',
          to: organizer.email,
          data: { ...base, decision: 'approved' },
          key: decisionKey,
        });
        await notifyApprovers(ctx, tx, { ...booking, approvalLevel: next }, hall, event, next);
        return;
      }
      await repo.patch(tx, id, { status: 'confirmed', approvalLevel: null, decidedAt: 'now' });
      await repo.addHistory(tx, {
        bookingId: id,
        action: 'approve',
        actorId: actor.id,
        fromStatus: 'pending',
        toStatus: 'confirmed',
        level,
        comment: input.comment,
      });
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'booking.approval_granted',
        targetType: 'booking',
        targetId: id,
        metadata: { level, final: true },
        ...meta,
      });
      await notify(tx, {
        type: 'booking.decision',
        to: organizer.email,
        data: { ...base, decision: 'confirmed' },
        key: decisionKey,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw errors.conflict('ALREADY_DECIDED', 'This approval step was already decided');
    throw err;
  }
  const after = await repo.getById(ctx.pool, id);
  if (after && canSeeBooking(actor, after)) return getBookingDetail(ctx, actor, id);
  return { id, status: after?.status };
}

/**
 * Concurrent requests that conflict can make PostgreSQL abort one of them as a deadlock victim
 * (each insert waits for the other's uncommitted row). The loser is simply run again and then gets
 * the normal answer: created, or "hall unavailable".
 */
export function createBooking(
  ctx: AppContext,
  actor: AuthUser,
  input: CreateInput,
  meta: RequestMeta,
) {
  return retryTx(() => createBookingOnce(ctx, actor, input, meta));
}

export function updateBooking(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  patch: UpdateInput,
  meta: RequestMeta,
) {
  return retryTx(() => updateBookingOnce(ctx, actor, id, patch, meta));
}
