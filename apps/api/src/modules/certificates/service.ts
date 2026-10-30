import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isUniqueViolation, withTx, type Executor } from '../../platform/db.js';
import { AppError, errors } from '../../platform/errors.js';
import { enqueue } from '../../platform/jobs/queue.js';
import { attendanceReport } from '../attendance/index.js';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import type { AuthUser } from '../auth/types.js';
import { canView, canViewWorkflow, getEventById, type EventRecord } from '../events/index.js';
import * as usersRepo from '../users/repository.js';
import { generateVerificationCode, normalizeVerificationCode } from './codes.js';
import { GENERATE_JOB, ISSUE_JOB } from './jobs.js';
import * as repo from './repository.js';

export const verifyParams = z.object({ code: z.string().trim().min(1).max(64) }).strict();

const isAdmin = (u: AuthUser) => u.roles.includes('admin');
const isManager = (u: AuthUser, e: EventRecord) => isAdmin(u) || e.organizerId === u.id;

async function loadEvent(db: Executor, user: AuthUser, eventId: string): Promise<EventRecord> {
  const event = await getEventById(db, eventId);
  if (!event || !canView(user, event)) throw errors.notFound('Event');
  return event;
}

/** A certificate is for an event that took place: published or closed, and already over. */
const issuable = (event: EventRecord, now = new Date()) =>
  (event.status === 'published' || event.status === 'closed') && now >= event.endAt;

// ---- issuing -----------------------------------------------------------------------------------

/**
 * Creates the certificate row of every person whose attendance counts as completed (checked in and,
 * when the organizer requires check-out, stayed to the end) and queues one job per new certificate to
 * draw the PDF. Runs inside one transaction and is safe to repeat: people who already have one are
 * skipped, so a re-run only picks up people who became eligible since. Returns how many were created.
 */
export async function issueForEvent(tx: Executor, eventId: string): Promise<number> {
  const event = await getEventById(tx, eventId);
  if (!event || !issuable(event)) return 0;
  const eligible = (await attendanceReport(tx, eventId)).filter((r) => r.completed);
  if (eligible.length === 0) return 0;
  const names = new Map(
    (
      await usersRepo.getContacts(
        tx,
        eligible.map((r) => r.userId),
      )
    ).map((c) => [c.id, c.name]),
  );

  let created = 0;
  for (const row of eligible) {
    let cert: repo.CertificateRecord | null = null;
    for (let attempt = 0; attempt < 3 && !cert; attempt++) {
      try {
        cert = await repo.insertCertificate(tx, {
          eventId,
          userId: row.userId,
          code: generateVerificationCode(),
          holderName: names.get(row.userId) ?? '',
        });
        if (!cert) break; // already has one
      } catch (err) {
        if (!isUniqueViolation(err, 'certificates_code_key')) throw err;
      }
    }
    if (!cert) continue;
    created++;
    await recordAudit(tx, {
      action: 'certificate.issued',
      targetType: 'certificate',
      targetId: cert.id,
      metadata: { eventId, userId: row.userId },
    });
    await enqueue(tx, {
      type: GENERATE_JOB,
      payload: { certificateId: cert.id },
      key: `certificate:${cert.id}`,
    });
  }
  return created;
}

/** The organizer (or an admin) asks for certificates once the event is over. Certificates are only ever issued this way (decided by the product owner). */
export async function requestIssue(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  meta: RequestMeta,
): Promise<{ queued: true; eligible: number; issued: number }> {
  return withTx(ctx.pool, async (tx) => {
    const event = await loadEvent(tx, user, eventId);
    if (!isManager(user, event)) throw errors.forbidden();
    if (!issuable(event)) {
      throw errors.conflict(
        'EVENT_NOT_OVER',
        'Certificates can be issued once the event has ended',
      );
    }
    const eligible = (await attendanceReport(tx, eventId)).filter((r) => r.completed).length;
    const issued = (await repo.listForEvent(tx, eventId)).length;
    await enqueue(tx, {
      type: ISSUE_JOB,
      payload: { eventId },
      key: `certificates:issue:${eventId}:request:${Date.now()}`,
    });
    await recordAudit(tx, {
      actorId: user.id,
      action: 'certificate.issue_requested',
      targetType: 'event',
      targetId: eventId,
      ...meta,
    });
    return { queued: true as const, eligible, issued };
  });
}

