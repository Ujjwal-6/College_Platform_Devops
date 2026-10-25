import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approveFully,
  as,
  buildOrg,
  buildTestApp,
  createDraft,
  futureRange,
  istDate,
  resetDb,
  type Org,
} from './helpers.js';

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

/** YYYY-MM-DD shifted by n days (pure calendar arithmetic, no time zones involved). */
const shift = (ymd: string, n: number) =>
  new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
/** An instant given as local India time. */
const ist = (ymd: string, hm: string) => `${ymd}T${hm}:00+05:30`;
const D = istDate(futureRange(90).startAt); // the "restricted" day used throughout

const entry = (overrides: Record<string, unknown> = {}) => ({
  type: 'exam_period',
  title: 'End-semester exams',
  startDate: D,
  endDate: D,
  ...overrides,
});
const addEntry = (overrides: Record<string, unknown> = {}) =>
  as(t, org.admin).post('/api/calendar/entries', entry(overrides));
const range = (startAt: string, endAt: string) => ({ startAt, endAt });
const submitOn = async (startAt: string, endAt: string, who = org.organizer) => {
  const id = await createDraft(t, who, range(startAt, endAt));
  return { id, res: await as(t, who).post(`/api/events/${id}/submit`) };
};
const check = async (startAt: string, endAt: string, departmentId?: string) => {
  const q = new URLSearchParams({ startAt, endAt, ...(departmentId ? { departmentId } : {}) });
  return (await as(t, org.organizer).get(`/api/calendar/check?${q}`)).body.data as {
    blocks: { title: string }[];
    warnings: { title: string }[];
  };
};

describe('managing calendar entries', () => {
  it('lets admins create, edit and delete entries, and audits each change', async () => {
    const created = await addEntry();
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      type: 'exam_period',
      severity: 'block',
      startDate: D,
      endDate: D,
      departmentId: null,
      isActive: true,
    });
    const id = created.body.data.id as string;

    const edited = await as(t, org.admin).patch(`/api/calendar/entries/${id}`, {
      title: 'Mid-term exams',
      endDate: shift(D, 2),
    });
    expect(edited.body.data).toMatchObject({ title: 'Mid-term exams', endDate: shift(D, 2) });
    expect((await as(t, org.admin).delete(`/api/calendar/entries/${id}`)).status).toBe(204);
    expect((await as(t, org.admin).delete(`/api/calendar/entries/${id}`)).status).toBe(404);

    const audit = await t.ctx.pool.query(
      "SELECT action, target_id FROM audit_log WHERE action LIKE 'calendar.%' ORDER BY id",
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'calendar.entry_created',
      'calendar.entry_updated',
      'calendar.entry_deleted',
    ]);
    expect(audit.rows.every((r) => r.target_id === id)).toBe(true);
  });

  it('only admins may change the calendar (403), and everyone must be signed in (401)', async () => {
    const id = (await addEntry()).body.data.id as string;
    for (const who of [org.student, org.organizer, org.faculty, org.hod]) {
      expect((await as(t, who).post('/api/calendar/entries', entry())).status).toBe(403);
      expect(
        (await as(t, who).patch(`/api/calendar/entries/${id}`, { title: 'Nope' })).status,
      ).toBe(403);
      expect((await as(t, who).delete(`/api/calendar/entries/${id}`)).status).toBe(403);
      expect((await as(t, who).get(`/api/calendar/entries/${id}/conflicts`)).status).toBe(403);
    }
    expect((await request(t.app).get('/api/calendar/entries')).status).toBe(401);
    expect((await request(t.app).post('/api/calendar/entries').send(entry())).status).toBe(401);
    expect((await request(t.app).get('/api/calendar/check')).status).toBe(401);
  });

  it('lets everyone read active entries, but only admins see inactive ones', async () => {
    await addEntry({ title: 'Active one' });
    await addEntry({ title: 'Hidden one', isActive: false });
    const student = await as(t, org.student).get('/api/calendar/entries?includeInactive=true');
    expect(student.body.data.map((e: { title: string }) => e.title)).toEqual(['Active one']);
    const admin = await as(t, org.admin).get('/api/calendar/entries?includeInactive=true');
    expect(admin.body.data).toHaveLength(2);
    expect((await as(t, org.admin).get('/api/calendar/entries')).body.data).toHaveLength(1);
  });

  it('filters by date window', async () => {
    await addEntry({ title: 'Near', startDate: D, endDate: D });
    await addEntry({ title: 'Far', startDate: shift(D, 100), endDate: shift(D, 101) });
    const res = await as(t, org.student).get(
      `/api/calendar/entries?from=${shift(D, 50)}&to=${shift(D, 150)}`,
    );
    expect(res.body.data.map((e: { title: string }) => e.title)).toEqual(['Far']);
  });

  it('applies the default severity per type, and lets the admin choose another', async () => {
    const sev = async (type: string, extra: Record<string, unknown> = {}) =>
      (await addEntry({ type, title: `T ${type} ${JSON.stringify(extra)}`, ...extra })).body.data
        .severity;
    expect(await sev('exam_period')).toBe('block');
    expect(await sev('holiday')).toBe('block');
    expect(await sev('major_fest')).toBe('warn');
    expect(await sev('academic_date')).toBe('warn');
    expect(await sev('other')).toBe('warn');
    expect(await sev('major_fest', { severity: 'block' })).toBe('block');
    expect(await sev('holiday', { severity: 'warn' })).toBe('warn');
  });

  it.each([
    ['end before start', { startDate: D, endDate: shift(D, -1) }],
    ['not a real date', { startDate: '2030-02-31', endDate: '2030-03-02' }],
    ['wrong date format', { startDate: '01/02/2030' }],
    ['unknown type', { type: 'party' }],
    ['unknown field', { color: 'red' }],
    ['unknown department', { departmentId: '00000000-0000-4000-8000-000000000000' }],
    ['short title', { title: 'x' }],
  ])('rejects %s with 400', async (_name, extra) => {
    expect((await addEntry(extra)).status).toBe(400);
  });

  it('validates the merged range on edit', async () => {
    const id = (await addEntry({ startDate: D, endDate: shift(D, 3) })).body.data.id as string;
    expect(
      (await as(t, org.admin).patch(`/api/calendar/entries/${id}`, { endDate: shift(D, -5) }))
        .status,
    ).toBe(400);
    expect((await as(t, org.admin).patch(`/api/calendar/entries/${id}`, {})).status).toBe(400);
    expect(
      (
        await as(t, org.admin).patch('/api/calendar/entries/00000000-0000-4000-8000-000000000000', {
          title: 'Ghost',
        })
      ).status,
    ).toBe(404);
  });
});

