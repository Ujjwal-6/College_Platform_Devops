import { registerCertificateHandlers } from '../src/modules/certificates/handlers.js';
import { registerGatePassHandlers } from '../src/modules/attendance/gatepass.js';
import { registerNotificationHandlers } from '../src/modules/notifications/notify.js';
import { JobWorker } from '../src/platform/jobs/worker.js';
import type { LoggedIn, Org, TestApp } from './helpers.js';
import { createPublishedEvent, register, students } from './registration-helpers.js';

export type Presence = 'stayed' | 'left_early' | 'inside' | 'absent' | 'cancelled';

/**
 * A published event that has already ended (it ran from three hours ago until ten minutes ago) and a
 * person for each presence in `kinds`:
 *  - stayed: checked in, and out 12 minutes ago (within 15 minutes of the end);
 *  - left_early: checked in, and out an hour ago;
 *  - inside: checked in, never checked out;
 *  - absent: registered, never checked in;
 *  - cancelled: registered then cancelled.
 */
export async function endedEvent(
  t: TestApp,
  org: Org,
  kinds: Presence[],
  over: Record<string, unknown> = {},
) {
  const ev = await createPublishedEvent(t, org, over);
  const people = await students(t, kinds.length);
  const regs: string[] = [];
  for (const p of people) regs.push((await register(t, p, ev)).body.data.id as string);

  const q = (sql: string, params: unknown[] = []) => t.ctx.pool.query(sql, params);
  // gate passes are not what these tests are about; leaving their jobs would add PDFs and emails to every count
  await q("DELETE FROM jobs WHERE type = 'gate_pass.generate'");
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] === 'cancelled') {
      await q(
        "UPDATE registrations SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'self' WHERE id = $1",
        [regs[i]],
      );
    }
  }
  await q(
    "UPDATE events SET start_at = now() - interval '3 hours', end_at = now() - interval '10 minutes' WHERE id = $1",
    [ev],
  );
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i]!;
    if (kind === 'absent' || kind === 'cancelled') continue;
    const outAt =
      kind === 'stayed'
        ? "now() - interval '12 minutes'"
        : kind === 'left_early'
          ? "now() - interval '1 hour'"
          : 'NULL';
    await q(
      `INSERT INTO attendance (registration_id, event_id, user_id, checked_in_by, method, checked_in_at,
                               checked_out_at, checked_out_by, check_out_method)
       VALUES ($1, $2, $3, $4, 'qr', now() - interval '2 hours 30 minutes', ${outAt},
               ${kind === 'inside' ? 'NULL' : '$4'}, ${kind === 'inside' ? 'NULL' : "'qr'"})`,
      [regs[i], ev, people[i]!.user.id, org.organizer.user.id],
    );
  }
  return { ev, people, regs };
}

/** A job worker with the notification, gate-pass and certificate handlers, for running queued jobs. */
export function workerFor(t: TestApp): JobWorker {
  const w = new JobWorker({
    pool: t.ctx.pool,
    logger: t.ctx.logger,
    lockSeconds: 60,
    backoffBaseSeconds: 1,
    pollIntervalMs: 100,
    backoffSeconds: () => 0,
  });
  registerNotificationHandlers(w, t.mailer);
  registerGatePassHandlers(w, t.ctx);
  registerCertificateHandlers(w, t.ctx);
  return w;
}

export type { LoggedIn };
