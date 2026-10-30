import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveFully,
  as,
  buildOrg,
  buildTestApp,
  createDraft,
  createHall,
  resetDb,
  type LoggedIn,
  type Org,
} from './helpers.js';
import { createPublishedEvent, register, students } from './registration-helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const summary = (who: LoggedIn, query = '') => as(t, who).get(`/api/analytics/summary${query}`);
const csv = (who: LoggedIn, file: string, query = '') =>
  as(t, who).get(`/api/analytics/${file}${query}`);

/** Publishes an ECE event (the other department) with its own approvers. */
async function publishEce(over: Record<string, unknown> = {}) {
  const id = await createDraft(t, org.otherOrganizer, over);
  await as(t, org.otherOrganizer).post(`/api/events/${id}/submit`);
  await approveFully(t, id, { faculty: org.otherFaculty, hod: org.otherHod, admin: org.admin });
  expect((await as(t, org.otherOrganizer).post(`/api/events/${id}/publish`)).status).toBe(200);
  return id;
}
interface Spec {
  dept?: 'cse' | 'ece';
  registered: number;
  attended: number;
  title?: string;
  /** SQL for the start and end, relative to now. Default: it ran from 3 hours ago to 10 minutes ago. */
  when?: [string, string];
  status?: string;
}
async function make(spec: Spec) {
  const title = spec.title ?? `Event ${Math.random().toString(36).slice(2, 7)}`;
  const ev =
    spec.dept === 'ece'
      ? await publishEce({ title })
      : await createPublishedEvent(t, org, { title });
  const people = await students(t, spec.registered);
  const regs: string[] = [];
  for (const p of people) regs.push((await register(t, p, ev)).body.data.id as string);
  const [start, end] = spec.when ?? ["now() - interval '3 hours'", "now() - interval '10 minutes'"];
  await q(
    `UPDATE events SET start_at = ${start}, end_at = ${end}${spec.status ? `, status = '${spec.status}'` : ''} WHERE id = $1`,
    [ev],
  );
  for (let i = 0; i < spec.attended; i++) {
    await q(
      "INSERT INTO attendance (registration_id, event_id, user_id, checked_in_by, method) VALUES ($1, $2, $3, $4, 'qr')",
      [regs[i], ev, people[i]!.user.id, org.admin.user.id],
    );
  }
  return { ev, people, regs, title };
}
const budgetItem = (ev: string, kind: string, minor: number, category = 'venue') =>
  q(
    "INSERT INTO budget_items (event_id, kind, category, description, amount_minor, created_by) VALUES ($1, $2, $3, 'x', $4, $5)",
    [ev, kind, category, minor, org.admin.user.id],
  );
const feedback = async (ev: string, people: { user: { id: string } }[], ratings: number[]) => {
  for (let i = 0; i < ratings.length; i++)
    await q('INSERT INTO feedback (event_id, user_id, rating) VALUES ($1, $2, $3)', [
      ev,
      people[i]!.user.id,
      ratings[i],
    ]);
};

