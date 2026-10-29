import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { withTx } from '../../platform/db.js';
import { PermanentJobError, type JobWorker } from '../../platform/jobs/worker.js';
import { confirmedVenue } from '../bookings/index.js';
import { getEventById } from '../events/index.js';
import { notify } from '../notifications/notify.js';
import { GATE_PASS_JOB, getRegistrationById, getTeamById } from '../registrations/index.js';
import * as usersRepo from '../users/repository.js';
import { renderGatePass } from './pdf.js';
import { qrPng, signCheckInToken } from './qr.js';
import * as repo from './repository.js';

const payloadSchema = z.object({ registrationId: z.string().uuid() });
const MAX_PDF_BYTES = 2_000_000;

function formatWhen(ctx: AppContext, start: Date, end: Date): string {
  const f = new Intl.DateTimeFormat('en-IN', {
    timeZone: ctx.config.APP_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${f.format(start)} to ${f.format(end)}`;
}

/**
 * Renders and stores the gate pass of one registration, then emails the holder a link. Safe to run
 * twice: a pass that already exists is left alone, and two workers racing end with one stored file.
 */
export async function generateGatePass(
  ctx: AppContext,
  payload: unknown,
  opts: { compress?: boolean } = {},
): Promise<void> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentJobError('Malformed gate pass job');
  const registrationId = parsed.data.registrationId;

  if (await repo.findGatePassKey(ctx.pool, registrationId)) return;
  const reg = await getRegistrationById(ctx.pool, registrationId);
  if (!reg) throw new PermanentJobError('Registration not found');
  if (reg.status !== 'registered') return; // cancelled before the worker got to it: no pass
  const event = await getEventById(ctx.pool, reg.eventId);
  if (!event) throw new PermanentJobError('Event not found');
  const [holder] = await usersRepo.getContacts(ctx.pool, [reg.userId]);
  if (!holder) throw new PermanentJobError('Registrant not found');
  const team = reg.teamId ? await getTeamById(ctx.pool, reg.teamId) : null;

  const token = signCheckInToken(ctx.config, {
    registrationId: reg.id,
    eventId: event.id,
    expiresAt: event.endAt,
  });
  const when = formatWhen(ctx, event.startAt, event.endAt);
  const pdf = await renderGatePass(
    {
      eventTitle: event.title,
      when,
      venue: (await confirmedVenue(ctx.pool, event.id)) ?? 'To be announced',
      holderName: holder.name,
      teamName: team?.name ?? null,
      validUntil: new Intl.DateTimeFormat('en-IN', {
        timeZone: ctx.config.APP_TIMEZONE,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(event.endAt),
      passId: reg.id.slice(0, 8).toUpperCase(),
      qrPng: await qrPng(token),
    },
    { compress: opts.compress },
  );
  const stored = await ctx.storage.put({ data: pdf, allowed: ['pdf'], maxBytes: MAX_PDF_BYTES });

  const recorded = await withTx(ctx.pool, async (tx) => {
    const inserted = await repo.insertGatePass(tx, reg.id, stored.key);
    if (inserted) {
      await notify(tx, {
        type: 'gate_pass.ready',
        to: holder.email,
        data: {
          name: holder.name,
          eventTitle: event.title,
          when,
          url: `${ctx.config.WEB_BASE_URL}/events/${event.id}`,
        },
        key: `gate-pass:${reg.id}:ready`,
      });
    }
    return inserted;
  });
  if (!recorded) await ctx.storage.remove(stored.key); // another worker finished first
}

/** Called from the worker entry point. */
export function registerGatePassHandlers(worker: JobWorker, ctx: AppContext): void {
  worker.register(GATE_PASS_JOB, (payload) => generateGatePass(ctx, payload));
}