// ---- reading -----------------------------------------------------------------------------------

export interface CertificateView {
  id: string;
  eventId: string;
  holderName: string;
  code: string;
  status: 'pending' | 'ready';
  issuedAt: string;
  generatedAt: string | null;
  /** Set while the certificate is withdrawn. */
  revokedAt: string | null;
  /** Only shown to the people who manage the event, never to the holder. */
  revokeReason?: string | null;
}

const view = (c: repo.CertificateRecord, withReason = false): CertificateView => ({
  id: c.id,
  eventId: c.eventId,
  holderName: c.holderName,
  code: c.code,
  status: c.status,
  issuedAt: c.issuedAt.toISOString(),
  generatedAt: c.generatedAt?.toISOString() ?? null,
  revokedAt: c.revokedAt?.toISOString() ?? null,
  ...(withReason ? { revokeReason: c.revokeReason } : {}),
});

export async function myCertificates(ctx: AppContext, user: AuthUser) {
  const rows = await repo.listForUser(ctx.pool, user.id);
  const out = [];
  for (const c of rows) {
    const event = await getEventById(ctx.pool, c.eventId);
    out.push({
      ...view(c),
      event: event
        ? {
            id: event.id,
            title: event.title,
            startAt: event.startAt.toISOString(),
            endAt: event.endAt.toISOString(),
          }
        : null,
    });
  }
  return out;
}

/** The PDF of the person's own certificate, or null while the worker has not drawn it yet. */
export async function downloadCertificate(ctx: AppContext, user: AuthUser, id: string) {
  const cert = await repo.findById(ctx.pool, id);
  if (!cert || cert.userId !== user.id) throw errors.notFound('Certificate');
  if (cert.revokedAt) {
    throw errors.conflict('CERTIFICATE_REVOKED', 'This certificate has been withdrawn');
  }
  if (cert.status !== 'ready' || !cert.storageKey) return null;
  return (await ctx.storage.get(cert.storageKey)).data;
}

/** For the event's organizer, its department's faculty/HOD and admins. */
export async function eventCertificates(ctx: AppContext, user: AuthUser, eventId: string) {
  const event = await loadEvent(ctx.pool, user, eventId);
  if (!canViewWorkflow(user, event)) throw errors.forbidden();
  const certs = await repo.listForEvent(ctx.pool, eventId);
  const eligible = (await attendanceReport(ctx.pool, eventId)).filter((r) => r.completed).length;
  return {
    summary: {
      eligible,
      issued: certs.length,
      ready: certs.filter((c) => c.status === 'ready').length,
      revoked: certs.filter((c) => c.revokedAt).length,
      canIssue: issuable(event),
    },
    data: certs.map((c) => view(c, true)),
  };
}

/** Draws the PDF again, for example after a name was corrected. Admins only; the code stays the same. */
export async function regenerate(
  ctx: AppContext,
  user: AuthUser,
  id: string,
  meta: RequestMeta,
): Promise<{ queued: true }> {
  if (!isAdmin(user)) throw errors.forbidden();
  return withTx(ctx.pool, async (tx) => {
    const cert = await repo.findById(tx, id);
    if (!cert) throw errors.notFound('Certificate');
    await enqueue(tx, {
      type: GENERATE_JOB,
      payload: { certificateId: id, regenerate: true },
      key: `certificate:${id}:regenerate:${Date.now()}`,
    });
    await recordAudit(tx, {
      actorId: user.id,
      action: 'certificate.regenerated',
      targetType: 'certificate',
      targetId: id,
      ...meta,
    });
    return { queued: true as const };
  });
}

// ---- verification (public) ---------------------------------------------------------------------

/**
 * Anyone may check a code. A genuine one returns what is printed on the certificate (the holder's
 * name, the event and its date); anything else is the same "not found", whether the code was
 * malformed or simply does not exist.
 */