describe('the numbers (AC-9.3)', () => {
  it('works out the attendance rate as checked in ÷ registered, per event and overall', async () => {
    const a = await make({ registered: 10, attended: 8, title: 'Alpha' });
    const b = await make({ dept: 'ece', registered: 5, attended: 5, title: 'Beta' });
    const res = await summary(org.admin);
    expect(res.status).toBe(200);
    const byTitle = Object.fromEntries(
      res.body.data.events.map((e: { title: string }) => [e.title, e]),
    );
    expect(byTitle.Alpha).toMatchObject({
      registered: 10,
      checkedIn: 8,
      ratePercent: 80,
      noShows: 2,
    });
    expect(byTitle.Beta).toMatchObject({
      registered: 5,
      checkedIn: 5,
      ratePercent: 100,
      noShows: 0,
    });
    expect(res.body.data.totals).toMatchObject({
      events: 2,
      registered: 15,
      checkedIn: 13,
      ratePercent: 86.7,
    });
    void a;
    void b;
  });

  it('adds up feedback exactly and averages by responses, not by events', async () => {
    const a = await make({ registered: 3, attended: 3, title: 'Alpha' });
    const b = await make({ dept: 'ece', registered: 1, attended: 1, title: 'Beta' });
    await feedback(a.ev, a.people, [5, 4, 4]);
    await feedback(b.ev, b.people, [3]);
    const data = (await summary(org.admin)).body.data;
    const rows = Object.fromEntries(data.events.map((e: { title: string }) => [e.title, e]));
    expect(rows.Alpha).toMatchObject({ feedbackCount: 3, feedbackAverage: 4.33 });
    expect(rows.Beta).toMatchObject({ feedbackCount: 1, feedbackAverage: 3 });
    expect(data.totals).toMatchObject({ feedbackCount: 4, feedbackAverage: 4 }); // (13 + 3) / 4, not (4.33 + 3) / 2
  });

  it('counts certificates that stand, not withdrawn ones', async () => {
    const a = await make({ registered: 3, attended: 3 });
    for (let i = 0; i < 3; i++) {
      await q(
        "INSERT INTO certificates (event_id, user_id, code, holder_name) VALUES ($1, $2, $3, 'x')",
        [a.ev, a.people[i]!.user.id, `CODE-${i}`],
      );
    }
    await q(
      "UPDATE certificates SET revoked_at = now(), revoked_by = $1, revoke_reason = 'mistake' WHERE code = 'CODE-0'",
      [org.admin.user.id],
    );
    expect((await summary(org.admin)).body.data.totals.certificates).toBe(2);
  });

  it('adds up budgets exactly and counts events over budget', async () => {
    const a = await make({ registered: 1, attended: 1, title: 'Alpha' });
    const b = await make({ dept: 'ece', registered: 1, attended: 1, title: 'Beta' });
    await budgetItem(a.ev, 'estimate', 100_000);
    await budgetItem(a.ev, 'actual', 120_001);
    await budgetItem(b.ev, 'estimate', 50_000);
    await budgetItem(b.ev, 'actual', 20_000);
    const data = (await summary(org.admin)).body.data;
    const rows = Object.fromEntries(data.events.map((e: { title: string }) => [e.title, e]));
    expect(rows.Alpha.budget).toEqual({
      estimateMinor: 100_000,
      actualMinor: 120_001,
      overBudget: true,
    });
    expect(rows.Beta.budget).toEqual({
      estimateMinor: 50_000,
      actualMinor: 20_000,
      overBudget: false,
    });
    expect(data.totals.budget).toEqual({
      estimateMinor: 150_000,
      actualMinor: 140_001,
      overBudgetEvents: 1,
    });
  });

  it('leaves the rate and the no-shows empty until an event has started or ended, and does not let it drag the rate down', async () => {
    await make({ registered: 10, attended: 10, title: 'Done' });
    await make({
      registered: 5,
      attended: 0,
      title: 'Next week',
      when: ["now() + interval '7 days'", "now() + interval '7 days 2 hours'"],
    });
    await make({
      registered: 4,
      attended: 1,
      title: 'Right now',
      when: ["now() - interval '1 hour'", "now() + interval '1 hour'"],
    });
    const next = (
      await q(
        "SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata') + interval '10 days', 'YYYY-MM-DD') AS d",
      )
    )[0].d as string;
    const data = (await summary(org.admin, `?to=${next}`)).body.data;
    const rows = Object.fromEntries(data.events.map((e: { title: string }) => [e.title, e]));
    expect(rows['Next week']).toMatchObject({
      registered: 5,
      checkedIn: 0,
      ratePercent: null,
      noShows: null,
    });
    expect(rows['Right now']).toMatchObject({ ratePercent: 25, noShows: null });
    expect(rows.Done).toMatchObject({ ratePercent: 100, noShows: 0 });
    expect(data.totals.registered).toBe(19); // everyone counts
    expect(data.totals.ratePercent).toBe(78.6); // but only events that started: (10 + 1) / (10 + 4)
  });

  it('shows no rate when nobody registered', async () => {
    await make({ registered: 0, attended: 0, title: 'Empty' });
    const data = (await summary(org.admin)).body.data;
    expect(data.events[0]).toMatchObject({ registered: 0, ratePercent: null, noShows: 0 });
    expect(data.totals.ratePercent).toBeNull();
    expect(data.totals.feedbackAverage).toBeNull();
  });

  it('only includes published and closed events', async () => {
    await make({ registered: 1, attended: 1, title: 'Published' });
    await make({ registered: 1, attended: 1, title: 'Closed', status: 'closed' });
    const { createApprovedEvent } = await import('./helpers.js');
    const approved = await createApprovedEvent(t, org, { title: 'Approved only' });
    await createDraft(t, org.organizer, { title: 'A draft' });
    await q(
      "UPDATE events SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1",
      [approved],
    );
    const titles = (await summary(org.admin)).body.data.events
      .map((e: { title: string }) => e.title)
      .sort();
    expect(titles).toEqual(['Closed', 'Published']);
  });
});

