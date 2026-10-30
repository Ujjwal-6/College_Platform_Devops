import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { errors } from '../../platform/errors.js';
import { attendanceReport } from '../attendance/index.js';
import type { AuthUser } from '../auth/types.js';
import { budgetTotalsForEvents, canSeeBudget, summarizeBudget } from '../budgets/index.js';
import { listCertificatesForEvent } from '../certificates/index.js';
import { canView, canViewWorkflow, getEventById } from '../events/index.js';
import { feedbackSummary } from '../feedback/index.js';
import { countRegistered } from '../registrations/index.js';
import { formatMinor, toCsv } from './csv.js';
import * as repo from './repository.js';

const MAX_DAYS = 366;
const DEFAULT_DAYS = 90;

const realDate = z.string().refine((v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'Use a real date as YYYY-MM-DD');

export const periodQuery = z
  .object({
    from: realDate.optional(),
    to: realDate.optional(),
    departmentId: z.string().uuid().optional(),
  })
  .strict();

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const todayIn = (timezone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());

/** The period as local dates (inclusive). Defaults to the last 90 days; at most a year. */
function period(ctx: AppContext, q: z.infer<typeof periodQuery>) {
  const today = todayIn(ctx.config.APP_TIMEZONE);
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, -(DEFAULT_DAYS - 1));
  if (from > to) throw errors.validation([{ path: 'from', message: 'from must not be after to' }]);
  const days = daysBetween(from, to);
  if (days > MAX_DAYS) {
    throw errors.validation([
      { path: 'to', message: `Choose a period of at most ${MAX_DAYS} days` },
    ]);
  }
  return { from, to, days, timezone: ctx.config.APP_TIMEZONE };
}

const isAdmin = (u: AuthUser) => u.roles.includes('admin');

/** Admins see everything; a HOD sees only their own department. Nobody else gets the summaries. */
function scope(user: AuthUser, requested: string | undefined): { departmentId?: string } {
  if (isAdmin(user)) return requested ? { departmentId: requested } : {};
  if (user.roles.includes('hod') && user.departmentId) {
    if (requested && requested !== user.departmentId) throw errors.forbidden();
    return { departmentId: user.departmentId };
  }
  throw errors.forbidden();
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface EventRowView {
  id: string;
  title: string;
  status: 'published' | 'closed';
  startAt: string;
  department: { id: string; name: string };
  organizer: string;
  registered: number;
  checkedIn: number;
  /** checked in ÷ registered, as a percentage; null until the event has started or when nobody registered */
  ratePercent: number | null;
  /** registered but did not come; null until the event has ended */
  noShows: number | null;
  feedbackCount: number;
  feedbackAverage: number | null;
  certificates: number;
  budget: { estimateMinor: number; actualMinor: number; overBudget: boolean } | null;
}

async function rowsFor(
  ctx: AppContext,
  p: ReturnType<typeof period>,
  departmentId: string | undefined,
  eventId?: string,
) {
  const { rows, truncated } = await repo.eventStats(ctx.pool, { ...p, departmentId, eventId });
  const budgets = await budgetTotalsForEvents(
    ctx.pool,
    rows.map((r) => r.id),
  );
  const now = new Date();
  const views: EventRowView[] = rows.map((r) => {
    const totals = budgets.size ? summarizeBudget(budgets.get(r.id) ?? []) : summarizeBudget([]);
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      startAt: r.startAt.toISOString(),
      department: { id: r.departmentId, name: r.departmentName },
      organizer: r.organizerName,
      registered: r.registered,
      checkedIn: r.checkedIn,
      ratePercent:
        r.startAt <= now && r.registered > 0 ? round1((r.checkedIn / r.registered) * 100) : null,
      noShows: r.endAt <= now ? Math.max(0, r.registered - r.checkedIn) : null,
      feedbackCount: r.feedbackCount,
      feedbackAverage: r.feedbackCount ? round2(r.feedbackTotal / r.feedbackCount) : null,
      certificates: r.certificates,
      budget: {
        estimateMinor: totals.estimateMinor,
        actualMinor: totals.actualMinor,
        overBudget: totals.overBudget,
      },
    };
  });
  return { views, truncated, raw: rows };
}

