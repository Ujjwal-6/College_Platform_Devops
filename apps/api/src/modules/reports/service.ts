import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isUniqueViolation, withTx, type Executor } from '../../platform/db.js';
import { errors } from '../../platform/errors.js';
import { enqueue } from '../../platform/jobs/queue.js';
import { attendanceReport, getAttendanceSettings } from '../attendance/index.js';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import type { AuthUser } from '../auth/types.js';
import { confirmedVenue } from '../bookings/index.js';
import { listCertificatesForEvent } from '../certificates/index.js';
import { getDepartmentName } from '../departments/index.js';
import {
  canView,
  canViewWorkflow,
  getEventById,
  getEventSpeakers,
  type EventRecord,
} from '../events/index.js';
import { feedbackComments, feedbackSummary } from '../feedback/index.js';
import { countRegistered } from '../registrations/index.js';
import * as usersRepo from '../users/repository.js';
import { REPORT_JOB } from './jobs.js';
import type { ReportData } from './pdf.js';
import * as repo from './repository.js';

/** The limits of the default layout (U-7): JPEG or PNG, 5 MB each, 20 photographs per event. */
export const PHOTO_MAX_BYTES = 5_000_000;
export const PHOTO_MAX_COUNT = 20;
const COMMENTS_IN_REPORT = 10;

export const outcomesSchema = z
  .object({
    outcomes: z
      .string()
      .trim()
      .max(3000)
      .nullable()
      .transform((v) => (v ? v : null)),
  })
  .strict();
export const photoQuerySchema = z
  .object({ caption: z.string().trim().max(200).optional() })
  .strict();

const isAdmin = (u: AuthUser) => u.roles.includes('admin');
/** The organizer and admins provide the report's inputs and ask for new versions. */
const isManager = (u: AuthUser, e: EventRecord) => isAdmin(u) || e.organizerId === u.id;

async function loadEvent(
  db: Executor,
  user: AuthUser,
  eventId: string,
  lock = false,
): Promise<EventRecord> {
  const event = await getEventById(db, eventId, lock);
  if (!event || !canView(user, event)) throw errors.notFound('Event');
  return event;
}

/** The organizer, the department's faculty/HOD and admins may see the report material and download reports. */
async function loadVisible(db: Executor, user: AuthUser, eventId: string): Promise<EventRecord> {
  const event = await loadEvent(db, user, eventId);
  if (!canViewWorkflow(user, event)) throw errors.forbidden();
  return event;
}

const takesInputs = (e: EventRecord) => e.status === 'published' || e.status === 'closed';

// ---- starting a report -------------------------------------------------------------------------

/** Queues the automatic report when an event closes. Runs inside the closing transaction (hooks.ts). */
export async function queueReportOnClose(tx: Executor, eventId: string): Promise<void> {
  const report = await repo.insertReport(tx, { eventId, reason: 'close', requestedBy: null });
  if (!report) return; // closed before: its report already exists
  await enqueue(tx, {
    type: REPORT_JOB,
    payload: { reportId: report.id },
    key: `report:${report.id}`,
  });
}

/** Asks for a new version of the report (for example after late photographs). */
export async function requestReport(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  meta: RequestMeta,
) {
  return withTx(ctx.pool, async (tx) => {
    const event = await loadEvent(tx, user, eventId, true);
    if (!isManager(user, event)) throw errors.forbidden();
    if (event.status !== 'closed') {
      throw errors.conflict(
        'EVENT_NOT_CLOSED',
        'A report can be made once the event has been closed',
      );
    }
    let report: repo.ReportRecord | null;
    try {
      report = await repo.insertReport(tx, { eventId, reason: 'manual', requestedBy: user.id });
    } catch (err) {
      if (isUniqueViolation(err, 'event_reports_one_pending_key')) {
        throw errors.conflict(
          'REPORT_IN_PROGRESS',
          'A report is already being made for this event',
        );
      }
      throw err;
    }
    await enqueue(tx, {
      type: REPORT_JOB,
      payload: { reportId: report!.id },
      key: `report:${report!.id}`,
    });
    await recordAudit(tx, {
      actorId: user.id,
      action: 'report.requested',
      targetType: 'event',
      targetId: eventId,
      metadata: { version: report!.version },
      ...meta,
    });
    return reportView(report!, new Map());
  });
}

// ---- reading -----------------------------------------------------------------------------------

export interface ReportView {
  id: string;
  version: number;
  reason: 'close' | 'manual';
  status: 'pending' | 'ready' | 'failed';
  requestedBy: string | null;
  createdAt: string;
  generatedAt: string | null;
}