describe('period', () => {
  it('shows the last 90 days by default, and a chosen period when asked', async () => {
    await make({ registered: 1, attended: 1, title: 'Recent' });
    await make({
      registered: 1,
      attended: 1,
      title: 'Old',
      when: ["now() - interval '200 days'", "now() - interval '200 days' + interval '2 hours'"],
    });
    const def = (await summary(org.admin)).body.data;
    expect(def.period.days).toBe(90);
    expect(def.events.map((e: { title: string }) => e.title)).toEqual(['Recent']);

    const day = (
      await q(
        "SELECT to_char((now() - interval '200 days') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d",
      )
    )[0].d as string;
    const wide = (await summary(org.admin, `?from=${day}&to=${day}`)).body.data;
    expect(wide.period).toEqual({ from: day, to: day, days: 1 });
    expect(wide.events.map((e: { title: string }) => e.title)).toEqual(['Old']);
  });

  it('includes both end days of the period, in India time', async () => {
    const today = (
      await q("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d")
    )[0].d as string;
    await make({
      registered: 1,
      attended: 1,
      title: 'Today',
      when: [
        "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '9 hours') AT TIME ZONE 'Asia/Kolkata'",
        "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '11 hours') AT TIME ZONE 'Asia/Kolkata'",
      ],
    });
    expect((await summary(org.admin, `?from=${today}&to=${today}`)).body.data.events).toHaveLength(
      1,
    );
    const tomorrow = (
      await q(
        "SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day', 'YYYY-MM-DD') AS d",
      )
    )[0].d as string;
    expect(
      (await summary(org.admin, `?from=${tomorrow}&to=${tomorrow}`)).body.data.events,
    ).toHaveLength(0);
  });

  it('refuses a bad, reversed or over-long period and unknown parameters (400)', async () => {
    for (const query of [
      '?from=2031-02-30',
      '?from=01/03/2031',
      '?from=2031-03-05&to=2031-03-01',
      '?from=2020-01-01&to=2031-01-01',
      '?x=1',
      '?departmentId=nope',
    ]) {
      expect((await summary(org.admin, query)).status, query).toBe(400);
    }
    expect((await summary(org.admin, '?from=2031-01-01&to=2031-12-31')).status).toBe(200); // 365 days is fine
  });
});

