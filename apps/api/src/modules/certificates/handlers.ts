import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { withTx } from '../../platform/db.js';
import { PermanentJobError, type JobWorker } from '../../platform/jobs/worker.js';
import { qrPng } from '../attendance/qr.js';
import { getDepartmentName } from '../departments/index.js';
import { getEventById } from '../events/index.js';
import { notify } from '../notifications/notify.js';
import * as usersRepo from '../users/repository.js';
import { GENERATE_JOB, ISSUE_JOB } from './jobs.js';
import { renderCertificate } from './pdf.js';
import * as repo from './repository.js';
import { issueForEvent } from './service.js';

const generatePayload = z.object({
  certificateId: z.string().uuid(),
  regenerate: z.boolean().optional(),
});
const issuePayload = z.object({ eventId: z.string().uuid() });
const MAX_PDF_BYTES = 2_000_000;

function formatDates(ctx: AppContext, start: Date, end: Date): string {
  const f = new Intl.DateTimeFormat('en-IN', {
    timeZone: ctx.config.APP_TIMEZONE,
    dateStyle: 'long',
  });
  const a = f.format(start);
  const b = f.format(end);
  return a === b ? a : `${a} to ${b}`;
}

/** Draws the certificate, stores it and (the first time) emails the person. Safe to run twice. */
export async function generateCertificate(
  ctx: AppContext,
  payload: unknown,
  opts: { compress?: boolean } = {},
): Promise<void> {
  const parsed = generatePayload.safeParse(payload);
  if (!parsed.success) throw new PermanentJobError('Malformed certificate job');
  const { certificateId, regenerate = false } = parsed.data;

  const cert = await repo.findById(ctx.pool, certificateId);
  if (!cert) throw new PermanentJobError('Certificate not found');
  if (cert.status === 'ready' && !regenerate) return;
  const event = await getEventById(ctx.pool, cert.eventId);
  if (!event) throw new PermanentJobError('Event not found');
  const [holder] = await usersRepo.getContacts(ctx.pool, [cert.userId]);
  if (!holder) throw new PermanentJobError('Holder not found');
  // a regeneration prints the name as it is now (the usual reason is a corrected name)
  const printedName = regenerate ? holder.name : cert.holderName;

  const template = await repo.getTemplate(ctx.pool);
  const readImage = async (key: string | null) => {
    if (!key) return null;
    try {
      return (await ctx.storage.get(key)).data;
    } catch {
      return null; // a missing image must not stop certificates from being made
    }
  };
  const verifyUrl = `${ctx.config.WEB_BASE_URL}/verify/${cert.code}`;
  const pdf = await renderCertificate(
    {
      departmentName: await getDepartmentName(ctx.pool, event.departmentId),
      organizationName: template.organizationName,
      signatoryName: template.signatoryName,
      signatoryTitle: template.signatoryTitle,
      logo: await readImage(template.logoKey),
      signature: await readImage(template.signatureKey),
      holderName: printedName,
      eventTitle: event.title,
      when: formatDates(ctx, event.startAt, event.endAt),
      code: cert.code,
      verifyUrl,
      qrPng: await qrPng(verifyUrl),
    },
    opts,
  );
  const stored = await ctx.storage.put({ data: pdf, allowed: ['pdf'], maxBytes: MAX_PDF_BYTES });

  let replaced: string | null = null;
  const recorded = await withTx(ctx.pool, async (tx) => {
    if (regenerate) {
      replaced = await repo.replaceFile(tx, cert.id, stored.key, printedName);
      return true;
    }
    const first = await repo.markReady(tx, cert.id, stored.key);
    if (first) {
      await notify(tx, {
        type: 'certificate.ready',
        to: holder.email,
        data: {
          name: holder.name,
          eventTitle: event.title,
          url: `${ctx.config.WEB_BASE_URL}/certificates`,
        },
        key: `certificate:${cert.id}:ready`,
      });
    }
    return first;
  });
  if (!recorded) await ctx.storage.remove(stored.key); // another worker finished first
  if (replaced) await ctx.storage.remove(replaced);
}

export async function issueCertificates(ctx: AppContext, payload: unknown): Promise<void> {
  const parsed = issuePayload.safeParse(payload);
  if (!parsed.success) throw new PermanentJobError('Malformed certificate issue job');
  await withTx(ctx.pool, (tx) => issueForEvent(tx, parsed.data.eventId));
}

/** Called from the worker entry point. */
export function registerCertificateHandlers(worker: JobWorker, ctx: AppContext): void {
  worker.register(ISSUE_JOB, (payload) => issueCertificates(ctx, payload));
  worker.register(GENERATE_JOB, (payload) => generateCertificate(ctx, payload));
}
