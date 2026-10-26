import type { AppContext } from '../../context.js';
import { recordAudit } from '../audit/audit.js';
import { registerEventHook } from '../events/index.js';
import { releaseAllForEvent } from '../resources/service.js';
import * as repo from './repository.js';
import { notifyCancelled } from './service.js';

let registered = false;
let latestCtx: AppContext;

/**
 * Connects hall bookings and resource reservations to the event lifecycle (see docs/event-contract.md).
 * Called from createApp; safe to call many times (tests build many apps), the hook is installed once.
 *
 *  - event cancelled: every active hall booking is cancelled and every resource reservation released,
 *    in the same transaction as the cancellation;
 *  - event sent back to draft for revision: resource reservations are released, because resources are
 *    only held for approved events. Hall bookings are independent of event approval and stay;
 *  - event submitted or revised: the department/organizer copied onto its bookings is refreshed, so
 *    approval queues stay correct if the event changed department while in draft.
 */
export function registerBookingHooks(ctx: AppContext): void {
  latestCtx = ctx;
  if (registered) return;
  registered = true;
  registerEventHook(async (tx, { event, action, actorId }) => {
    if (action === 'cancel') {
      for (const b of await repo.activeForEvent(tx, event.id)) {
        await repo.patch(tx, b.id, {
          status: 'cancelled',
          approvalLevel: null,
          closingComment: 'The event was cancelled',
          decidedAt: 'now',
        });
        await repo.addHistory(tx, {
          bookingId: b.id,
          action: 'cancel',
          actorId,
          fromStatus: b.status,
          toStatus: 'cancelled',
          comment: 'The event was cancelled',
        });
        await recordAudit(tx, {
          actorId,
          action: 'booking.cancelled',
          targetType: 'booking',
          targetId: b.id,
          metadata: { from: b.status, reason: 'event_cancelled' },
        });
        if (actorId !== event.organizerId)
          await notifyCancelled(
            latestCtx,
            tx,
            b,
            'the administrator who cancelled the event',
            'The event was cancelled',
          );
      }
      await releaseAllForEvent(tx, event.id, actorId, 'The event was cancelled');
    }
    if (action === 'revise') {
      await releaseAllForEvent(
        tx,
        event.id,
        actorId,
        'The event was sent back to draft for revision',
      );
    }
    if (action === 'submit' || action === 'revise') {
      await tx.query(
        `UPDATE hall_bookings SET department_id = $2, event_organizer_id = $3, updated_at = now()
          WHERE event_id = $1 AND (department_id <> $2 OR event_organizer_id <> $3)`,
        [event.id, event.departmentId, event.organizerId],
      );
    }
  });
}