describe('who may see the summaries', () => {
  it('lets admins see every department, and HODs only their own', async () => {
    await make({ registered: 2, attended: 2, title: 'Computer event' });
    await make({ dept: 'ece', registered: 3, attended: 1, title: 'Electronics event' });
    const all = (await summary(org.admin)).body.data;
    expect(all.events).toHaveLength(2);
    expect(all.departments.map((d: { name: string }) => d.name)).toEqual([
      'Computer Science',
      'Electronics',
    ]);

    const cse = (await summary(org.hod)).body.data;
    expect(cse.events.map((e: { title: string }) => e.title)).toEqual(['Computer event']);
    expect(cse.totals.registered).toBe(2);
    expect(cse.halls).toBeNull();
    const ece = (await summary(org.otherHod)).body.data;
    expect(ece.events.map((e: { title: string }) => e.title)).toEqual(['Electronics event']);
    expect(all.halls).toEqual([]);
  });

  it('lets an admin narrow it to one department, and stops a HOD asking for another', async () => {
    await make({ registered: 2, attended: 2, title: 'Computer event' });
    await make({ dept: 'ece', registered: 3, attended: 1, title: 'Electronics event' });
    expect(
      (await summary(org.admin, `?departmentId=${org.ece}`)).body.data.events.map(
        (e: { title: string }) => e.title,
      ),
    ).toEqual(['Electronics event']);
    expect((await summary(org.hod, `?departmentId=${org.cse}`)).status).toBe(200);
    expect((await summary(org.hod, `?departmentId=${org.ece}`)).status).toBe(403);
    expect((await csv(org.hod, 'events.csv', `?departmentId=${org.ece}`)).status).toBe(403);
  });

  it('refuses organizers, faculty and students (403) and anyone not signed in (401)', async () => {
    await make({ registered: 1, attended: 1 });
    for (const who of [
      org.organizer,
      org.faculty,
      org.faculty2,
      org.student,
      org.otherOrganizer,
      org.otherFaculty,
    ]) {
      expect((await summary(who)).status, who.user.email).toBe(403);
      expect((await csv(who, 'events.csv')).status).toBe(403);
      expect((await csv(who, 'halls.csv')).status).toBe(403);
    }
    for (const path of ['summary', 'events.csv', 'halls.csv'])
      expect((await request(t.app).get(`/api/analytics/${path}`)).status).toBe(401);
  });
});

describe('registrations over time', () => {
  it('counts registrations on each local day, with the empty days shown as zero', async () => {
    const a = await make({ registered: 5, attended: 0 });
    const day = (n: number) =>
      q(
        `SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata') - interval '${n} days', 'YYYY-MM-DD') AS d`,
      ).then((r) => r[0].d as string);
    await q(
      "UPDATE registrations SET registered_at = now() - interval '3 days' WHERE id = ANY($1)",
      [a.regs.slice(0, 2)],
    );
    await q("UPDATE registrations SET registered_at = now() - interval '1 day' WHERE id = $1", [
      a.regs[2],
    ]);
    const series = (await summary(org.admin, `?from=${await day(4)}&to=${await day(0)}`)).body.data
      .registrationsPerDay as { date: string; count: number }[];
    expect(series).toHaveLength(5);
    expect(Object.fromEntries(series.map((s) => [s.date, s.count]))).toEqual({
      [await day(4)]: 0,
      [await day(3)]: 2,
      [await day(2)]: 0,
      [await day(1)]: 1,
      [await day(0)]: 2,
    });
  });

  it('leaves out people who cancelled', async () => {
    const a = await make({ registered: 3, attended: 0 });
    await q(
      "UPDATE registrations SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'self' WHERE id = $1",
      [a.regs[0]],
    );
    const data = (await summary(org.admin)).body.data;
    expect(
      data.registrationsPerDay.reduce((n: number, d: { count: number }) => n + d.count, 0),
    ).toBe(2);
    expect(data.events[0].registered).toBe(2);
  });
});

