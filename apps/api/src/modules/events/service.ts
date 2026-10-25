import type { PoolClient } from 'pg';
import type { AppContext } from '../../context.js';
import { isForeignKeyViolation, withTx } from '../../platform/db.js';
import { AppError, errors } from '../../platform/errors.js';
import type { RequestMeta } from '../audit/audit.js';
import { recordAudit } from '../audit/audit.js';
import { checkRange } from '../calendar/service.js';
import type { AuthUser } from '../auth/types.js';
import { assertApprovable, notifyApprovers } from '../approvals/service.js';
import { checkApprover } from '../approvals/policy.js';
import * as approvalsRepo from '../approvals/repository.js';
import { notify } from '../notifications/notify.js';
import * as usersRepo from '../users/repository.js';
import {
  canCreateEvents,
  canView,
  canViewWorkflow,
  isAdmin,
  isEligibleForRegistration,
  isOwner,
  MATERIAL_FIELDS,
  TRANSITIONS,
} from './lifecycle.js';
import * as repo from './repository.js';
import { type createEventSchema, type updateEventSchema, validateShape } from './schemas.js';
import { applyTransition } from './transitions.js';
import type { ApprovalLevel, EventAction, EventRecord, Speaker } from './types.js';
import type { z } from 'zod';

type CreateBody = z.infer<typeof createEventSchema>;
type UpdateBody = z.infer<typeof updateEventSchema>;

const eventUrl = (ctx: AppContext, id: string) => `${ctx.config.WEB_BASE_URL}/events/${id}`;

// ---- shared guards -----------------------------------------------------------------------------

/** Locks the event and hides it (404) from anyone who may not see it. */
async function lockVisible(tx: PoolClient, actor: AuthUser, id: string): Promise<EventRecord> {
  const event = await repo.getById(tx, id, true);
  if (!event || !canView(actor, event)) throw errors.notFound('Event');
  return event;
}

function assertOwner(actor: AuthUser, event: EventRecord): void {
  if (!isOwner(actor, event)) throw errors.forbidden('Only the event organizer can do this');
}
function assertOwnerOrAdmin(actor: AuthUser, event: EventRecord): void {
  if (!isOwner(actor, event) && !isAdmin(actor))
    throw errors.forbidden('Only the organizer or an administrator can do this');
}

/** 409 unless `action` is allowed from the event's current state (see TRANSITIONS). */
function assertCanTransition(event: EventRecord, action: keyof typeof TRANSITIONS): void {
  const allowed: readonly string[] = TRANSITIONS[action].from;
  if (!allowed.includes(event.status)) {
    throw errors.conflict(
      'INVALID_TRANSITION',
      `Cannot ${action} an event that is ${event.status}`,
    );
  }
}

function notInPast(date: Date, path: string): void {
  if (date.getTime() <= Date.now())
    throw errors.validation([{ path, message: 'Must be in the future' }]);
}

// ---- reading -----------------------------------------------------------------------------------

export interface EventActions {
  canEdit: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canRevise: boolean;
  canPublish: boolean;
  canUnpublish: boolean;
  canCancel: boolean;
  canClose: boolean;
  canApprove: boolean;
}

function actionsFor(actor: AuthUser, e: EventRecord, decided: ReadonlySet<string>): EventActions {
  const owner = isOwner(actor, e);
  const ownerOrAdmin = owner || isAdmin(actor);
  const canDecide =
    e.status === 'pending_approval' &&
    e.approvalLevel !== null &&
    checkApprover(actor, e, e.approvalLevel, decided).ok;
  return {
    canEdit: owner && (e.status === 'draft' || e.status === 'approved' || e.status === 'published'),
    canSubmit: owner && e.status === 'draft',
    canWithdraw: owner && e.status === 'pending_approval',
    canRevise: owner && (e.status === 'approved' || e.status === 'published'),
    canPublish: ownerOrAdmin && e.status === 'approved',
    canUnpublish: ownerOrAdmin && e.status === 'published',
    canCancel: ownerOrAdmin && (TRANSITIONS.cancel.from as readonly string[]).includes(e.status),
    canClose: ownerOrAdmin && e.status === 'published' && Date.now() >= e.endAt.getTime(),
    canApprove: canDecide, // approving and rejecting share the same eligibility
  };
}