interface Totals {
  events: number;
  registered: number;
  checkedIn: number;
  ratePercent: number | null;
  feedbackCount: number;
  feedbackAverage: number | null;
  certificates: number;
  budget: { estimateMinor: number; actualMinor: number; overBudgetEvents: number };
}

/** Totals over a set of rows. The rate counts only events that have started, so future events do not drag it down. */
function totalsOf(views: EventRowView[], raw: repo.EventStatsRow[]): Totals {
  const started = views.filter((v) => v.ratePercent !== null || new Date(v.startAt) <= new Date());
  const regStarted = started.reduce((n, v) => n + v.registered, 0);
  const inStarted = started.reduce((n, v) => n + v.checkedIn, 0);
  const feedbackCount = raw.reduce((n, r) => n + r.feedbackCount, 0);
  const feedbackTotal = raw.reduce((n, r) => n + r.feedbackTotal, 0);
  return {
    events: views.length,
    registered: views.reduce((n, v) => n + v.registered, 0),
    checkedIn: views.reduce((n, v) => n + v.checkedIn, 0),
    ratePercent: regStarted > 0 ? round1((inStarted / regStarted) * 100) : null,
    feedbackCount,
    feedbackAverage: feedbackCount ? round2(feedbackTotal / feedbackCount) : null,
    certificates: views.reduce((n, v) => n + v.certificates, 0),
    budget: {
      estimateMinor: views.reduce((n, v) => n + (v.budget?.estimateMinor ?? 0), 0),
      actualMinor: views.reduce((n, v) => n + (v.budget?.actualMinor ?? 0), 0),
      overBudgetEvents: views.filter((v) => v.budget?.overBudget).length,
    },
  };
}

function zeroFilled(series: Map<string, number>, from: string, to: string) {
  const out: { date: string; count: number }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, count: series.get(d) ?? 0 });
  return out;
}

export interface HallUsageView {
  id: string;
  name: string;
  capacity: number;
  bookings: number;
  bookedHours: number;
  availableHours: number;
  utilizationPercent: number;
}

async function hallViews(ctx: AppContext, p: ReturnType<typeof period>): Promise<HallUsageView[]> {
  const availableHours = p.days * repo.OPERATING_HOURS_PER_DAY;
  return (await repo.hallUsage(ctx.pool, p)).map((h) => ({
    ...h,
    availableHours,
    utilizationPercent: round1((h.bookedHours / availableHours) * 100),
  }));
}