export async function verify(ctx: AppContext, rawCode: string) {
  const notFound = () =>
    new AppError(404, 'CERTIFICATE_NOT_FOUND', 'No certificate with this code');
  const code = normalizeVerificationCode(rawCode);
  if (!code) throw notFound();
  const cert = await repo.findByCode(ctx.pool, code);
  if (!cert) throw notFound();
  const event = await getEventById(ctx.pool, cert.eventId);
  if (!event) throw notFound();
  // A withdrawn certificate is no longer valid. The code is real, so say so, but show nothing else.
  if (cert.revokedAt) return { valid: false as const, revoked: true as const, code: cert.code };
  return {
    valid: true as const,
    code: cert.code,
    holderName: cert.holderName,
    eventTitle: event.title,
    eventStartAt: event.startAt.toISOString(),
    eventEndAt: event.endAt.toISOString(),
    issuedAt: cert.issuedAt.toISOString(),
  };
}

// ---- withdrawing -------------------------------------------------------------------------------

export const revokeSchema = z
  .object({ reason: z.string().trim().min(3, 'Please say why (at least 3 characters)').max(300) })
  .strict();

async function loadManagedCertificate(
  tx: Executor,
  user: AuthUser,
  id: string,
): Promise<{ cert: repo.CertificateRecord; event: EventRecord }> {
  const cert = await repo.findById(tx, id);
  if (!cert) throw errors.notFound('Certificate');
  const event = await getEventById(tx, cert.eventId);
  if (!event || !canView(user, event)) throw errors.notFound('Certificate');
  if (!isManager(user, event)) throw errors.forbidden();
  return { cert, event };
}

/** The organizer or an admin withdraws a certificate (for example if an attendance record was wrong). */
export async function revokeCertificate(
  ctx: AppContext,
  user: AuthUser,
  id: string,
  input: z.infer<typeof revokeSchema>,
  meta: RequestMeta,
): Promise<CertificateView> {
  return withTx(ctx.pool, async (tx) => {
    const { cert } = await loadManagedCertificate(tx, user, id);
    if (!(await repo.revoke(tx, id, user.id, input.reason))) {
      throw errors.conflict('ALREADY_REVOKED', 'This certificate is already withdrawn');
    }
    await recordAudit(tx, {
      actorId: user.id,
      action: 'certificate.revoked',
      targetType: 'certificate',
      targetId: id,
      metadata: { eventId: cert.eventId, userId: cert.userId, reason: input.reason },
      ...meta,
    });
    return view((await repo.findById(tx, id))!, true);
  });
}

/** Puts a withdrawn certificate back, for the same people who can withdraw it. */
export async function reinstateCertificate(
  ctx: AppContext,
  user: AuthUser,
  id: string,
  meta: RequestMeta,
): Promise<CertificateView> {
  return withTx(ctx.pool, async (tx) => {
    const { cert } = await loadManagedCertificate(tx, user, id);
    if (!(await repo.reinstate(tx, id))) {
      throw errors.conflict('NOT_REVOKED', 'This certificate is not withdrawn');
    }
    await recordAudit(tx, {
      actorId: user.id,
      action: 'certificate.reinstated',
      targetType: 'certificate',
      targetId: id,
      metadata: { eventId: cert.eventId, userId: cert.userId },
      ...meta,
    });
    return view((await repo.findById(tx, id))!, true);
  });
}

/** Draws every certificate of an event again, for example after the college supplied its logo. Admins only. */
export async function redrawAll(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  meta: RequestMeta,
): Promise<{ queued: number }> {
  if (!isAdmin(user)) throw errors.forbidden();
  return withTx(ctx.pool, async (tx) => {
    const event = await getEventById(tx, eventId);
    if (!event) throw errors.notFound('Event');
    const certs = (await repo.listForEvent(tx, eventId)).filter((c) => c.status === 'ready');
    const stamp = Date.now();
    for (const c of certs) {
      await enqueue(tx, {
        type: GENERATE_JOB,
        payload: { certificateId: c.id, regenerate: true },
        key: `certificate:${c.id}:regenerate:${stamp}`,
      });
    }
    await recordAudit(tx, {
      actorId: user.id,
      action: 'certificate.regenerated',
      targetType: 'event',
      targetId: eventId,
      metadata: { count: certs.length },
      ...meta,
    });
    return { queued: certs.length };
  });
}