function present(actor: AuthUser, e: EventRecord, organizerName: string | undefined) {
  const workflow = canViewWorkflow(actor, e);
  return {
    ...e,
    organizerName: organizerName ?? null,
    // Internal workflow details are hidden from people who only see the public event.
    calendarWarnings: workflow ? e.calendarWarnings : [],
    lastRejection: workflow ? e.lastRejection : null,
    cancelReason: workflow || e.status === 'cancelled' ? e.cancelReason : null,
    registrationEligible: isEligibleForRegistration(e),
  };
}

export async function getEventDetail(ctx: AppContext, actor: AuthUser, id: string) {
  const e = await repo.getById(ctx.pool, id);
  if (!e || !canView(actor, e)) throw errors.notFound('Event');
  return buildDetail(ctx, actor, e);
}

async function buildDetail(ctx: AppContext, actor: AuthUser, e: EventRecord) {
  const decided = await approvalsRepo.decidersInRound(ctx.pool, e.id, e.submissionRound);
  const speakers = await repo.getSpeakers(ctx.pool, e.id);
  const workflowVisible = canViewWorkflow(actor, e);

  let workflow: unknown = null;
  let organizerName: string | undefined;
  if (workflowVisible) {
    const approvals = await approvalsRepo.listForEvent(ctx.pool, e.id);
    const history = await repo.getHistory(ctx.pool, e.id);
    const names = await usersRepo.getNames(ctx.pool, [
      e.organizerId,
      ...approvals.map((a) => a.approverId),
      ...history.flatMap((h) => (h.actorId ? [h.actorId] : [])),
    ]);
    workflow = {
      approvals: approvals.map((a) => ({ ...a, approverName: names.get(a.approverId) ?? null })),
      history: history.map((h) => ({
        ...h,
        actorName: h.actorId ? (names.get(h.actorId) ?? null) : null,
      })),
    };
    organizerName = names.get(e.organizerId);
  } else {
    organizerName = (await usersRepo.getNames(ctx.pool, [e.organizerId])).get(e.organizerId);
  }

  // Live calendar check while the date can still change or matter; completed events no longer need it.
  const calendar =
    e.status === 'closed' || e.status === 'cancelled'
      ? null
      : await checkRange(ctx.pool, ctx.config.APP_TIMEZONE, {
          startAt: e.startAt,
          endAt: e.endAt,
          departmentId: e.departmentId,
        });

  return {
    ...present(actor, e, organizerName),
    speakers,
    workflow,
    calendar: workflowVisible ? calendar : null,
    actions: actionsFor(actor, e, decided),
    materialFields: MATERIAL_FIELDS,
  };
}

export async function listEvents(
  ctx: AppContext,
  actor: AuthUser,
  q: {
    scope: 'published' | 'mine' | 'department' | 'approvals';
    status?: EventRecord['status'];
    limit: number;
    offset: number;
  },
) {
  const paging = { limit: q.limit, offset: q.offset };
  let filter: repo.ListFilter;
  switch (q.scope) {
    case 'published':
      filter = { ...paging, statuses: ['published'], order: 'start_asc' };
      break;
    case 'mine':
      filter = {
        ...paging,
        organizerId: actor.id,
        statuses: q.status ? [q.status] : undefined,
        order: 'created_desc',
      };
      break;
    case 'department': {
      if (isAdmin(actor)) {
        filter = { ...paging, statuses: q.status ? [q.status] : undefined, order: 'start_desc' };
      } else if (actor.departmentId && actor.roles.some((r) => r === 'faculty' || r === 'hod')) {
        filter = {
          ...paging,
          departmentId: actor.departmentId,
          statuses: q.status ? [q.status] : undefined,
          excludeStatuses: ['draft'],
          order: 'start_desc',
        };
      } else {
        throw errors.forbidden();
      }
      break;
    }
    case 'approvals': {
      const levels: { level: ApprovalLevel; departmentId: string | null }[] = [];
      if (actor.departmentId && actor.roles.includes('faculty'))
        levels.push({ level: 'faculty', departmentId: actor.departmentId });
      if (actor.departmentId && actor.roles.includes('hod'))
        levels.push({ level: 'hod', departmentId: actor.departmentId });
      if (actor.roles.includes('admin')) levels.push({ level: 'admin', departmentId: null });
      if (levels.length === 0) throw errors.forbidden();
      filter = { ...paging, queue: { actorId: actor.id, levels }, order: 'submitted_asc' };
      break;
    }
  }
  const { rows, total } = await repo.list(ctx.pool, filter);
  const names = await usersRepo.getNames(ctx.pool, [...new Set(rows.map((r) => r.organizerId))]);
  return {
    data: rows.map((e) => present(actor, e, names.get(e.organizerId))),
    page: { limit: q.limit, offset: q.offset, total },
  };
}