describe('hall utilization', () => {
  /** A confirmed booking on a local day, between two local hours. */
  const book = (
    hall: string,
    ev: string,
    dayOffset: number,
    from: string,
    to: string,
    status = 'confirmed',
  ) =>
    q(
      `INSERT INTO hall_bookings (event_id, hall_id, requested_by, event_organizer_id, department_id, start_at, end_at, status, approval_level)
       SELECT e.id, $2, e.organizer_id, e.organizer_id, e.department_id,
              ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '${dayOffset} days') + time '${from}') AT TIME ZONE 'Asia/Kolkata',
              ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '${dayOffset} days') + time '${to}') AT TIME ZONE 'Asia/Kolkata',
              $3, CASE WHEN $3 = 'pending' THEN 'faculty' END
         FROM events e WHERE e.id = $1`,
      [ev, hall, status],
    );
  const fromTo = async (days: number) => {
    const to = (await q("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d"))[0]
      .d as string;
    const from = (
      await q(
        `SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata') - interval '${days - 1} days', 'YYYY-MM-DD') AS d`,
      )
    )[0].d as string;
    return `?from=${from}&to=${to}`;
  };

  it('works out the booked share of each hall’s operating day (08:00 to 20:00)', async () => {
    const ev = (await make({ registered: 1, attended: 1 })).ev;
    const hall = await createHall(t, org.admin, { name: 'Main Hall', capacity: 300 });
    await createHall(t, org.admin, { name: 'Quiet Room', capacity: 20 });
    await book(hall, ev, 0, '10:00', '12:00'); // 2 h
    await book(hall, ev, -1, '14:00', '16:30'); // 2.5 h
    await book(hall, ev, -2, '06:00', '09:00'); // only 08:00 to 09:00 is inside the window: 1 h
    await book(hall, ev, -3, '19:00', '22:00'); // only 19:00 to 20:00: 1 h
    const halls = (await summary(org.admin, await fromTo(10))).body.data.halls as {
      name: string;
      bookings: number;
      bookedHours: number;
      availableHours: number;
      utilizationPercent: number;
    }[];
    const main = halls.find((h) => h.name === 'Main Hall')!;
    expect(main).toMatchObject({
      bookings: 4,
      bookedHours: 6.5,
      availableHours: 120,
      utilizationPercent: 5.4,
    });
    expect(halls.find((h) => h.name === 'Quiet Room')).toMatchObject({
      bookings: 0,
      bookedHours: 0,
      utilizationPercent: 0,
    });
  });

  it('counts only confirmed bookings, active halls and the bookings inside the period', async () => {
    const ev = (await make({ registered: 1, attended: 1 })).ev;
    const hall = await createHall(t, org.admin, { name: 'Main Hall' });
    const closed = await createHall(t, org.admin, { name: 'Closed Hall' });
    await book(hall, ev, 0, '10:00', '11:00');
    await book(hall, ev, 0, '12:00', '13:00', 'pending');
    await book(hall, ev, 0, '14:00', '15:00', 'cancelled');
    await book(hall, ev, 0, '16:00', '17:00', 'rejected');
    await book(hall, ev, -30, '10:00', '12:00'); // a month ago: outside the 10-day period
    await book(closed, ev, 0, '10:00', '12:00');
    await q('UPDATE halls SET is_active = false WHERE id = $1', [closed]);
    const halls = (await summary(org.admin, await fromTo(10))).body.data.halls as {
      name: string;
      bookedHours: number;
    }[];
    expect(halls.map((h) => h.name)).toEqual(['Main Hall']);
    expect(halls[0]!.bookedHours).toBe(1);
  });

  it('never goes above 100% for a hall booked all day, every day', async () => {
    const ev = (await make({ registered: 1, attended: 1 })).ev;
    const hall = await createHall(t, org.admin, { name: 'Busy Hall' });
    for (let d = 0; d < 3; d++) await book(hall, ev, -d, '00:00', '23:59');
    const halls = (await summary(org.admin, await fromTo(3))).body.data.halls as {
      utilizationPercent: number;
      bookedHours: number;
    }[];
    expect(halls[0]).toMatchObject({ bookedHours: 36, utilizationPercent: 100 });
  });
});

