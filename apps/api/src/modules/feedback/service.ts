import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isUniqueViolation, withTx, type Executor } from '../../platform/db.js';
import { AppError, errors } from '../../platform/errors.js';
import { getAttendanceForRegistration } from '../attendance/index.js';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import type { AuthUser } from '../auth/types.js';
import { canView, canViewWorkflow, getEventById, type EventRecord } from '../events/index.js';
import { getRegistrationForUser } from '../registrations/index.js';
import * as repo from './repository.js';

/** Feedback opens when the event ends and stays open for 14 days (assumption F-2). */
const OPEN_FOR_MS = 14 * 86_400_000;

export const submitSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .strict();

async function loadEvent(db: Executor, user: AuthUser, eventId: string): Promise<EventRecord> {
  const event = await getEventById(db, eventId);
  if (!event || !canView(user, event)) throw errors.notFound('Event');
  return event;
}

const window = (e: EventRecord) => ({
  opensAt: e.endAt,
  closesAt: new Date(e.endAt.getTime() + OPEN_FOR_MS),
});
const isOpen = (e: EventRecord, now = new Date()) => {
  const { opensAt, closesAt } = window(e);
  return (e.status === 'published' || e.status === 'closed') && now >= opensAt && now < closesAt;
};

/** Only a person who was checked in (any way, even if they left early) can give feedback. */
async function wasCheckedIn(db: Executor, eventId: string, userId: string): Promise<boolean> {
  const reg = await getRegistrationForUser(db, eventId, userId);
  return !!reg && !!(await getAttendanceForRegistration(db, reg.id));
}

export async function mine(ctx: AppContext, user: AuthUser, eventId: string) {
  const event = await loadEvent(ctx.pool, user, eventId);
  const { opensAt, closesAt } = window(event);
  return {
    eligible: await wasCheckedIn(ctx.pool, eventId, user.id),
    submitted: await repo.exists(ctx.pool, eventId, user.id),
    open: isOpen(event),
    opensAt: opensAt.toISOString(),
    closesAt: closesAt.toISOString(),
  };
}

export async function submit(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  input: z.infer<typeof submitSchema>,
  meta: RequestMeta,
): Promise<{ submitted: true }> {
  return withTx(ctx.pool, async (tx) => {
    const event = await loadEvent(tx, user, eventId);
    if (!(await wasCheckedIn(tx, eventId, user.id))) {
      throw new AppError(
        403,
        'FEEDBACK_ATTENDEES_ONLY',
        'Only people who were checked in at the event can give feedback',
      );
    }
    if (!isOpen(event)) {
      const { opensAt, closesAt } = window(event);
      throw new AppError(409, 'FEEDBACK_CLOSED', 'Feedback is not open for this event right now', {
        opensAt: opensAt.toISOString(),
        closesAt: closesAt.toISOString(),
      });
    }
    try {
      await repo.insert(tx, {
        eventId,
        userId: user.id,
        rating: input.rating,
        comment: input.comment,
      });
    } catch (err) {
      if (isUniqueViolation(err, 'feedback_event_user_key')) {
        throw errors.conflict(
          'ALREADY_SUBMITTED',
          'You have already given feedback for this event',
        );
      }
      throw err;
    }
    // The audit record says that feedback was given, never what it said or what rating it was.
    await recordAudit(tx, {
      actorId: user.id,
      action: 'feedback.submitted',
      targetType: 'event',
      targetId: eventId,
      ...meta,
    });
    return { submitted: true as const };
  });
}

/** For the event's organizer, its department's faculty/HOD and admins. Never says who wrote anything. */
export async function results(ctx: AppContext, user: AuthUser, eventId: string) {
  const event = await loadEvent(ctx.pool, user, eventId);
  if (!canViewWorkflow(user, event)) throw errors.forbidden();
  return {
    summary: await repo.summary(ctx.pool, eventId),
    comments: await repo.comments(ctx.pool, eventId),
  };
}