// ---- create / edit -----------------------------------------------------------------------------

function toSpeakers(list: CreateBody['speakers']): Speaker[] {
  return list.map((s) => ({
    name: s.name,
    designation: s.designation ?? null,
    organization: s.organization ?? null,
  }));
}

/** Non-admins may only use their own department. Admins must name one. */
function resolveDepartment(actor: AuthUser, requested: string | undefined): string {
  if (isAdmin(actor)) {
    if (!requested)
      throw errors.validation([{ path: 'departmentId', message: 'Choose a department' }]);
    return requested;
  }
  if (!actor.departmentId) {
    throw errors.conflict(
      'NO_DEPARTMENT',
      'Your account has no department yet; ask an administrator to assign one',
    );
  }
  if (requested && requested !== actor.departmentId)
    throw errors.forbidden('You can only manage events of your own department');
  return actor.departmentId;
}

export async function createEvent(
  ctx: AppContext,
  actor: AuthUser,
  body: CreateBody,
  meta: RequestMeta,
) {
  if (!canCreateEvents(actor)) throw errors.forbidden('Your role cannot create events');
  const departmentId = resolveDepartment(actor, body.departmentId);
  const startAt = new Date(body.startAt);
  const endAt = new Date(body.endAt);
  const registrationDeadline = body.registrationDeadline
    ? new Date(body.registrationDeadline)
    : null;
  const issues = validateShape({
    startAt,
    endAt,
    registrationMode: body.registrationMode,
    teamSizeMin: body.teamSizeMin,
    teamSizeMax: body.teamSizeMax,
    registrationDeadline,
  });
  if (issues.length) throw errors.validation(issues);

  try {
    const event = await withTx(ctx.pool, async (tx) => {
      const created = await repo.insert(tx, {
        title: body.title,
        description: body.description,
        category: body.category,
        departmentId,
        organizerId: actor.id,
        startAt,
        endAt,
        expectedAttendance: body.expectedAttendance,
        capacity: body.capacity,
        registrationMode: body.registrationMode,
        teamSizeMin: body.teamSizeMin,
        teamSizeMax: body.teamSizeMax,
        registrationDeadline,
      });
      await repo.replaceSpeakers(tx, created.id, toSpeakers(body.speakers));
      await repo.addHistory(tx, {
        eventId: created.id,
        action: 'create',
        actorId: actor.id,
        toStatus: 'draft',
      });
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'event.created',
        targetType: 'event',
        targetId: created.id,
        metadata: { departmentId },
        ...meta,
      });
      return created;
    });
    return await getEventDetail(ctx, actor, event.id);
  } catch (err) {
    if (isForeignKeyViolation(err))
      throw errors.validation([{ path: 'departmentId', message: 'Department does not exist' }]);
    throw err;
  }
}

const sameValue = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