describe('the CSV files', () => {
  it('lists every event with exact money and the right headers', async () => {
    const a = await make({ registered: 10, attended: 8, title: 'Alpha' });
    await budgetItem(a.ev, 'estimate', 150_050);
    await budgetItem(a.ev, 'actual', 200_005);
    const res = await csv(org.admin, 'events.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="events-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const lines = (res.text as string).split('\r\n');
    expect(lines[0]).toBe(
      'Event,Department,Organizer,Starts (India time),Status,Registered,Checked in,Attendance rate %,Did not come,Feedback responses,Feedback average,Certificates issued,Budget estimate (INR),Budget actual (INR),Over budget',
    );
    expect(lines[1]).toMatch(
      /^Alpha,Computer Science,Test organizer,\d{4}-\d{2}-\d{2} \d{2}:\d{2},published,10,8,80,2,0,,0,1500\.50,2000\.05,Yes$/,
    );
    expect(lines[2]).toBe(''); // the file ends with a line break
  });

  it('quotes awkward text and keeps spreadsheets from running a title as a formula', async () => {
    await make({ registered: 1, attended: 1, title: 'Talks, "workshops"\nand more' });
    await make({ registered: 1, attended: 1, title: '=HYPERLINK("http://evil.test","click")' });
    await make({ registered: 1, attended: 1, title: '+91 98765 hotline' });
    const body = (await csv(org.admin, 'events.csv')).text as string;
    expect(body).toContain('"Talks, ""workshops""\nand more"');
    expect(body).toContain('"\'=HYPERLINK(""http://evil.test"",""click"")"');
    expect(body).toContain("'+91 98765 hotline");
    expect(body).not.toMatch(/(^|\r\n)=HYPERLINK/);
    expect(body).not.toMatch(/(^|\r\n)\+91/);
  });

  it('gives a HOD only their department, and only admins the hall file', async () => {
    await make({ registered: 1, attended: 1, title: 'Computer event' });
    await make({ dept: 'ece', registered: 1, attended: 1, title: 'Electronics event' });
    const own = (await csv(org.hod, 'events.csv')).text as string;
    expect(own).toContain('Computer event');
    expect(own).not.toContain('Electronics event');
    expect((await csv(org.hod, 'halls.csv')).status).toBe(403);
    expect((await csv(org.admin, 'halls.csv')).status).toBe(200);
  });

  it('writes the hall file with the same numbers as the screen', async () => {
    const ev = (await make({ registered: 1, attended: 1 })).ev;
    const hall = await createHall(t, org.admin, { name: 'Main, Hall', capacity: 300 });
    await q(
      `INSERT INTO hall_bookings (event_id, hall_id, requested_by, event_organizer_id, department_id, start_at, end_at, status)
       SELECT e.id, $2, e.organizer_id, e.organizer_id, e.department_id,
              (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '10 hours') AT TIME ZONE 'Asia/Kolkata',
              (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '12 hours') AT TIME ZONE 'Asia/Kolkata', 'confirmed' FROM events e WHERE e.id = $1`,
      [ev, hall],
    );
    const res = await csv(org.admin, 'halls.csv', '?from=2031-01-01&to=2031-01-01');
    expect(res.headers['content-disposition']).toContain(
      'hall-utilization-2031-01-01-to-2031-01-01.csv',
    );
    expect((res.text as string).split('\r\n').slice(0, 2)).toEqual([
      'Hall,Capacity,Confirmed bookings,Booked hours,Available hours,Utilization %',
      '"Main, Hall",300,0,0,12,0',
    ]);
  });

  it('applies the same period rules to the files', async () => {
    expect((await csv(org.admin, 'events.csv', '?from=2031-03-05&to=2031-03-01')).status).toBe(400);
    expect((await csv(org.admin, 'halls.csv', '?x=1')).status).toBe(400);
  });
});

describe('one event’s analytics', () => {
  it('shows an organizer, department staff and admins the event’s numbers and its daily registrations', async () => {
    const a = await make({ registered: 4, attended: 3, title: 'Alpha' });
    await q(
      "UPDATE registrations SET registered_at = now() - interval '2 days' WHERE id = ANY($1)",
      [a.regs.slice(0, 2)],
    );
    await feedback(a.ev, a.people, [5, 3]);
    for (const who of [org.organizer, org.faculty, org.hod, org.admin]) {
      const res = await as(t, who).get(`/api/events/${a.ev}/analytics`);
      expect(res.status, who.user.email).toBe(200);
      expect(res.body.data.registrations.registered).toBe(4);
      expect(res.body.data.attendance).toMatchObject({ checkedIn: 3, ratePercent: 75, noShows: 1 });
      expect(res.body.data.feedback).toMatchObject({ count: 2, average: 4 });
      const days = res.body.data.registrations.perDay as { count: number; cumulative: number }[];
      expect(days.map((d) => d.count)).toEqual([2, 0, 2]);
      expect(days.map((d) => d.cumulative)).toEqual([2, 2, 4]);
    }
  });

  it('shows the budget to the organizer, the department’s HOD and faculty, and admins', async () => {
    const a = await make({ registered: 1, attended: 1 });
    await budgetItem(a.ev, 'estimate', 10_000);
    expect(
      (await as(t, org.organizer).get(`/api/events/${a.ev}/analytics`)).body.data.budget
        .estimateMinor,
    ).toBe(10_000);
    expect(
      (await as(t, org.hod).get(`/api/events/${a.ev}/analytics`)).body.data.budget.estimateMinor,
    ).toBe(10_000);
    expect(
      (await as(t, org.admin).get(`/api/events/${a.ev}/analytics`)).body.data.budget.estimateMinor,
    ).toBe(10_000);
    const faculty = await as(t, org.faculty).get(`/api/events/${a.ev}/analytics`);
    expect(faculty.status).toBe(200);
    expect(faculty.body.data.budget.estimateMinor).toBe(10_000);
    // faculty of another department see nothing of it
    expect((await as(t, org.otherFaculty).get(`/api/events/${a.ev}/analytics`)).status).toBe(403);
  });

  it('refuses everyone else (403), hides drafts (404) and needs a sign-in (401)', async () => {
    const a = await make({ registered: 1, attended: 1 });
    for (const who of [org.student, org.otherOrganizer, org.otherFaculty, org.otherHod]) {
      expect((await as(t, who).get(`/api/events/${a.ev}/analytics`)).status).toBe(403);
    }
    const draft = await createDraft(t, org.organizer);
    expect((await as(t, org.otherOrganizer).get(`/api/events/${draft}/analytics`)).status).toBe(
      404,
    );
    expect(
      (await as(t, org.admin).get('/api/events/11111111-1111-4111-8111-111111111111/analytics'))
        .status,
    ).toBe(404);
    expect((await as(t, org.admin).get('/api/events/not-a-uuid/analytics')).status).toBe(400);
    expect((await request(t.app).get(`/api/events/${a.ev}/analytics`)).status).toBe(401);
  });

  it('leaves the rate and no-shows empty for an event that has not happened', async () => {
    const a = await make({
      registered: 3,
      attended: 0,
      when: ["now() + interval '7 days'", "now() + interval '7 days 2 hours'"],
    });
    const res = await as(t, org.organizer).get(`/api/events/${a.ev}/analytics`);
    expect(res.body.data.attendance).toMatchObject({
      checkedIn: 0,
      ratePercent: null,
      noShows: null,
    });
  });

  it('copes with an event nobody registered for', async () => {
    const a = await make({ registered: 0, attended: 0 });
    const res = await as(t, org.organizer).get(`/api/events/${a.ev}/analytics`);
    expect(res.body.data.registrations).toEqual({ registered: 0, perDay: [] });
    expect(res.body.data.attendance.ratePercent).toBeNull();
  });
});
