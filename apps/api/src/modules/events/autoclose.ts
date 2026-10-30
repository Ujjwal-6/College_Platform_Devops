import type { AppContext } from '../../context.js';
import { withTx } from '../../platform/db.js';
import { eventsAutoClosed } from '../../platform/metrics.js';
import { TRANSITIONS } from './lifecycle.js';
import * as repo from './repository.js';
import { applyTransition } from './transitions.js';

const BATCH = 50;

/**
 * Closes the published events that ended at least EVENT_AUTO_CLOSE_HOURS ago. Each event closes in
 * its own transaction through the normal transition, so closing queues its report exactly as a manual
 * close does. Safe to run from several workers at once: the row lock and the status re-check make a
 * second attempt a no-op. Returns how many events this call closed.
 */
export async function closeEndedEvents(ctx: AppContext, now = new Date()): Promise<number> {
  const hours = ctx.config.EVENT_AUTO_CLOSE_HOURS;
  if (hours === 0) return 0;
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  let closed = 0;
  for (const id of await repo.listEndedPublished(ctx.pool, cutoff, BATCH)) {
    try {
      const done = await withTx(ctx.pool, async (tx) => {
        const event = await repo.getById(tx, id, true);
        if (!event || event.status !== 'published' || event.endAt > cutoff) return false;
        await applyTransition(tx, {
          event,
          action: 'close',
          to: TRANSITIONS.close.to,
          actor: null,
          meta: {},
          audit: 'event.closed',
          comment: 'Closed automatically after the event ended',
          set: { closedAt: repo.NOW },
          auditMetadata: { automatic: true },
        });
        return true;
      });
      if (done) {
        closed += 1;
        eventsAutoClosed.inc();
      }
    } catch (err) {
      // one event failing (say a hook refusing) must not stop the others; it is tried again next time
      ctx.logger.error({ err, eventId: id }, 'automatic close failed');
    }
  }
  if (closed > 0) ctx.logger.info({ closed }, 'events closed automatically');
  return closed;
}