export async function updateEvent(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  patch: UpdateBody,
  meta: RequestMeta,
) {
  try {
    await withTx(ctx.pool, async (tx) => {
      const event = await lockVisible(tx, actor, id);
      assertOwner(actor, event);
      if (event.status === 'pending_approval') {
        throw errors.conflict(
          'EVENT_LOCKED',
          'This event is waiting for approval. Withdraw it to make changes',
        );
      }
      if (event.status === 'closed' || event.status === 'cancelled') {
        throw errors.conflict('EVENT_LOCKED', `A ${event.status} event cannot be edited`);
      }

      const next = {
        title: patch.title ?? event.title,
        description: patch.description ?? event.description,
        category: patch.category ?? event.category,
        departmentId:
          patch.departmentId === undefined
            ? event.departmentId
            : resolveDepartment(actor, patch.departmentId),
        startAt: patch.startAt ? new Date(patch.startAt) : event.startAt,
        endAt: patch.endAt ? new Date(patch.endAt) : event.endAt,
        expectedAttendance: patch.expectedAttendance ?? event.expectedAttendance,
        capacity: patch.capacity === undefined ? event.capacity : patch.capacity,
        registrationMode: patch.registrationMode ?? event.registrationMode,
        teamSizeMin: patch.teamSizeMin === undefined ? event.teamSizeMin : patch.teamSizeMin,
        teamSizeMax: patch.teamSizeMax === undefined ? event.teamSizeMax : patch.teamSizeMax,
        registrationDeadline:
          patch.registrationDeadline === undefined
            ? event.registrationDeadline
            : patch.registrationDeadline
              ? new Date(patch.registrationDeadline)
              : null,
      };
      // Switching to individual mode drops team sizes unless the caller sent them explicitly.
      if (
        next.registrationMode === 'individual' &&
        patch.registrationMode &&
        patch.teamSizeMin === undefined &&
        patch.teamSizeMax === undefined
      ) {
        next.teamSizeMin = null;
        next.teamSizeMax = null;
      }
      const issues = validateShape(next);
      if (issues.length) throw errors.validation(issues);

      if (event.status !== 'draft') {
        const changedMaterial = MATERIAL_FIELDS.filter((f) => !sameValue(next[f], event[f]));
        if (changedMaterial.length) {
          throw new AppError(
            409,
            'MATERIAL_CHANGE_REQUIRES_REVISION',
            'Changing these fields needs a new approval. Use "Revise" to return the event to draft first',
            { fields: changedMaterial },
          );
        }
      }

      const scalarKeys = [
        'title',
        'description',
        'category',
        'departmentId',
        'startAt',
        'endAt',
        'expectedAttendance',
        'capacity',
        'registrationMode',
        'teamSizeMin',
        'teamSizeMax',
        'registrationDeadline',
      ] as const;
      const changed: string[] = scalarKeys.filter((k) => !sameValue(next[k], event[k]));
      if (patch.speakers) changed.push('speakers');
      await repo.patch(tx, id, {
        title: next.title,
        description: next.description,
        category: next.category,
        departmentId: next.departmentId,
        startAt: next.startAt,
        endAt: next.endAt,
        expectedAttendance: next.expectedAttendance,
        capacity: next.capacity,
        registrationMode: next.registrationMode,
        teamSizeMin: next.teamSizeMin,
        teamSizeMax: next.teamSizeMax,
        registrationDeadline: next.registrationDeadline,
      });
      if (patch.speakers) await repo.replaceSpeakers(tx, id, toSpeakers(patch.speakers));
      await repo.addHistory(tx, {
        eventId: id,
        action: 'update',
        actorId: actor.id,
        fromStatus: event.status,
        toStatus: event.status,
        comment: changed.join(', '),
      });
      await recordAudit(tx, {
        actorId: actor.id,
        action: 'event.updated',
        targetType: 'event',
        targetId: id,
        metadata: { fields: changed, status: event.status },
        ...meta,
      });
    });
  } catch (err) {
    if (isForeignKeyViolation(err))
      throw errors.validation([{ path: 'departmentId', message: 'Department does not exist' }]);
    throw err;
  }
  return getEventDetail(ctx, actor, id);
}

// ---- lifecycle actions -------------------------------------------------------------------------

