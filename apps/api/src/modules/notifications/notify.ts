import type { Executor } from '../../platform/db.js';
import { enqueue } from '../../platform/jobs/queue.js';
import { PermanentJobError, type JobWorker } from '../../platform/jobs/worker.js';
import type { Mailer } from '../../platform/mailer.js';
import {
  renderNotification,
  validateNotificationData,
  type NotificationType,
} from './templates.js';

export const EMAIL_JOB = 'email.send';

/**
 * Queues an email notification. Call it with the business transaction's client so the email is only
 * sent if the change commits. `key` makes it idempotent (e.g. `approval:${id}:requested`).
 */
export async function notify(
  db: Executor,
  n: { type: NotificationType; to: string; data: Record<string, unknown>; key?: string },
): Promise<void> {
  validateNotificationData(n.type, n.data); // fail in the request, not later in the worker
  await enqueue(db, {
    type: EMAIL_JOB,
    payload: { notification: n.type, to: n.to, data: n.data },
    key: n.key,
  });
}

export function registerNotificationHandlers(worker: JobWorker, mailer: Mailer): void {
  worker.register(EMAIL_JOB, async (payload) => {
    const { notification, to, data } = payload as {
      notification?: string;
      to?: string;
      data?: unknown;
    };
    if (typeof notification !== 'string' || typeof to !== 'string') {
      throw new PermanentJobError('Malformed email job payload');
    }
    let rendered;
    try {
      rendered = renderNotification(notification, data);
    } catch (err) {
      throw new PermanentJobError(err instanceof Error ? err.message : 'Invalid notification');
    }
    await mailer.send({ to, ...rendered }); // SMTP errors propagate and trigger a retry
  });
}
