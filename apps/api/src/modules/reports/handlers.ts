import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { withTx, type Executor } from '../../platform/db.js';
import { PermanentJobError, describeError, type JobWorker } from '../../platform/jobs/worker.js';
import { recordAudit } from '../audit/audit.js';
import { getEventById } from '../events/index.js';
import { notify } from '../notifications/notify.js';
import * as usersRepo from '../users/repository.js';
import { REPORT_JOB } from './jobs.js';
import { renderReport, type ReportData } from './pdf.js';
import * as repo from './repository.js';
import { buildReportData } from './service.js';

const payloadSchema = z.object({ reportId: z.string().uuid() });
/** Photographs are embedded as they are, so the file can be as large as its photographs (20 x 5 MB). */
const MAX_REPORT_BYTES = 120_000_000;

export interface ReportRunOptions {
  compress?: boolean;
  /** Replaces the PDF drawing (tests make it fail on purpose). */
  render?: (data: ReportData, opts: { compress?: boolean }) => Promise<Buffer>;
}

/** The organizer and every active admin hear about a finished or failed report. */
async function recipients(db: Executor, organizerId: string) {
  const admins = await usersRepo.listActiveByRole(db, 'admin', null);
  const organizer = await usersRepo.getContacts(db, [organizerId]);
  const seen = new Set<string>();
  return [...organizer, ...admins].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

async function announce(
  tx: Executor,
  ctx: AppContext,
  type: 'report.ready' | 'report.failed',
  report: repo.ReportRecord,
  eventTitle: string,
  organizerId: string,
) {
  for (const person of await recipients(tx, organizerId)) {
    await notify(tx, {
      type,
      to: person.email,
      data: {
        name: person.name,
        eventTitle,
        version: report.version,
        url: `${ctx.config.WEB_BASE_URL}/events/${report.eventId}`,
      },
      key: `report:${report.id}:${type}:${person.id}`,
    });
  }
}

/** The last attempt failed: record it, say so in the audit log and tell the organizer and the admins. */
async function giveUp(ctx: AppContext, reportId: string, err: unknown): Promise<void> {
  await withTx(ctx.pool, async (tx) => {
    const report = await repo.findReport(tx, reportId);
    if (!report || !(await repo.markFailed(tx, reportId, describeError(err)))) return;
    const event = await getEventById(tx, report.eventId);
    await recordAudit(tx, {
      action: 'report.failed',
      targetType: 'event',
      targetId: report.eventId,
      metadata: { version: report.version },
    });
    if (event) await announce(tx, ctx, 'report.failed', report, event.title, event.organizerId);
  });
}

/**
 * Draws one version of the report, stores it and tells the organizer and the admins. Safe to run twice:
 * a version that is already done is left alone, and two workers racing end with one stored file.
 * Errors make the job retry; on the last attempt (or an error retrying cannot fix) the version is
 * marked failed and people are told.
 */
export async function generateReport(
  ctx: AppContext,
  payload: unknown,
  opts: ReportRunOptions = {},
  attempt?: { attempt: number; max: number },
): Promise<void> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw new PermanentJobError('Malformed report job');
  const { reportId } = parsed.data;

  const report = await repo.findReport(ctx.pool, reportId);
  if (!report) throw new PermanentJobError('Report not found');
  if (report.status !== 'pending') return; // done (or failed for good) already

  try {
    const event = await getEventById(ctx.pool, report.eventId);
    if (!event) throw new PermanentJobError('Event not found');
    const data = await buildReportData(ctx, event, report.version);
    const pdf = await (opts.render ?? renderReport)(data, { compress: opts.compress });
    const stored = await ctx.storage.put({
      data: pdf,
      allowed: ['pdf'],
      maxBytes: MAX_REPORT_BYTES,
    });

    const recorded = await withTx(ctx.pool, async (tx) => {
      if (!(await repo.markReady(tx, report.id, stored.key))) return false;
      await recordAudit(tx, {
        action: 'report.generated',
        targetType: 'event',
        targetId: event.id,
        metadata: { version: report.version },
      });
      await announce(tx, ctx, 'report.ready', report, event.title, event.organizerId);
      return true;
    });
    if (!recorded) await ctx.storage.remove(stored.key); // another worker finished first
  } catch (err) {
    const lastAttempt =
      err instanceof PermanentJobError || (attempt && attempt.attempt >= attempt.max);
    if (lastAttempt) await giveUp(ctx, report.id, err);
    throw err;
  }
}

/** Called from the worker entry point. */
export function registerReportHandlers(
  worker: JobWorker,
  ctx: AppContext,
  opts: ReportRunOptions = {},
): void {
  worker.register(REPORT_JOB, (payload, job) =>
    generateReport(ctx, payload, opts, { attempt: job.attempt, max: job.job.maxAttempts }),
  );
}