export async function submitEvent(ctx: AppContext, actor: AuthUser, id: string, meta: RequestMeta) {
  await withTx(ctx.pool, async (tx) => {
    const event = await lockVisible(tx, actor, id);
    assertOwner(actor, event);
    assertCanTransition(event, 'submit');
    notInPast(event.startAt, 'startAt');

    // Academic calendar guard: hard conflicts refuse the submission, soft ones travel with it to the approvers.
    const check = await checkRange(tx, ctx.config.APP_TIMEZONE, {
      startAt: event.startAt,
      endAt: event.endAt,
      departmentId: event.departmentId,
    });
    if (check.blocks.length) {
      throw new AppError(
        422,
        'CALENDAR_BLOCKED',
        'The event dates fall on restricted academic dates',
        { entries: check.blocks },
      );
    }
    await assertApprovable(tx, event);

    const updated = await applyTransition(tx, {
      event,
      action: 'submit',
      to: 'pending_approval',
      actor,
      meta,
      audit: 'event.submitted',
      set: {
        approvalLevel: 'faculty',
        submissionRound: event.submissionRound + 1,
        submittedAt: repo.NOW,
        calendarWarnings: check.warnings.map((w) => ({
          id: w.id,
          type: w.type,
          title: w.title,
          startDate: w.startDate,
          endDate: w.endDate,
        })),
        lastRejectionLevel: null,
        lastRejectionComment: null,
        lastRejectedBy: null,
        lastRejectedAt: null,
      },
      auditMetadata: { round: event.submissionRound + 1, warnings: check.warnings.length },
    });
    await notifyApprovers(ctx, tx, updated, 'faculty');
  });
  return getEventDetail(ctx, actor, id);
}

interface SimpleAction {
  action: Extract<
    EventAction,
    'withdraw' | 'revise' | 'publish' | 'unpublish' | 'cancel' | 'close'
  >;
  audit: Parameters<typeof applyTransition>[1]['audit'];
  who: 'owner' | 'ownerOrAdmin';
  set?: Partial<repo.EventColumns>;
}

const SIMPLE: Record<SimpleAction['action'], SimpleAction> = {
  withdraw: { action: 'withdraw', audit: 'event.withdrawn', who: 'owner' },
  revise: {
    action: 'revise',
    audit: 'event.revised',
    who: 'owner',
    set: { approvedAt: null, publishedAt: null },
  },
  publish: {
    action: 'publish',
    audit: 'event.published',
    who: 'ownerOrAdmin',
    set: { publishedAt: repo.NOW },
  },
  unpublish: {
    action: 'unpublish',
    audit: 'event.unpublished',
    who: 'ownerOrAdmin',
    set: { publishedAt: null },
  },
  cancel: {
    action: 'cancel',
    audit: 'event.cancelled',
    who: 'ownerOrAdmin',
    set: { cancelledAt: repo.NOW },
  },
  close: {
    action: 'close',
    audit: 'event.closed',
    who: 'ownerOrAdmin',
    set: { closedAt: repo.NOW },
  },
};

export async function runAction(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  name: SimpleAction['action'],
  input: { comment?: string },
  meta: RequestMeta,
) {
  const def = SIMPLE[name];
  await withTx(ctx.pool, async (tx) => {
    const event = await lockVisible(tx, actor, id);
    if (def.who === 'owner') assertOwner(actor, event);
    else assertOwnerOrAdmin(actor, event);

    // Closing twice is a no-op, not an error.
    if (name === 'close' && event.status === 'closed') return;
    assertCanTransition(event, name);

    if (name === 'publish') notInPast(event.startAt, 'startAt');
    if (name === 'close' && Date.now() < event.endAt.getTime()) {
      throw errors.conflict('EVENT_NOT_ENDED', 'An event can be closed only after it has ended');
    }
    if (name === 'cancel' && !input.comment)
      throw errors.validation([
        { path: 'comment', message: 'A reason is required to cancel an event' },
      ]);

    const updated = await applyTransition(tx, {
      event,
      action: def.action,
      to: TRANSITIONS[name].to,
      actor,
      meta,
      audit: def.audit,
      comment: input.comment ?? null,
      set: { ...def.set, ...(name === 'cancel' ? { cancelReason: input.comment } : {}) },
    });

    if (name === 'cancel' && !isOwner(actor, event)) {
      const organizer = await tx.query('SELECT name, email FROM users WHERE id = $1', [
        event.organizerId,
      ]);
      await notify(tx, {
        type: 'event.cancelled',
        to: organizer.rows[0].email as string,
        data: {
          name: organizer.rows[0].name as string,
          eventTitle: updated.title,
          cancelledBy: actor.name,
          reason: input.comment ?? '',
          url: eventUrl(ctx, id),
        },
        key: `event.cancelled:${id}`,
      });
    }
  });
  return getEventDetail(ctx, actor, id);
}
