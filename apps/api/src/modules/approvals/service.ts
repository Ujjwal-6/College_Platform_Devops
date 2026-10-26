import type { PoolClient } from 'pg';
import type { AppContext } from '../../context.js';
import { isUniqueViolation, withTx } from '../../platform/db.js';
import { AppError, errors } from '../../platform/errors.js';
import type { RequestMeta } from '../audit/audit.js';
import type { AuthUser } from '../auth/types.js';
import { applyTransition } from '../events/transitions.js';
import { canView } from '../events/lifecycle.js';
import * as events from '../events/repository.js';
import type { ApprovalLevel, EventRecord } from '../events/types.js';
import { notify } from '../notifications/notify.js';
import * as users from '../users/repository.js';
import * as repo from './repository.js';
import {
  canCompleteWorkflow,
  checkApprover,
  NEXT_LEVEL,
  ROLE_FOR_LEVEL,
  LEVEL_IS_DEPARTMENT_SCOPED,
  type DenyReason,
} from './policy.js';

const eventUrl = (ctx: AppContext, id: string) => `${ctx.config.WEB_BASE_URL}/events/${id}`;

/** Active people who could decide `level` for this event (never the organizer). */
async function candidates(db: PoolClient, event: EventRecord, level: ApprovalLevel) {
  const list = await users.listActiveByRole(
    db,
    ROLE_FOR_LEVEL[level],
    LEVEL_IS_DEPARTMENT_SCOPED[level] ? event.departmentId : null,
  );
  return list.filter((u) => u.id !== event.organizerId);
}

/**
 * Called when an event is submitted. Refuses submission when the workflow could never finish
 * (a level has nobody who may decide it, or the same few people would have to decide two levels).
 */
export async function assertApprovable(tx: PoolClient, event: EventRecord): Promise<void> {
  const faculty = await candidates(tx, event, 'faculty');
  const hod = await candidates(tx, event, 'hod');
  const admin = await candidates(tx, event, 'admin');
  const missing = (
    [
      ['faculty', faculty],
      ['hod', hod],
      ['admin', admin],
    ] as const
  )
    .filter(([, list]) => list.length === 0)
    .map(([level]) => level);
  if (missing.length > 0) {
    throw new AppError(
      409,
      'NO_APPROVER_AVAILABLE',
      `No eligible ${missing.join(' / ')} approver is available for this event`,
      { levels: missing },
    );
  }
  if (
    !canCompleteWorkflow(
      faculty.map((u) => u.id),
      hod.map((u) => u.id),
      admin.map((u) => u.id),
    )
  ) {
    throw new AppError(
      409,
      'NO_APPROVER_AVAILABLE',
      'The approval levels would need the same person twice; ask an administrator to add another approver',
      {
        levels: [],
      },
    );
  }
}

/** Emails everyone who can decide `level` right now. One idempotent job per recipient and round. */
export async function notifyApprovers(
  ctx: AppContext,
  tx: PoolClient,
  event: EventRecord,
  level: ApprovalLevel,
): Promise<void> {
  const decided = await repo.decidersInRound(tx, event.id, event.submissionRound);
  const organizer =
    (await users.getNames(tx, [event.organizerId])).get(event.organizerId) ?? 'The organizer';
  for (const person of await candidates(tx, event, level)) {
    if (decided.has(person.id)) continue;
    await notify(tx, {
      type: 'event.approval_requested',
      to: person.email,
      data: {
        name: person.name,
        eventTitle: event.title,
        level,
        organizerName: organizer,
        url: eventUrl(ctx, event.id),
      },
      key: `event.approval_requested:${event.id}:${event.submissionRound}:${level}:${person.id}`,
    });
  }
}

const DENY: Record<DenyReason, { status: number; code: string; message: string }> = {
  wrong_role: {
    status: 403,
    code: 'FORBIDDEN',
    message: 'You do not hold the role required for this approval level',
  },
  wrong_department: {
    status: 403,
    code: 'FORBIDDEN',
    message: 'This event belongs to another department',
  },
  own_event: { status: 403, code: 'SELF_APPROVAL', message: 'You cannot decide your own event' },
  already_decided: {
    status: 409,
    code: 'ALREADY_DECIDED',
    message: 'You have already decided another level of this submission',
  },
};

export interface DecisionInput {
  decision: 'approved' | 'rejected';
  level: ApprovalLevel;
  comment?: string;
}

