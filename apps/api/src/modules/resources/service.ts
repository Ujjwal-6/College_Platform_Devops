import type { AppContext } from '../../context.js';
import { isUniqueViolation, withTx, type Executor } from '../../platform/db.js';
import { AppError, errors } from '../../platform/errors.js';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import type { AuthUser } from '../auth/types.js';
import { canView, getEventById, type EventRecord } from '../events/index.js';
import * as repo from './repository.js';
import type { Reservation, Resource, ResourceInput } from './repository.js';

const isAdmin = (a: AuthUser) => a.roles.includes('admin');

async function loadEvent(db: Executor, actor: AuthUser, eventId: string): Promise<EventRecord> {
  const event = await getEventById(db, eventId);
  if (!event || !canView(actor, event)) throw errors.notFound('Event');
  return event;
}

function assertCanManage(actor: AuthUser, event: Pick<EventRecord, 'organizerId'>): void {
  if (actor.id !== event.organizerId && !isAdmin(actor))
    throw errors.forbidden('Only the event organizer or an administrator can manage its resources');
}

/** Who may see an event's reservations: the same people who may see its workflow. */
function canSeeReservations(
  actor: AuthUser,
  event: Pick<EventRecord, 'organizerId' | 'departmentId'>,
): boolean {
  if (isAdmin(actor) || actor.id === event.organizerId) return true;
  return (
    actor.departmentId !== null &&
    actor.departmentId === event.departmentId &&
    actor.roles.some((r) => r === 'faculty' || r === 'hod')
  );
}

/** Resources are reserved only for approved events (or published ones), and only before the event starts. */
function assertEventReady(event: Pick<EventRecord, 'status' | 'startAt'>): void {
  if (event.status !== 'approved' && event.status !== 'published') {
    throw errors.conflict(
      'EVENT_NOT_APPROVED',
      'Resources can only be reserved for events that have been fully approved',
    );
  }
  if (Date.now() >= event.startAt.getTime()) {
    throw errors.conflict(
      'BOOKING_WINDOW_CLOSED',
      'Resources can only be reserved or changed before the event starts',
    );
  }
}

function validateWindow(startAt: Date, endAt: Date): void {
  const issues: { path: string; message: string }[] = [];
  if (endAt <= startAt) issues.push({ path: 'endAt', message: 'End must be after start' });
  if (startAt.getTime() <= Date.now())
    issues.push({ path: 'startAt', message: 'Must be in the future' });
  if (issues.length) throw errors.validation(issues);
}

function exhausted(resource: Resource, peak: number, requested: number): AppError {
  const available = Math.max(0, resource.quantity - peak);
  return new AppError(
    409,
    'RESOURCE_EXHAUSTED',
    `Only ${available} of ${resource.quantity} ${resource.name} are free for that time`,
    {
      resourceId: resource.id,
      total: resource.quantity,
      available,
      requested,
    },
  );
}

// ---- resource catalogue ------------------------------------------------------------------------

export async function createResource(
  ctx: AppContext,
  actor: AuthUser,
  input: ResourceInput,
  meta: RequestMeta,
): Promise<Resource> {
  try {
    return await withTx(ctx.pool, async (tx) => {
      const created = await repo.insertResource(tx, input);
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'resource.created',
        targetType: 'resource',
        targetId: created.id,
        metadata: { quantity: created.quantity, category: created.category },
        ...meta,
      });
      return created;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw errors.conflict('RESOURCE_NAME_TAKEN', 'A resource with this name already exists');
    throw err;
  }
}