// ---- the design of certificates (admin) --------------------------------------------------------

const optionalText = z
  .string()
  .trim()
  .max(120)
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v ? v : null));
export const templateSchema = z
  .object({
    organizationName: optionalText,
    signatoryName: optionalText,
    signatoryTitle: optionalText,
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');

export interface TemplateView {
  organizationName: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  hasLogo: boolean;
  hasSignature: boolean;
  updatedAt: string | null;
}

const templateView = (t: repo.TemplateRecord): TemplateView => ({
  organizationName: t.organizationName,
  signatoryName: t.signatoryName,
  signatoryTitle: t.signatoryTitle,
  hasLogo: t.logoKey !== null,
  hasSignature: t.signatureKey !== null,
  updatedAt: t.updatedAt?.toISOString() ?? null,
});

const IMAGE_MAX_BYTES = 1_000_000;

export async function getTemplate(ctx: AppContext, user: AuthUser): Promise<TemplateView> {
  if (!isAdmin(user)) throw errors.forbidden();
  return templateView(await repo.getTemplate(ctx.pool));
}

export async function updateTemplateText(
  ctx: AppContext,
  user: AuthUser,
  input: z.infer<typeof templateSchema>,
  meta: RequestMeta,
): Promise<TemplateView> {
  if (!isAdmin(user)) throw errors.forbidden();
  return withTx(ctx.pool, async (tx) => {
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const saved = await repo.saveTemplate(tx, patch, user.id);
    await recordAudit(tx, {
      actorId: user.id,
      action: 'certificate.template_changed',
      targetType: 'certificate_template',
      metadata: { fields: Object.keys(patch) },
      ...meta,
    });
    return templateView(saved);
  });
}

type ImageKind = 'logo' | 'signature';
const KEY: Record<ImageKind, 'logoKey' | 'signatureKey'> = {
  logo: 'logoKey',
  signature: 'signatureKey',
};

/** Stores the logo or the signature image (PNG or JPEG, checked by content, at most 1 MB) and removes the one it replaces. */
export async function setTemplateImage(
  ctx: AppContext,
  user: AuthUser,
  kind: ImageKind,
  data: unknown,
  meta: RequestMeta,
): Promise<TemplateView> {
  if (!isAdmin(user)) throw errors.forbidden();
  if (!Buffer.isBuffer(data)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the image as image/png or image/jpeg');
  }
  const stored = await ctx.storage.put({
    data,
    allowed: ['png', 'jpeg'],
    maxBytes: IMAGE_MAX_BYTES,
  });
  try {
    const { saved, replaced } = await withTx(ctx.pool, async (tx) => {
      const replaced = (await repo.getTemplate(tx))[KEY[kind]];
      const saved = await repo.saveTemplate(tx, { [KEY[kind]]: stored.key }, user.id);
      await recordAudit(tx, {
        actorId: user.id,
        action: 'certificate.template_changed',
        targetType: 'certificate_template',
        metadata: { fields: [kind] },
        ...meta,
      });
      return { saved, replaced };
    });
    if (replaced) await ctx.storage.remove(replaced);
    return templateView(saved);
  } catch (err) {
    await ctx.storage.remove(stored.key);
    throw err;
  }
}

export async function removeTemplateImage(
  ctx: AppContext,
  user: AuthUser,
  kind: ImageKind,
  meta: RequestMeta,
): Promise<TemplateView> {
  if (!isAdmin(user)) throw errors.forbidden();
  const { saved, removed } = await withTx(ctx.pool, async (tx) => {
    const removed = (await repo.getTemplate(tx))[KEY[kind]];
    const saved = await repo.saveTemplate(tx, { [KEY[kind]]: null }, user.id);
    if (removed) {
      await recordAudit(tx, {
        actorId: user.id,
        action: 'certificate.template_changed',
        targetType: 'certificate_template',
        metadata: { fields: [kind], removed: true },
        ...meta,
      });
    }
    return { saved, removed };
  });
  if (removed) await ctx.storage.remove(removed);
  return templateView(saved);
}