/** The admin and HOD summary: every event of the period with its numbers, totals, and (admins) departments and halls. */
export async function summary(ctx: AppContext, user: AuthUser, q: z.infer<typeof periodQuery>) {
  const { departmentId } = scope(user, q.departmentId);
  const p = period(ctx, q);
  const { views, truncated, raw } = await rowsFor(ctx, p, departmentId);

  const byDepartment = new Map<
    string,
    { name: string; views: EventRowView[]; raw: repo.EventStatsRow[] }
  >();
  views.forEach((v, i) => {
    const entry = byDepartment.get(v.department.id) ?? {
      name: v.department.name,
      views: [],
      raw: [],
    };
    entry.views.push(v);
    entry.raw.push(raw[i]!);
    byDepartment.set(v.department.id, entry);
  });
  const registrations = await repo.registrationsPerDay(ctx.pool, { ...p, departmentId });
  return {
    period: { from: p.from, to: p.to, days: p.days },
    scope: { departmentId: departmentId ?? null },
    truncated,
    totals: totalsOf(views, raw),
    events: views,
    departments: [...byDepartment.entries()]
      .map(([id, d]) => ({ id, name: d.name, ...totalsOf(d.views, d.raw) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    registrationsPerDay: zeroFilled(registrations, p.from, p.to),
    halls: isAdmin(user) ? await hallViews(ctx, p) : null,
  };
}

/** One event's own analytics, for its organizer, its department's staff and admins. */
export async function eventAnalytics(ctx: AppContext, user: AuthUser, eventId: string) {
  const event = await getEventById(ctx.pool, eventId);
  if (!event || !canView(user, event)) throw errors.notFound('Event');
  if (!canViewWorkflow(user, event)) throw errors.forbidden();

  const [registered, attendance, feedback, certs, perDay] = await Promise.all([
    countRegistered(ctx.pool, eventId),
    attendanceReport(ctx.pool, eventId),
    feedbackSummary(ctx.pool, eventId),
    listCertificatesForEvent(ctx.pool, eventId),
    repo.registrationsPerDay(ctx.pool, {
      from: '',
      to: '',
      timezone: ctx.config.APP_TIMEZONE,
      eventId,
    }),
  ]);
  const checkedIn = attendance.length;
  const now = new Date();
  const days = [...perDay.keys()].sort();
  const series: { date: string; count: number; cumulative: number }[] = [];
  let running = 0;
  if (days.length) {
    for (let d = days[0]!; d <= days[days.length - 1]!; d = addDays(d, 1)) {
      running += perDay.get(d) ?? 0;
      series.push({ date: d, count: perDay.get(d) ?? 0, cumulative: running });
    }
  }
  const budget = canSeeBudget(user, event)
    ? summarizeBudget((await budgetTotalsForEvents(ctx.pool, [eventId])).get(eventId) ?? [])
    : null;
  return {
    event: {
      id: event.id,
      title: event.title,
      status: event.status,
      startAt: event.startAt.toISOString(),
      endAt: event.endAt.toISOString(),
      capacity: event.capacity,
    },
    registrations: { registered, perDay: series },
    attendance: {
      checkedIn,
      ratePercent:
        event.startAt <= now && registered > 0 ? round1((checkedIn / registered) * 100) : null,
      noShows: event.endAt <= now ? Math.max(0, registered - checkedIn) : null,
      completed: attendance.filter((a) => a.completed).length,
    },
    feedback: {
      count: feedback.count,
      average: feedback.average,
      distribution: feedback.distribution,
    },
    certificates: { issued: certs.length },
    budget,
  };
}

// ---- CSV ---------------------------------------------------------------------------------------

const localDateTime = (ctx: AppContext, iso: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: ctx.config.APP_TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  })
    .format(new Date(iso))
    .replace(',', '');

export async function eventsCsv(ctx: AppContext, user: AuthUser, q: z.infer<typeof periodQuery>) {
  const { departmentId } = scope(user, q.departmentId);
  const p = period(ctx, q);
  const { views } = await rowsFor(ctx, p, departmentId);
  const header = [
    'Event',
    'Department',
    'Organizer',
    'Starts (India time)',
    'Status',
    'Registered',
    'Checked in',
    'Attendance rate %',
    'Did not come',
    'Feedback responses',
    'Feedback average',
    'Certificates issued',
    'Budget estimate (INR)',
    'Budget actual (INR)',
    'Over budget',
  ];
  const kinds = [
    'text',
    'text',
    'text',
    'text',
    'text',
    'number',
    'number',
    'number',
    'number',
    'number',
    'number',
    'number',
    'number',
    'number',
    'text',
  ] as const;
  const rows = views.map((v) => [
    v.title,
    v.department.name,
    v.organizer,
    localDateTime(ctx, v.startAt),
    v.status,
    v.registered,
    v.checkedIn,
    v.ratePercent,
    v.noShows,
    v.feedbackCount,
    v.feedbackAverage,
    v.certificates,
    formatMinor(v.budget?.estimateMinor ?? 0),
    formatMinor(v.budget?.actualMinor ?? 0),
    v.budget?.overBudget ? 'Yes' : 'No',
  ]);
  return { filename: `events-${p.from}-to-${p.to}.csv`, body: toCsv(header, [...kinds], rows) };
}

export async function hallsCsv(ctx: AppContext, user: AuthUser, q: z.infer<typeof periodQuery>) {
  if (!isAdmin(user)) throw errors.forbidden();
  const p = period(ctx, q);
  const halls = await hallViews(ctx, p);
  const body = toCsv(
    ['Hall', 'Capacity', 'Confirmed bookings', 'Booked hours', 'Available hours', 'Utilization %'],
    ['text', 'number', 'number', 'number', 'number', 'number'],
    halls.map((h) => [
      h.name,
      h.capacity,
      h.bookings,
      h.bookedHours,
      h.availableHours,
      h.utilizationPercent,
    ]),
  );
  return { filename: `hall-utilization-${p.from}-to-${p.to}.csv`, body };
}