export async function updateResource(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  patch: Partial<ResourceInput>,
  meta: RequestMeta,
): Promise<Resource> {
  try {
    return await withTx(ctx.pool, async (tx) => {
      const before = await repo.getResource(tx, id, true); // same lock reservations take
      if (!before) throw errors.notFound('Resource');
      const next: ResourceInput = { ...before, ...patch };
      if (next.quantity < before.quantity) {
        // Never shrink the stock below what is already promised for the future.
        const committed = await repo.peakUsage(tx, id, new Date(), null);
        if (next.quantity < committed) {
          throw new AppError(
            409,
            'RESOURCE_IN_USE',
            `${committed} units are already reserved at the busiest time, so the total cannot go below that`,
            { committed },
          );
        }
      }
      const updated = await repo.updateResource(tx, id, next);
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'resource.updated',
        targetType: 'resource',
        targetId: id,
        metadata: { fields: Object.keys(patch) },
        ...meta,
      });
      return updated;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw errors.conflict('RESOURCE_NAME_TAKEN', 'A resource with this name already exists');
    throw err;
  }
}

export async function availability(
  ctx: AppContext,
  actor: AuthUser,
  q: { startAt: Date; endAt: Date },
) {
  const resources = await repo.listResources(ctx.pool, { includeRetired: isAdmin(actor) });
  const data = [];
  for (const resource of resources) {
    const peak = await repo.peakUsage(ctx.pool, resource.id, q.startAt, q.endAt);
    data.push({
      resource,
      inUse: peak,
      available: resource.status === 'available' ? Math.max(0, resource.quantity - peak) : 0,
    });
  }
  return { data };
}

// ---- reservations ------------------------------------------------------------------------------

export interface ReserveInput {
  eventId: string;
  resourceId: string;
  quantity: number;
  startAt?: string;
  endAt?: string;
  notes: string;
}

export async function reserve(
  ctx: AppContext,
  actor: AuthUser,
  input: ReserveInput,
  meta: RequestMeta,
): Promise<{ reservation: Reservation; created: boolean }> {
  const event = await loadEvent(ctx.pool, actor, input.eventId);
  assertCanManage(actor, event);
  assertEventReady(event);
  const startAt = input.startAt ? new Date(input.startAt) : event.startAt;
  const endAt = input.endAt ? new Date(input.endAt) : event.endAt;
  validateWindow(startAt, endAt);

  return withTx(ctx.pool, async (tx) => {
    const resource = await repo.getResource(tx, input.resourceId, true);
    if (!resource)
      throw errors.validation([{ path: 'resourceId', message: 'Resource does not exist' }]);
    if (resource.status !== 'available')
      throw errors.conflict(
        'RESOURCE_UNAVAILABLE',
        `This resource is ${resource.status} and cannot be reserved`,
      );

    const existing = await repo.findSameConfirmed(tx, {
      resourceId: resource.id,
      eventId: event.id,
      requestedBy: actor.id,
      quantity: input.quantity,
      startAt,
      endAt,
    });
    if (existing) return { reservation: existing, created: false };

    const peak = await repo.peakUsage(tx, resource.id, startAt, endAt);
    if (peak + input.quantity > resource.quantity) throw exhausted(resource, peak, input.quantity);

    const reservation = await repo.insertReservation(tx, {
      resourceId: resource.id,
      eventId: event.id,
      requestedBy: actor.id,
      quantity: input.quantity,
      startAt,
      endAt,
      notes: input.notes,
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: 'resource.reserved',
      targetType: 'resource_reservation',
      targetId: reservation.id,
      metadata: { resourceId: resource.id, eventId: event.id, quantity: input.quantity },
      ...meta,
    });
    return { reservation, created: true };
  });
}