const reportView = (r: repo.ReportRecord, names: Map<string, string>): ReportView => ({
  id: r.id,
  version: r.version,
  reason: r.reason,
  status: r.status,
  requestedBy: r.requestedBy ? (names.get(r.requestedBy) ?? null) : null,
  createdAt: r.createdAt.toISOString(),
  generatedAt: r.generatedAt?.toISOString() ?? null,
});

/** What the organizer provided, the versions made so far, and what the viewer may do. */
export async function overview(ctx: AppContext, user: AuthUser, eventId: string) {
  const event = await loadVisible(ctx.pool, user, eventId);
  const [outcomes, photos, reports] = await Promise.all([
    repo.getOutcomes(ctx.pool, eventId),
    repo.listPhotos(ctx.pool, eventId),
    repo.listReports(ctx.pool, eventId),
  ]);
  const names = new Map(
    (
      await usersRepo.getContacts(
        ctx.pool,
        reports.flatMap((r) => (r.requestedBy ? [r.requestedBy] : [])),
      )
    ).map((c) => [c.id, c.name]),
  );
  const manager = isManager(user, event);
  return {
    inputs: { outcomes },
    photos: photos.map((p) => ({
      id: p.id,
      caption: p.caption,
      createdAt: p.createdAt.toISOString(),
    })),
    reports: reports.map((r) => reportView(r, names)),
    limits: { photoMaxBytes: PHOTO_MAX_BYTES, photoMaxCount: PHOTO_MAX_COUNT },
    can: {
      edit: manager && takesInputs(event),
      generate:
        manager && event.status === 'closed' && !reports.some((r) => r.status === 'pending'),
    },
  };
}

/** The stored PDF of a version, or null while it is still being drawn. */
export async function downloadReport(ctx: AppContext, user: AuthUser, reportId: string) {
  const report = await repo.findReport(ctx.pool, reportId);
  if (!report) throw errors.notFound('Report');
  const event = await getEventById(ctx.pool, report.eventId);
  if (!event || !canView(user, event)) throw errors.notFound('Report');
  if (!canViewWorkflow(user, event)) throw errors.forbidden();
  if (report.status === 'failed') {
    throw errors.conflict(
      'REPORT_FAILED',
      'This version of the report could not be made. Ask for a new one.',
    );
  }
  if (report.status !== 'ready' || !report.storageKey) return null;
  return { data: (await ctx.storage.get(report.storageKey)).data, version: report.version };
}

// ---- the organizer's inputs --------------------------------------------------------------------

export async function saveOutcomes(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  input: z.infer<typeof outcomesSchema>,
  meta: RequestMeta,
) {
  return withTx(ctx.pool, async (tx) => {
    const event = await loadEvent(tx, user, eventId, true);
    if (!isManager(user, event)) throw errors.forbidden();
    if (!takesInputs(event)) {
      throw errors.conflict(
        'EVENT_NOT_ACTIVE',
        'Outcomes can be added once the event is published',
      );
    }
    await repo.saveOutcomes(tx, eventId, input.outcomes, user.id);
    await recordAudit(tx, {
      actorId: user.id,
      action: 'report.outcomes_saved',
      targetType: 'event',
      targetId: eventId,
      ...meta,
    });
    return { outcomes: input.outcomes };
  });
}

export async function addPhoto(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  data: unknown,
  query: z.infer<typeof photoQuerySchema>,
  meta: RequestMeta,
) {
  if (!Buffer.isBuffer(data)) {
    throw errors.validation([
      { path: 'body', message: 'Send the photograph as image/png or image/jpeg' },
    ]);
  }
  // The type is checked by looking at the bytes (not the name or the declared type), and the size by the limit.
  const stored = await ctx.storage.put({
    data,
    allowed: ['png', 'jpeg'],
    maxBytes: PHOTO_MAX_BYTES,
  });
  try {
    return await withTx(ctx.pool, async (tx) => {
      const event = await loadEvent(tx, user, eventId, true);
      if (!isManager(user, event)) throw errors.forbidden();
      if (!takesInputs(event)) {
        throw errors.conflict(
          'EVENT_NOT_ACTIVE',
          'Photographs can be added once the event is published',
        );
      }
      if ((await repo.countPhotos(tx, eventId)) >= PHOTO_MAX_COUNT) {
        throw errors.conflict(
          'TOO_MANY_PHOTOS',
          `At most ${PHOTO_MAX_COUNT} photographs can be added`,
        );
      }
      const photo = await repo.insertPhoto(tx, {
        eventId,
        storageKey: stored.key,
        caption: query.caption || null,
        uploadedBy: user.id,
      });
      await recordAudit(tx, {
        actorId: user.id,
        action: 'report.photo_added',
        targetType: 'event',
        targetId: eventId,
        metadata: { photoId: photo.id },
        ...meta,
      });
      return { id: photo.id, caption: photo.caption, createdAt: photo.createdAt.toISOString() };
    });
  } catch (err) {
    await ctx.storage.remove(stored.key);
    throw err;
  }
}

