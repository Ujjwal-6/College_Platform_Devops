import { registerEventHook } from '../events/index.js';
import { queueReportOnClose } from './service.js';

let registered = false;

/**
 * Queues the post-event report when an event closes, inside the closing transaction: if the close is
 * rolled back, no report and no job exist (and closing never waits for the PDF). Called from
 * createApp; safe to call many times, installed once.
 */
export function registerReportHooks(): void {
  if (registered) return;
  registered = true;
  registerEventHook(async (tx, { event, action }) => {
    if (action === 'close') await queueReportOnClose(tx, event.id);
  });
}
