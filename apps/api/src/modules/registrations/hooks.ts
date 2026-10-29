import type { AppContext } from '../../context.js';
import { errors } from '../../platform/errors.js';
import { recordAudit } from '../audit/audit.js';
import { registerEventHook } from '../events/index.js';
import { notify } from '../notifications/notify.js';
import * as usersRepo from '../users/repository.js';
import * as repo from './repository.js';

let registered = false;
let latestCtx: AppContext;

/**
 * Connects registrations to the event lifecycle (see docs/event-contract.md). Called from createApp;
 * safe to call many times (tests build many apps), the hook is installed once.
 *
 *  - event cancelled: every registration is cancelled and every team dissolved, in the same
 *    transaction, and each registrant is emailed;
 *  - event unpublished or sent back for revision while people are registered: refused (409), because
 *    those actions close registration or change what people signed up for. Cancel the event instead.
 */
export function registerRegistrationHooks(ctx: AppContext): void {
  latestCtx = ctx;
  if (registered) return;
  registered = true;
  registerEventHook(async (tx, { event, action, actorId }) => {
    if (action === 'unpublish' || action === 'revise') {
      if ((await repo.countRegistered(tx, event.id)) > 0) {
        throw errors.conflict(
          'EVENT_HAS_REGISTRATIONS',
          'People are registered for this event. Cancel the event instead, or ask them to cancel first.',
        );
      }
    }
    if (action !== 'cancel') return;

    const cancelled = await repo.cancelAllForEvent(tx, event.id, 'event_cancelled');
    await repo.dissolveTeamsForEvent(tx, event.id);
    const contacts = await usersRepo.getContacts(
      tx,
      cancelled.map((r) => r.userId),
    );
    const byId = new Map(contacts.map((c) => [c.id, c]));
    for (const reg of cancelled) {
      await recordAudit(tx, {
        actorId,
        action: 'registration.cancelled',
        targetType: 'registration',
        targetId: reg.id,
        metadata: { eventId: event.id, reason: 'event_cancelled' },
      });
      const person = byId.get(reg.userId);
      if (!person) continue;
      await notify(tx, {
        type: 'registration.event_cancelled',
        to: person.email,
        data: {
          name: person.name,
          eventTitle: event.title,
          url: `${latestCtx.config.WEB_BASE_URL}/events/${event.id}`,
        },
        key: `registration:${reg.id}:event_cancelled`,
      });
    }
  });
}