/**
 * Records an approval or rejection. The event row is locked first, so concurrent decisions on one
 * event are processed one at a time; the second sees the state left by the first and is refused.
 * `input.level` is the level the user was looking at: a mismatch means the screen was stale (409).
 */
export async function decide(
  ctx: AppContext,
  actor: AuthUser,
  eventId: string,
  input: DecisionInput,
  meta: RequestMeta,
): Promise<EventRecord> {
  try {
    return await withTx(ctx.pool, async (tx) => {
      const event = await events.getById(tx, eventId, true);
      if (!event || !canView(actor, event)) throw errors.notFound('Event');
      if (event.status !== 'pending_approval' || !event.approvalLevel) {
        throw errors.conflict(
          'INVALID_TRANSITION',
          `This event is not waiting for approval (status: ${event.status})`,
        );
      }
      if (event.approvalLevel !== input.level) {
        throw errors.conflict(
          'STALE_DECISION',
          `This event is now waiting for ${event.approvalLevel} approval, not ${input.level}`,
        );
      }

      const decided = await repo.decidersInRound(tx, event.id, event.submissionRound);
      const verdict = checkApprover(actor, event, event.approvalLevel, decided);
      if (!verdict.ok) {
        const d = DENY[verdict.reason];
        throw new AppError(d.status, d.code, d.message);
      }

      await repo.insertDecision(tx, {
        eventId: event.id,
        round: event.submissionRound,
        level: event.approvalLevel,
        decision: input.decision,
        approverId: actor.id,
        comment: input.comment || null,
      });

      const organizer = await users.getNames(tx, [event.organizerId, actor.id]);
      const organizerName = organizer.get(event.organizerId) ?? 'Organizer';
      const organizerEmail = (
        await tx.query('SELECT email FROM users WHERE id = $1', [event.organizerId])
      ).rows[0]?.email as string;
      const base = {
        name: organizerName,
        eventTitle: event.title,
        level: event.approvalLevel,
        approverName: organizer.get(actor.id) ?? 'An approver',
        comment: input.comment ?? '',
        url: eventUrl(ctx, event.id),
      };
      const round = event.submissionRound;

      if (input.decision === 'rejected') {
        const updated = await applyTransition(tx, {
          event,
          action: 'reject',
          to: 'draft',
          actor,
          meta,
          audit: 'event.approval_rejected',
          level: event.approvalLevel,
          comment: input.comment,
          set: {
            lastRejectionLevel: event.approvalLevel,
            lastRejectionComment: input.comment ?? '',
            lastRejectedBy: actor.id,
            lastRejectedAt: events.NOW,
          },
        });
        await notify(tx, {
          type: 'event.decision',
          to: organizerEmail,
          data: { ...base, decision: 'rejected' },
          key: `event.decision:${event.id}:${round}:${event.approvalLevel}`,
        });
        return updated;
      }

      const next = NEXT_LEVEL[event.approvalLevel];
      if (next) {
        const updated = await applyTransition(tx, {
          event,
          action: 'approve',
          to: 'pending_approval',
          actor,
          meta,
          audit: 'event.approval_granted',
          level: event.approvalLevel,
          comment: input.comment,
          set: { approvalLevel: next },
        });
        await notify(tx, {
          type: 'event.decision',
          to: organizerEmail,
          data: { ...base, decision: 'approved' },
          key: `event.decision:${event.id}:${round}:${event.approvalLevel}`,
        });
        await notifyApprovers(ctx, tx, updated, next);
        return updated;
      }

      const updated = await applyTransition(tx, {
        event,
        action: 'approve',
        to: 'approved',
        actor,
        meta,
        audit: 'event.approval_granted',
        level: event.approvalLevel,
        comment: input.comment,
        auditMetadata: { final: true },
        set: { approvedAt: events.NOW },
      });
      await notify(tx, {
        type: 'event.decision',
        to: organizerEmail,
        data: { ...base, decision: 'fully_approved' },
        key: `event.decision:${event.id}:${round}:${event.approvalLevel}`,
      });
      return updated;
    });
  } catch (err) {
    // Backstop: the unique constraints reject a duplicate level or a repeat approver even if a code path misses it.
    if (isUniqueViolation(err))
      throw errors.conflict('ALREADY_DECIDED', 'This approval level was already decided');
    throw err;
  }
}