export async function updateReservation(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  patch: { quantity?: number; startAt?: string; endAt?: string; notes?: string },
  meta: RequestMeta,
): Promise<Reservation> {
  const first = await repo.getReservation(ctx.pool, id);
  if (!first) throw errors.notFound('Reservation');
  return withTx(ctx.pool, async (tx) => {
    // Lock order is always resource first, then reservation, so concurrent changes cannot deadlock.
    const resource = await repo.getResource(tx, first.resourceId, true);
    const current = await repo.getReservation(tx, id, true);
    if (!resource || !current) throw errors.notFound('Reservation');
    const event = await loadEvent(tx, actor, current.eventId);
    if (!canSeeReservations(actor, event)) throw errors.notFound('Reservation');
    assertCanManage(actor, event);
    if (current.status !== 'confirmed')
      throw errors.conflict('RESERVATION_CLOSED', 'A released reservation cannot be changed');
    assertEventReady(event);

    const next = {
      quantity: patch.quantity ?? current.quantity,
      startAt: patch.startAt ? new Date(patch.startAt) : current.startAt,
      endAt: patch.endAt ? new Date(patch.endAt) : current.endAt,
      notes: patch.notes ?? current.notes,
    };
    if (
      next.startAt.getTime() !== current.startAt.getTime() ||
      next.endAt.getTime() !== current.endAt.getTime()
    )
      validateWindow(next.startAt, next.endAt);
    else if (next.endAt <= next.startAt) validateWindow(next.startAt, next.endAt);
    if (
      next.quantity !== current.quantity ||
      next.startAt.getTime() !== current.startAt.getTime() ||
      next.endAt.getTime() !== current.endAt.getTime()
    ) {
      if (resource.status !== 'available')
        throw errors.conflict('RESOURCE_UNAVAILABLE', `This resource is ${resource.status}`);
      const peak = await repo.peakUsage(tx, resource.id, next.startAt, next.endAt, id);
      if (peak + next.quantity > resource.quantity) throw exhausted(resource, peak, next.quantity);
    }
    await repo.updateReservation(tx, id, next);
    await recordAudit(tx, {
      actorId: actor.id,
      action: 'resource.reservation_updated',
      targetType: 'resource_reservation',
      targetId: id,
      metadata: { fields: Object.keys(patch) },
      ...meta,
    });
    return (await repo.getReservation(tx, id))!;
  });
}

export async function releaseOne(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  reason: string,
  meta: RequestMeta,
): Promise<Reservation> {
  const first = await repo.getReservation(ctx.pool, id);
  if (!first) throw errors.notFound('Reservation');
  return withTx(ctx.pool, async (tx) => {
    await repo.getResource(tx, first.resourceId, true);
    const current = await repo.getReservation(tx, id, true);
    if (!current) throw errors.notFound('Reservation');
    const event = await loadEvent(tx, actor, current.eventId);
    if (!canSeeReservations(actor, event)) throw errors.notFound('Reservation');
    assertCanManage(actor, event);
    if (current.status !== 'confirmed')
      throw errors.conflict('RESERVATION_CLOSED', 'This reservation is already released');
    await repo.releaseReservation(tx, id, reason || 'Released by organizer');
    await recordAudit(tx, {
      actorId: actor.id,
      action: 'resource.released',
      targetType: 'resource_reservation',
      targetId: id,
      metadata: { resourceId: current.resourceId, quantity: current.quantity },
      ...meta,
    });
    return (await repo.getReservation(tx, id))!;
  });
}

export async function listForEvent(ctx: AppContext, actor: AuthUser, eventId: string) {
  const event = await loadEvent(ctx.pool, actor, eventId);
  if (!canSeeReservations(actor, event)) return { data: [] };
  return { data: await repo.listForEvent(ctx.pool, eventId) };
}

/** Releases every confirmed reservation of an event. Used by the event hooks; runs in the caller's transaction. */
export async function releaseAllForEvent(
  tx: Executor,
  eventId: string,
  actorId: string,
  reason: string,
): Promise<number> {
  const held = await repo.confirmedForEvent(tx, eventId);
  for (const r of held) {
    await repo.releaseReservation(tx, r.id, reason);
    await recordAudit(tx, {
      actorId,
      action: 'resource.released',
      targetType: 'resource_reservation',
      targetId: r.id,
      metadata: { resourceId: r.resourceId, quantity: r.quantity, automatic: true },
    });
  }
  return held.length;
}