export async function removePhoto(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  photoId: string,
  meta: RequestMeta,
) {
  const key = await withTx(ctx.pool, async (tx) => {
    const event = await loadEvent(tx, user, eventId, true);
    if (!isManager(user, event)) throw errors.forbidden();
    const photo = await repo.findPhoto(tx, photoId);
    if (!photo || photo.eventId !== eventId) throw errors.notFound('Photograph');
    await repo.deletePhoto(tx, photoId);
    await recordAudit(tx, {
      actorId: user.id,
      action: 'report.photo_removed',
      targetType: 'event',
      targetId: eventId,
      metadata: { photoId },
      ...meta,
    });
    return photo.storageKey;
  });
  await ctx.storage.remove(key);
  return { removed: true as const };
}

export async function photoImage(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  photoId: string,
) {
  await loadVisible(ctx.pool, user, eventId);
  const photo = await repo.findPhoto(ctx.pool, photoId);
  if (!photo || photo.eventId !== eventId) throw errors.notFound('Photograph');
  return ctx.storage.get(photo.storageKey);
}

// ---- compiling the report ----------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Gathers everything the report shows, through the other modules' public interfaces. Missing
 * information is not an error: it becomes an empty list, a zero or null, and the PDF says so.
 */
export async function buildReportData(
  ctx: AppContext,
  event: EventRecord,
  version: number,
): Promise<ReportData> {
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: ctx.config.APP_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const db = ctx.pool;
  const [
    speakers,
    registered,
    rows,
    settings,
    outcomes,
    photoRows,
    summary,
    comments,
    certs,
    venue,
    department,
    organizer,
  ] = await Promise.all([
    getEventSpeakers(db, event.id),
    countRegistered(db, event.id),
    attendanceReport(db, event.id),
    getAttendanceSettings(db, event.id),
    repo.getOutcomes(db, event.id),
    repo.listPhotos(db, event.id),
    feedbackSummary(db, event.id),
    feedbackComments(db, event.id),
    listCertificatesForEvent(db, event.id),
    confirmedVenue(db, event.id),
    getDepartmentName(db, event.departmentId),
    usersRepo.getContacts(db, [event.organizerId]),
  ]);

  const photos: ReportData['photos'] = [];
  for (const p of photoRows) {
    try {
      photos.push({ data: (await ctx.storage.get(p.storageKey)).data, caption: p.caption });
    } catch {
      // a missing file must not stop the report; the photograph is simply not shown
    }
  }

  const checkedIn = rows.length;
  return {
    version,
    generatedAt: fmt.format(new Date()),
    event: {
      title: event.title,
      description: event.description,
      category: event.category,
      when: `${fmt.format(event.startAt)} to ${fmt.format(event.endAt)}`,
      venue,
      department,
      organizer: organizer[0]?.name ?? null,
      capacity: event.capacity,
      registration:
        event.registrationMode === 'team'
          ? `Teams of ${event.teamSizeMin} to ${event.teamSizeMax}`
          : 'Individual',
    },
    speakers,
    attendance: {
      registered,
      checkedIn,
      ratePercent: registered > 0 ? round1((checkedIn / registered) * 100) : null,
      noShows: Math.max(0, registered - checkedIn),
      walkIns: rows.filter((r) => r.method === 'walk_in').length,
      manualCheckIns: rows.filter((r) => r.method === 'manual').length,
      requireCheckOut: settings.requireCheckOut,
      completed: rows.filter((r) => r.completed).length,
      leftEarly: rows.filter((r) => r.leftEarly === true).length,
      stillInside: rows.filter((r) => r.checkedOutAt === null).length,
    },
    outcomes,
    photos,
    feedback: {
      count: summary.count,
      average: summary.average,
      distribution: summary.distribution,
      comments: comments.slice(0, COMMENTS_IN_REPORT),
    },
    certificates: {
      issued: certs.length,
      withdrawn: certs.filter((c) => c.revokedAt).length,
    },
  };
}