describe('date matching (the guard)', () => {
  beforeEach(async () => {
    await addEntry({ startDate: D, endDate: shift(D, 2) }); // blocks three whole days
  });

  it('flags events inside, overlapping either edge, and spanning the entry', async () => {
    for (const [a, b] of [
      [ist(D, '10:00'), ist(D, '12:00')], // inside
      [ist(shift(D, -1), '20:00'), ist(D, '02:00')], // enters from the day before
      [ist(shift(D, 2), '22:00'), ist(shift(D, 3), '02:00')], // leaves after the last day
      [ist(shift(D, -1), '10:00'), ist(shift(D, 3), '10:00')], // spans the whole entry
    ] as const) {
      expect((await check(a, b)).blocks, `${a} → ${b}`).toHaveLength(1);
    }
  });

  it('allows events that end exactly at the start or begin exactly after the end (half-open ranges)', async () => {
    expect((await check(ist(shift(D, -1), '20:00'), ist(D, '00:00'))).blocks).toHaveLength(0);
    expect((await check(ist(shift(D, 3), '00:00'), ist(shift(D, 3), '03:00'))).blocks).toHaveLength(
      0,
    );
    expect(
      (await check(ist(shift(D, -5), '10:00'), ist(shift(D, -4), '10:00'))).blocks,
    ).toHaveLength(0);
  });

  it('uses the college time zone for day boundaries, not UTC', async () => {
    // 18:00Z = 23:30 IST on day D-1: outside. 18:30Z = 00:00 IST on day D: inside.
    const dayBefore = shift(D, -1);
    expect((await check(`${dayBefore}T18:00:00Z`, `${dayBefore}T18:29:00Z`)).blocks).toHaveLength(
      0,
    );
    expect((await check(`${dayBefore}T18:00:00Z`, `${dayBefore}T18:31:00Z`)).blocks).toHaveLength(
      1,
    );
    // the last blocked day ends at 18:30Z on D+2
    const last = shift(D, 2);
    expect((await check(`${last}T18:00:00Z`, `${last}T18:20:00Z`)).blocks).toHaveLength(1);
    expect((await check(`${last}T18:30:00Z`, `${last}T19:30:00Z`)).blocks).toHaveLength(0);
  });

  it('separates hard blocks from soft warnings and reports both', async () => {
    await addEntry({ type: 'major_fest', title: 'Cultural fest', startDate: D, endDate: D });
    const res = await check(ist(D, '10:00'), ist(D, '12:00'));
    expect(res.blocks.map((e) => e.title)).toEqual(['End-semester exams']);
    expect(res.warnings.map((e) => e.title)).toEqual(['Cultural fest']);
  });

  it('respects department scope: a scoped entry affects only that department', async () => {
    await resetDb(t.ctx);
    org = await buildOrg(t);
    await addEntry({ title: 'ECE labs', departmentId: org.ece });
    expect((await check(ist(D, '10:00'), ist(D, '12:00'), org.ece)).blocks).toHaveLength(1);
    expect((await check(ist(D, '10:00'), ist(D, '12:00'), org.cse)).blocks).toHaveLength(0);
    await addEntry({ title: 'Everyone', startDate: shift(D, 20), endDate: shift(D, 20) });
    expect(
      (await check(ist(shift(D, 20), '10:00'), ist(shift(D, 20), '12:00'), org.cse)).blocks,
    ).toHaveLength(1);
  });

  it('ignores inactive entries and picks them up again when reactivated', async () => {
    const list = await as(t, org.admin).get('/api/calendar/entries');
    const id = list.body.data[0].id as string;
    await as(t, org.admin).patch(`/api/calendar/entries/${id}`, { isActive: false });
    expect((await check(ist(D, '10:00'), ist(D, '12:00'))).blocks).toHaveLength(0);
    await as(t, org.admin).patch(`/api/calendar/entries/${id}`, { isActive: true });
    expect((await check(ist(D, '10:00'), ist(D, '12:00'))).blocks).toHaveLength(1);
  });

  it('validates the check request', async () => {
    expect(
      (
        await as(t, org.student).get(
          `/api/calendar/check?startAt=${ist(D, '12:00')}&endAt=${ist(D, '10:00')}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await as(t, org.student).get('/api/calendar/check?startAt=yesterday&endAt=today')).status,
    ).toBe(400);
  });
});

describe('academic calendar guard on events', () => {
  it('lets drafts be created and edited on restricted dates, but shows the problem to the owner', async () => {
    await addEntry({ startDate: D, endDate: D });
    const id = await createDraft(t, org.organizer, range(ist(D, '10:00'), ist(D, '12:00')));
    const detail = (await as(t, org.organizer).get(`/api/events/${id}`)).body.data;
    expect(detail.calendar.blocks).toHaveLength(1);
    expect(detail.calendar.blocks[0].title).toBe('End-semester exams');
    expect(
      (await as(t, org.organizer).patch(`/api/events/${id}`, { title: 'Still saves fine' })).status,
    ).toBe(200);
  });

  it('refuses submission on blocked dates with 422 and changes nothing (AT-20.1)', async () => {
    await addEntry({ startDate: shift(D, -1), endDate: shift(D, 1) });
    const { id, res } = await submitOn(ist(D, '10:00'), ist(D, '12:00'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CALENDAR_BLOCKED');
    expect(res.body.error.details.entries[0]).toMatchObject({
      title: 'End-semester exams',
      severity: 'block',
    });
    const row = (
      await t.ctx.pool.query('SELECT status, submission_round FROM events WHERE id = $1', [id])
    ).rows[0];
    expect(row).toEqual({ status: 'draft', submission_round: 0 });
    expect((await t.ctx.pool.query("SELECT 1 FROM jobs WHERE type = 'email.send'")).rowCount).toBe(
      0,
    );
    expect(
      (await t.ctx.pool.query("SELECT 1 FROM audit_log WHERE action = 'event.submitted'")).rowCount,
    ).toBe(0);
  });

  it('accepts submission on warning dates and carries the warning to the approvers (AT-20.2)', async () => {
    await addEntry({ type: 'major_fest', title: 'Annual Fest', startDate: D, endDate: D });
    const { id, res } = await submitOn(ist(D, '10:00'), ist(D, '12:00'));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('pending_approval');
    const forApprover = (await as(t, org.faculty).get(`/api/events/${id}`)).body.data;
    expect(forApprover.calendarWarnings).toMatchObject([
      { title: 'Annual Fest', type: 'major_fest', startDate: D },
    ]);
    expect(forApprover.calendar.warnings).toHaveLength(1);
    // people who cannot see the workflow do not see calendar internals
    await approveFully(t, id, { faculty: org.faculty, hod: org.hod, admin: org.admin });
    await as(t, org.organizer).post(`/api/events/${id}/publish`);
    const publicView = (await as(t, org.student).get(`/api/events/${id}`)).body.data;
    expect(publicView.calendar).toBeNull();
    expect(publicView.calendarWarnings).toEqual([]);
  });

  it('reports every blocking entry and blocks even when a warning also applies (AT-20.3)', async () => {
    await addEntry({ title: 'Exams A', startDate: D, endDate: D });
    await addEntry({ type: 'holiday', title: 'Holiday B', startDate: D, endDate: D });
    await addEntry({ type: 'major_fest', title: 'Fest C', startDate: D, endDate: D });
    const { res } = await submitOn(ist(D, '10:00'), ist(D, '12:00'));
    expect(res.status).toBe(422);
    expect(res.body.error.details.entries.map((e: { title: string }) => e.title).sort()).toEqual([
      'Exams A',
      'Holiday B',
    ]);
  });

  it('accepts an event that ends exactly when a blocked period starts (AT-20.4)', async () => {
    await addEntry({ startDate: D, endDate: D });
    const { res } = await submitOn(ist(shift(D, -1), '22:00'), ist(D, '00:00'));
    expect(res.status).toBe(200);
  });

  it('does not block a department the entry is not scoped to (AT-20.5)', async () => {
    await addEntry({ title: 'ECE exams', departmentId: org.ece });
    expect((await submitOn(ist(D, '10:00'), ist(D, '12:00'), org.organizer)).res.status).toBe(200);
    expect((await submitOn(ist(D, '10:00'), ist(D, '12:00'), org.otherOrganizer)).res.status).toBe(
      422,
    );
  });

  it('lets the same event through once the blocking entry is deactivated or deleted (AT-20.6)', async () => {
    const id = (await addEntry()).body.data.id as string;
    const { id: eventId, res } = await submitOn(ist(D, '10:00'), ist(D, '12:00'));
    expect(res.status).toBe(422);
    await as(t, org.admin).patch(`/api/calendar/entries/${id}`, { isActive: false });
    expect((await as(t, org.organizer).post(`/api/events/${eventId}/submit`)).status).toBe(200);

    await as(t, org.admin).patch(`/api/calendar/entries/${id}`, { isActive: true });
    const second = await submitOn(ist(D, '13:00'), ist(D, '15:00'));
    expect(second.res.status).toBe(422);
    await as(t, org.admin).delete(`/api/calendar/entries/${id}`);
    expect((await as(t, org.organizer).post(`/api/events/${second.id}/submit`)).status).toBe(200);
  });

  it('offers no override: nobody, not even an admin, can submit around a block', async () => {
    await addEntry();
    const id = await createDraft(t, org.admin, {
      departmentId: org.cse,
      ...range(ist(D, '10:00'), ist(D, '12:00')),
    });
    expect((await as(t, org.admin).post(`/api/events/${id}/submit`)).status).toBe(422);
  });

  it('leaves existing events untouched when a block is added later, and reports them to the admin (AT-20.8)', async () => {
    const { id } = await submitOn(ist(D, '10:00'), ist(D, '12:00'));
    const published = await submitOn(ist(D, '14:00'), ist(D, '16:00'));
    await approveFully(t, published.id, { faculty: org.faculty, hod: org.hod, admin: org.admin });
    await as(t, org.organizer).post(`/api/events/${published.id}/publish`);

    const created = await addEntry();
    expect(created.body.conflicts.map((c: { id: string }) => c.id).sort()).toEqual(
      [id, published.id].sort(),
    );
    const report = await as(t, org.admin).get(
      `/api/calendar/entries/${created.body.data.id}/conflicts`,
    );
    expect(report.body.data).toHaveLength(2);
    const states = await t.ctx.pool.query('SELECT id, status FROM events ORDER BY created_at');
    expect(states.rows.map((r) => r.status).sort()).toEqual(['pending_approval', 'published']);
  });

  it('omits drafts, cancelled events, and other departments from the conflict report', async () => {
    await createDraft(t, org.organizer, range(ist(D, '10:00'), ist(D, '12:00'))); // draft
    const cancelled = await submitOn(ist(D, '10:00'), ist(D, '12:00'));
    await as(t, org.organizer).post(`/api/events/${cancelled.id}/cancel`, {
      comment: 'Changed plans',
    });
    const entryId = (await addEntry({ departmentId: org.ece })).body.data.id as string;
    await submitOn(ist(D, '10:00'), ist(D, '12:00'), org.organizer); // CSE event, entry is ECE-only
    expect(
      (await as(t, org.admin).get(`/api/calendar/entries/${entryId}/conflicts`)).body.data,
    ).toEqual([]);
  });
});
