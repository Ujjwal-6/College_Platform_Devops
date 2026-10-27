import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { registerNotificationHandlers } from '../src/modules/notifications/notify.js';
import { JobWorker } from '../src/platform/jobs/worker.js';
import {
  approveFully,
  as,
  bookingBody,
  buildOrg,
  buildTestApp,
  createApprovedEvent,
  createConfirmedBooking,
  createDraft,
  createHall,
  createResource,
  createTestDepartment,
  createTestUser,
  futureRange,
  istDate,
  loginAs,
  resetDb,
  type LoggedIn,
  type Org,
} from './helpers.js';

const t = buildTestApp();
let org: Org;
let hall: string;
let eventId: string;
beforeEach(async () => {
  await resetDb(t.ctx);
  t.mailer.sent.length = 0;
  org = await buildOrg(t);
  hall = await createHall(t, org.admin, {
    name: 'Main Hall',
    capacity: 200,
    facilities: ['projector', 'ac', 'stage'],
  });
  eventId = await createDraft(t, org.organizer); // expected attendance 120, 10:00-12:00 IST in 60 days
});
afterAll(() => t.close());

const book = (who: LoggedIn, overrides: Record<string, unknown> = {}, ev = eventId, h = hall) =>
  as(t, who).post('/api/bookings', bookingBody(ev, h, overrides));
const rows = async (sql: string, params: unknown[] = []) =>
  (await t.ctx.pool.query(sql, params)).rows;
const status = async (id: string) =>
  (
    await rows('SELECT status, approval_level, approval_round FROM hall_bookings WHERE id = $1', [
      id,
    ])
  )[0] as { status: string; approval_level: string | null; approval_round: number };
const idOf = (res: request.Response) => res.body.data.id as string;
const worker = () => {
  const w = new JobWorker({
    pool: t.ctx.pool,
    logger: t.ctx.logger,
    lockSeconds: 60,
    backoffBaseSeconds: 1,
    pollIntervalMs: 100,
    backoffSeconds: () => 0,
  });
  registerNotificationHandlers(w, t.mailer);
  return w;
};
const later = (days: number) => futureRange(days);

describe('requesting a booking', () => {
  it('creates a pending booking waiting for faculty approval, with history, audit and approver emails', async () => {
    const res = await book(org.organizer);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'pending',
      approvalLevel: 'faculty',
      approvalRound: 1,
      warnings: [],
      coversEvent: true,
      hall: { id: hall, name: 'Main Hall' },
      event: { id: eventId },
      requestedByName: expect.any(String),
      actions: { canEdit: true, canCancel: true, canApprove: false },
    });
    expect(await rows('SELECT action, to_status, level FROM booking_history')).toEqual([
      { action: 'request', to_status: 'pending', level: 'faculty' },
    ]);
    expect(
      await rows("SELECT target_id FROM audit_log WHERE action = 'booking.requested'"),
    ).toEqual([{ target_id: idOf(res) }]);
    await worker().drain();
    const cseFaculty = (
      await rows(
        "SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'faculty' AND u.department_id = $1",
        [org.cse],
      )
    )
      .map((r) => r.email)
      .sort();
    expect(t.mailer.sent.map((m) => m.to).sort()).toEqual(cseFaculty);
    expect(t.mailer.sent[0]!.subject).toContain('Main Hall');
  });

  it('can be requested while the event is still a draft, submitted, approved or published', async () => {
    const sub = await createDraft(t, org.organizer, { title: 'Submitted' });
    await as(t, org.organizer).post(`/api/events/${sub}/submit`);
    const approved = await createApprovedEvent(t, org);
    const published = await createApprovedEvent(t, org);
    await as(t, org.organizer).post(`/api/events/${published}/publish`);
    let day = 70;
    for (const ev of [eventId, sub, approved, published]) {
      expect(
        (await book(org.organizer, { ...later(day++), acknowledgeWarnings: true }, ev)).status,
      ).toBe(201);
    }
  });

  it('is limited to the event organizer and admins', async () => {
    expect((await book(org.admin)).status).toBe(201);
    await as(t, org.organizer).post(`/api/events/${eventId}/submit`);
    expect((await book(org.faculty, later(70))).status).toBe(403); // can see the submitted event but does not own it
    expect((await book(org.otherFaculty, later(71))).status).toBe(404);
    expect((await book(org.student, later(72))).status).toBe(404);
    expect((await book(org.otherOrganizer, later(73))).status).toBe(404);
    expect(
      (await request(t.app).post('/api/bookings').send(bookingBody(eventId, hall))).status,
    ).toBe(401);
  });

  it('refuses cancelled and closed events', async () => {
    const cancelled = await createDraft(t, org.organizer, { title: 'Cancelled one' });
    await as(t, org.organizer).post(`/api/events/${cancelled}/cancel`, { comment: 'No' });
    const res = await book(org.organizer, {}, cancelled);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_NOT_BOOKABLE');
    const closed = await createApprovedEvent(t, org);
    await as(t, org.organizer).post(`/api/events/${closed}/publish`);
    await t.ctx.pool.query(
      "UPDATE events SET status = 'closed', closed_at = now(), start_at = now() - interval '3 hours', end_at = now() - interval '1 hour', registration_deadline = NULL WHERE id = $1",
      [closed],
    );
    expect((await book(org.organizer, later(80), closed)).body.error.code).toBe(
      'EVENT_NOT_BOOKABLE',
    );
  });

  it('must be done before the event starts', async () => {
    const id = await createApprovedEvent(t, org);
    await t.ctx.pool.query(
      "UPDATE events SET start_at = now() - interval '1 hour', end_at = now() + interval '1 hour' WHERE id = $1",
      [id],
    );
    const res = await book(org.organizer, later(90), id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BOOKING_WINDOW_CLOSED');
  });

  it.each([
    [
      'end before start',
      () => {
        const r = futureRange();
        return { startAt: r.endAt, endAt: r.startAt };
      },
    ],
    [
      'start in the past',
      () => ({ startAt: '2020-01-01T10:00:00+05:30', endAt: '2020-01-01T12:00:00+05:30' }),
    ],
    ['date without UTC offset', () => ({ startAt: '2031-01-01T10:00:00' })],
    ['unknown field', () => ({ status: 'confirmed' })],
    [
      'facility list too long',
      () => ({ requiredFacilities: Array.from({ length: 31 }, (_, i) => `f${i}`) }),
    ],
    ['notes too long', () => ({ notes: 'x'.repeat(1001) })],
    ['warnings flag as text', () => ({ acknowledgeWarnings: 'yes' })],
  ])('rejects %s with 400', async (_name, make) => {
    const res = await book(org.organizer, make());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await rows('SELECT 1 FROM hall_bookings')).toHaveLength(0);
  });

  it('rejects a missing hall (400) and an inactive hall (409)', async () => {
    expect(
      (await book(org.organizer, {}, eventId, '00000000-0000-4000-8000-000000000000')).status,
    ).toBe(400);
    await as(t, org.admin).patch(`/api/halls/${hall}`, { isActive: false });
    const res = await book(org.organizer);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HALL_INACTIVE');
  });

  it('refuses when no one could approve (a department without faculty)', async () => {
    const lonely = await createTestDepartment(t.ctx, 'Lonely');
    const owner = await loginAs(
      t,
      await createTestUser(t.ctx, { roles: ['organizer'], departmentId: lonely }),
    );
    const ev = await createDraft(t, owner);
    const res = await book(owner, {}, ev);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_APPROVER_AVAILABLE');
    expect(await rows('SELECT 1 FROM hall_bookings')).toHaveLength(0);
  });

  it('returns the existing booking for an identical repeated request', async () => {
    const first = await book(org.organizer);
    const again = await book(org.organizer);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(idOf(again)).toBe(idOf(first));
    expect(await rows('SELECT 1 FROM hall_bookings')).toHaveLength(1);
    expect(await rows("SELECT 1 FROM audit_log WHERE action = 'booking.requested'")).toHaveLength(
      1,
    );
  });
});

describe('no double booking', () => {
  it('rejects an overlapping request with 409 and says who holds the hall', async () => {
    const other = await createDraft(t, org.admin, { title: 'Admin event', departmentId: org.cse });
    await book(org.organizer);
    const res = await book(
      org.admin,
      {
        startAt: futureRange().startAt.replace('T04:30', 'T05:30'),
        endAt: futureRange(60, 3).endAt,
      },
      other,
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HALL_UNAVAILABLE');
    expect(res.body.error.details.conflicts[0]).toMatchObject({
      status: 'pending',
      eventTitle: 'Annual Tech Symposium',
    });
  });

  it('allows back-to-back bookings (one ends exactly when the next begins)', async () => {
    const second = await createDraft(t, org.organizer, { title: 'Second event' });
    const a = futureRange(60, 2);
    const b = {
      startAt: a.endAt,
      endAt: new Date(new Date(a.endAt).getTime() + 2 * 3_600_000).toISOString(),
    };
    expect((await book(org.organizer, a)).status).toBe(201);
    expect((await book(org.organizer, { ...b, acknowledgeWarnings: true }, second)).status).toBe(
      201,
    );
  });

  it('allows the same time in a different hall', async () => {
    const other = await createHall(t, org.admin, { name: 'Seminar Room' });
    const second = await createDraft(t, org.organizer, { title: 'Second event' });
    expect((await book(org.organizer)).status).toBe(201);
    expect((await book(org.organizer, {}, second, other)).status).toBe(201);
  });

  it('frees the slot when a booking is rejected or cancelled', async () => {
    const second = await createDraft(t, org.organizer, { title: 'Second event' });
    const first = idOf(await book(org.organizer));
    expect((await book(org.organizer, {}, second)).status).toBe(409);
    await as(t, org.faculty).post(`/api/bookings/${first}/reject`, {
      level: 'faculty',
      comment: 'Hall needed elsewhere',
    });
    const retry = await book(org.organizer, {}, second);
    expect(retry.status).toBe(201);
    await as(t, org.organizer).post(`/api/bookings/${idOf(retry)}/cancel`, {});
    expect((await book(org.organizer, {}, eventId)).status).toBe(201);
  });

  it('shows another organizer\'s draft event as "Reserved" (title hidden) in conflicts', async () => {
    const mine = await createDraft(t, org.otherOrganizer, { title: 'Secret draft' });
    expect((await book(org.otherOrganizer, {}, mine)).status).toBe(201);
    const res = await book(org.organizer);
    expect(res.status).toBe(409);
    expect(res.body.error.details.conflicts[0].eventTitle).toBeNull();
  });
});

describe('warnings the organizer can acknowledge', () => {
  it('warns about capacity but lets the organizer proceed', async () => {
    const small = await createHall(t, org.admin, { name: 'Small Room', capacity: 50 });
    const first = await book(org.organizer, {}, eventId, small);
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('WARNINGS_NEED_ACKNOWLEDGEMENT');
    expect(first.body.error.details.warnings).toMatchObject([
      { code: 'CAPACITY', details: { capacity: 50, expectedAttendance: 120 } },
    ]);
    expect(await rows('SELECT 1 FROM hall_bookings')).toHaveLength(0);

    const accepted = await book(org.organizer, { acknowledgeWarnings: true }, eventId, small);
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.warnings).toMatchObject([{ code: 'CAPACITY' }]);
    expect(
      (await as(t, org.faculty).get(`/api/bookings/${idOf(accepted)}`)).body.data.warnings,
    ).toHaveLength(1); // approvers see them
  });

  it('warns about facilities the hall does not list', async () => {
    const res = await book(org.organizer, {
      requiredFacilities: ['Projector', 'recording studio', 'live stream'],
    });
    expect(res.body.error.code).toBe('WARNINGS_NEED_ACKNOWLEDGEMENT');
    expect(res.body.error.details.warnings).toMatchObject([
      { code: 'FACILITIES', details: { missing: ['recording studio', 'live stream'] } },
    ]);
    expect((await book(org.organizer, { requiredFacilities: ['projector', 'stage'] })).status).toBe(
      201,
    ); // listed, so no warning
  });

  it('only suggests when the calendar has an exam period or notice: it never blocks', async () => {
    const day = istDate(futureRange().startAt);
    await as(t, org.admin).post('/api/calendar/entries', {
      type: 'exam_period',
      title: 'End-semester exams',
      startDate: day,
      endDate: day,
    });
    await as(t, org.admin).post('/api/calendar/entries', {
      type: 'major_fest',
      title: 'Annual Fest',
      startDate: day,
      endDate: day,
    });
    const first = await book(org.organizer);
    expect(first.status).toBe(409);
    expect(
      first.body.error.details.warnings
        .filter((w: { code: string }) => w.code === 'CALENDAR')
        .map((w: { details: { title: string } }) => w.details.title)
        .sort(),
    ).toEqual(['Annual Fest', 'End-semester exams']);
    const accepted = await book(org.organizer, { acknowledgeWarnings: true });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.warnings).toHaveLength(2);
  });

  it('warns when the booking does not cover the whole event', async () => {
    const r = futureRange(60, 1); // event is 2 hours, booking 1 hour
    const res = await book(org.organizer, r);
    expect(res.body.error.details.warnings).toMatchObject([{ code: 'EVENT_TIME' }]);
    const ok = await book(org.organizer, { ...r, acknowledgeWarnings: true });
    expect(ok.body.data.coversEvent).toBe(false);
  });

  it('reports every warning at once and records them on the booking', async () => {
    const small = await createHall(t, org.admin, { name: 'Tiny', capacity: 10 });
    const res = await book(
      org.organizer,
      { requiredFacilities: ['stage'], ...futureRange(60, 1) },
      eventId,
      small,
    );
    expect(res.body.error.details.warnings.map((w: { code: string }) => w.code).sort()).toEqual([
      'CAPACITY',
      'EVENT_TIME',
      'FACILITIES',
    ]);
  });

  it('an acknowledged booking still cannot overlap an existing one', async () => {
    const small = await createHall(t, org.admin, { name: 'Small Room', capacity: 50 });
    const second = await createDraft(t, org.organizer, { title: 'Second event' });
    await book(org.organizer, { acknowledgeWarnings: true }, eventId, small);
    expect(
      (await book(org.organizer, { acknowledgeWarnings: true }, second, small)).body.error.code,
    ).toBe('HALL_UNAVAILABLE');
  });
});

describe('who can see a booking', () => {
  it("shows it to the organizer, admins and the department's faculty and HOD only", async () => {
    const id = idOf(await book(org.organizer));
    for (const who of [org.organizer, org.admin, org.faculty, org.hod])
      expect((await as(t, who).get(`/api/bookings/${id}`)).status).toBe(200);
    for (const who of [org.student, org.otherFaculty, org.otherHod, org.otherOrganizer])
      expect((await as(t, who).get(`/api/bookings/${id}`)).status).toBe(404);
  });

  it('lists bookings by scope', async () => {
    const id = idOf(await book(org.organizer));
    const ids = async (who: LoggedIn, q: string) =>
      (await as(t, who).get(`/api/bookings?${q}`)).body.data.map((b: { id: string }) => b.id);
    expect(await ids(org.organizer, 'scope=mine')).toEqual([id]);
    expect(await ids(org.student, 'scope=mine')).toEqual([]);
    expect(await ids(org.faculty, 'scope=department')).toEqual([id]);
    expect(await ids(org.otherFaculty, 'scope=department')).toEqual([]);
    expect(await ids(org.admin, 'scope=department')).toEqual([id]);
    expect((await as(t, org.student).get('/api/bookings?scope=department')).status).toBe(403);
    expect(await ids(org.organizer, `scope=event&eventId=${eventId}`)).toEqual([id]);
    expect(await ids(org.student, `scope=event&eventId=${eventId}`)).toEqual([]);
    expect((await as(t, org.organizer).get('/api/bookings?scope=event')).status).toBe(400);
    expect((await as(t, org.organizer).get('/api/bookings?scope=nope')).status).toBe(400);
    expect((await as(t, org.organizer).get('/api/bookings?limit=1000')).status).toBe(400);
  });

  it('puts each booking in the right approval queue', async () => {
    const id = idOf(await book(org.organizer));
    const queue = async (who: LoggedIn) =>
      (await as(t, who).get('/api/bookings?scope=approvals')).body.data.map(
        (b: { id: string }) => b.id,
      );
    expect(await queue(org.faculty)).toEqual([id]);
    expect(await queue(org.otherFaculty)).toEqual([]);
    expect(await queue(org.hod)).toEqual([]);
    expect(await queue(org.admin)).toEqual([]);
    expect((await as(t, org.student).get('/api/bookings?scope=approvals')).status).toBe(403);
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    expect(await queue(org.faculty)).toEqual([]);
    expect(await queue(org.hod)).toEqual([id]);
    expect(await queue(org.admin)).toEqual([id]); // any admin may give the second approval
    expect(await queue(org.otherHod)).toEqual([]);
  });
});

describe('approval: faculty first, then HOD or admin', () => {
  it('confirms after the faculty step and then the HOD', async () => {
    const id = idOf(await book(org.organizer));
    const f = await as(t, org.faculty).post(`/api/bookings/${id}/approve`, {
      level: 'faculty',
      comment: 'Fine by me',
    });
    expect(f.body.data).toMatchObject({ status: 'pending', approvalLevel: 'hod_admin' });
    const h = await as(t, org.hod).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' });
    expect(h.body.data).toMatchObject({ status: 'confirmed', approvalLevel: null });
    expect(
      h.body.data.approvals.map((a: { level: string; approverName: string }) => a.level),
    ).toEqual(['faculty', 'hod_admin']);
    expect(h.body.data.history.map((x: { action: string }) => x.action)).toEqual([
      'request',
      'approve',
      'approve',
    ]);
    const audit = await rows(
      "SELECT metadata FROM audit_log WHERE action = 'booking.approval_granted' ORDER BY id",
    );
    expect(audit.map((a) => a.metadata.final === true)).toEqual([false, true]);
  });

  it('accepts an admin instead of the HOD for the second step', async () => {
    const id = idOf(await book(org.organizer));
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    expect(
      (await as(t, org.admin).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' })).body.data
        .status,
    ).toBe('confirmed');
  });

  it('does not let a second approver decide a step that is already done', async () => {
    const id = idOf(await book(org.organizer));
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    await as(t, org.hod).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' });
    const again = await as(t, org.admin).post(`/api/bookings/${id}/approve`, {
      level: 'hod_admin',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
    expect(await rows('SELECT 1 FROM booking_approvals')).toHaveLength(2);
  });

  it('enforces order and role', async () => {
    const id = idOf(await book(org.organizer));
    expect(
      (await as(t, org.hod).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' })).status,
    ).toBe(409); // stale: not their step yet
    expect(
      (await as(t, org.admin).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' })).status,
    ).toBe(409);
    expect(
      (await as(t, org.hod).post(`/api/bookings/${id}/approve`, { level: 'faculty' })).status,
    ).toBe(403); // wrong role for the faculty step
    expect(
      (await as(t, org.admin).post(`/api/bookings/${id}/approve`, { level: 'faculty' })).status,
    ).toBe(403);
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    expect(
      (await as(t, org.faculty2).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' }))
        .status,
    ).toBe(403);
    expect(
      (await as(t, org.faculty2).post(`/api/bookings/${id}/approve`, { level: 'faculty' })).status,
    ).toBe(409); // already past that step
    expect(await rows('SELECT 1 FROM booking_approvals')).toHaveLength(1);
  });

  it('keeps other departments and outsiders out', async () => {
    const id = idOf(await book(org.organizer));
    for (const who of [org.otherFaculty, org.otherHod, org.student, org.otherOrganizer]) {
      expect(
        (await as(t, who).post(`/api/bookings/${id}/approve`, { level: 'faculty' })).status,
      ).toBe(404);
    }
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    expect(
      (await as(t, org.otherHod).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' }))
        .status,
    ).toBe(404);
  });

  it('never lets the requester or event organizer approve', async () => {
    const ev = await createDraft(t, org.faculty, { title: 'Faculty event' }); // faculty owns the event
    const id = idOf(await book(org.faculty, {}, ev));
    const self = await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
    expect((await as(t, org.faculty).get('/api/bookings?scope=approvals')).body.data).toEqual([]);
    expect(
      (await as(t, org.faculty2).post(`/api/bookings/${id}/approve`, { level: 'faculty' })).status,
    ).toBe(200);

    const adminEv = await createDraft(t, org.admin, {
      title: 'Admin event',
      departmentId: org.cse,
    });
    const other = await createHall(t, org.admin, { name: 'Other hall' });
    const adminBooking = idOf(await book(org.admin, {}, adminEv, other));
    await as(t, org.faculty).post(`/api/bookings/${adminBooking}/approve`, { level: 'faculty' });
    expect(
      (await as(t, org.admin).post(`/api/bookings/${adminBooking}/approve`, { level: 'hod_admin' }))
        .body.error.code,
    ).toBe('SELF_APPROVAL');
    expect(
      (await as(t, org.hod).post(`/api/bookings/${adminBooking}/approve`, { level: 'hod_admin' }))
        .body.data.status,
    ).toBe('confirmed');
  });

  it('stops one person from deciding both steps of the same request', async () => {
    const dual = await loginAs(
      t,
      await createTestUser(t.ctx, { roles: ['faculty', 'hod'], departmentId: org.cse }),
    );
    const id = idOf(await book(org.organizer));
    expect(
      (await as(t, dual).post(`/api/bookings/${id}/approve`, { level: 'faculty' })).status,
    ).toBe(200);
    const second = await as(t, dual).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_DECIDED');
    await expect(
      t.ctx.pool.query(
        "INSERT INTO booking_approvals (booking_id, round, level, decision, approver_id) VALUES ($1, 1, 'hod_admin', 'approved', $2)",
        [id, dual.user.id],
      ),
    ).rejects.toThrow(/booking_approvals_person_once/);
  });

  it('rejection needs a comment, ends the request, tells the organizer and frees the hall', async () => {
    const id = idOf(await book(org.organizer));
    expect(
      (await as(t, org.faculty).post(`/api/bookings/${id}/reject`, { level: 'faculty' })).status,
    ).toBe(400);
    expect(
      (
        await as(t, org.faculty).post(`/api/bookings/${id}/reject`, {
          level: 'faculty',
          comment: '  ',
        })
      ).status,
    ).toBe(400);
    const res = await as(t, org.faculty).post(`/api/bookings/${id}/reject`, {
      level: 'faculty',
      comment: 'The hall is reserved for exams',
    });
    expect(res.body.data).toMatchObject({
      status: 'rejected',
      approvalLevel: null,
      closingComment: 'The hall is reserved for exams',
    });
    await worker().drain();
    const mail = t.mailer.sent.find((m) => m.subject.startsWith('Hall booking rejected'));
    expect(mail?.to).toBe(org.organizer.user.email);
    expect(mail?.text).toContain('reserved for exams');
    expect(
      (await as(t, org.hod).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' })).status,
    ).toBe(409);
  });

  it('can be rejected at the second step too', async () => {
    const id = idOf(await book(org.organizer));
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    expect(
      (
        await as(t, org.admin).post(`/api/bookings/${id}/reject`, {
          level: 'hod_admin',
          comment: 'Too many bookings',
        })
      ).body.data.status,
    ).toBe('rejected');
    expect(await rows('SELECT decision FROM booking_approvals ORDER BY decided_at')).toEqual([
      { decision: 'approved' },
      { decision: 'rejected' },
    ]);
  });

  it('validates the request body', async () => {
    const id = idOf(await book(org.organizer));
    expect((await as(t, org.faculty).post(`/api/bookings/${id}/approve`, {})).status).toBe(400);
    expect(
      (await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'ceo' })).status,
    ).toBe(400);
    expect(
      (
        await as(t, org.faculty).post(`/api/bookings/${id}/approve`, {
          level: 'faculty',
          approver: 'me',
        })
      ).status,
    ).toBe(400);
    expect(
      (await as(t, org.faculty).post('/api/bookings/nope/approve', { level: 'faculty' })).status,
    ).toBe(400);
  });

  it('cannot be approved once the event has started', async () => {
    const id = idOf(await book(org.organizer));
    await t.ctx.pool.query(
      "UPDATE events SET start_at = now() - interval '1 hour', end_at = now() + interval '1 hour' WHERE id = $1",
      [eventId],
    );
    const res = await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BOOKING_WINDOW_CLOSED');
  });

  it('is independent of the event approval: neither confirms the other', async () => {
    const id = idOf(await book(org.organizer));
    await as(t, org.organizer).post(`/api/events/${eventId}/submit`);
    await approveFully(t, eventId, { faculty: org.faculty, hod: org.hod, admin: org.admin });
    expect((await status(id)).status).toBe('pending'); // event approved, booking still waits for its own approval
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    await as(t, org.hod).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' });
    expect((await as(t, org.organizer).get(`/api/events/${eventId}`)).body.data.status).toBe(
      'approved',
    ); // booking did not publish anything
  });
});

describe('changing and cancelling a booking', () => {
  it('lets the organizer fix notes without restarting approval', async () => {
    const id = idOf(await book(org.organizer));
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    const res = await as(t, org.organizer).patch(`/api/bookings/${id}`, {
      notes: 'Need two microphones',
    });
    expect(res.body.data).toMatchObject({
      notes: 'Need two microphones',
      approvalLevel: 'hod_admin',
      approvalRound: 1,
    });
  });

  it('sends a changed time or hall back to the first step with a new round', async () => {
    const other = await createHall(t, org.admin, { name: 'Seminar Room' });
    const id = idOf(await book(org.organizer));
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    await as(t, org.hod).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' });
    const moved = await as(t, org.organizer).patch(`/api/bookings/${id}`, { hallId: other });
    expect(moved.body.data).toMatchObject({
      status: 'pending',
      approvalLevel: 'faculty',
      approvalRound: 2,
    });
    expect(
      (await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' })).status,
    ).toBe(200); // same person may decide again in the new round
    expect(await rows('SELECT round FROM booking_approvals ORDER BY decided_at')).toEqual([
      { round: 1 },
      { round: 1 },
      { round: 2 },
    ]);
  });

  it('refuses a change that would overlap another booking and leaves the original untouched', async () => {
    const second = await createDraft(t, org.organizer, { title: 'Second event' });
    const first = idOf(await book(org.organizer));
    const r = futureRange(61);
    const mine = idOf(await book(org.organizer, { ...r, acknowledgeWarnings: true }, second));
    const res = await as(t, org.organizer).patch(`/api/bookings/${mine}`, {
      ...futureRange(),
      acknowledgeWarnings: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HALL_UNAVAILABLE');
    expect(
      (
        await rows('SELECT start_at FROM hall_bookings WHERE id = $1', [mine])
      )[0]!.start_at.toISOString(),
    ).toBe(r.startAt);
    expect(first).toBeDefined();
  });

  it('asks again when a change creates warnings, and allows adjusting to the same slot', async () => {
    const small = await createHall(t, org.admin, { name: 'Small Room', capacity: 50 });
    const id = idOf(await book(org.organizer));
    const res = await as(t, org.organizer).patch(`/api/bookings/${id}`, { hallId: small });
    expect(res.body.error.code).toBe('WARNINGS_NEED_ACKNOWLEDGEMENT');
    expect(
      (
        await as(t, org.organizer).patch(`/api/bookings/${id}`, {
          hallId: small,
          acknowledgeWarnings: true,
        })
      ).status,
    ).toBe(200);
  });

  it('allows only the organizer or an admin to change it, and not once closed, cancelled or started', async () => {
    const id = idOf(await book(org.organizer));
    await as(t, org.organizer).post(`/api/events/${eventId}/submit`);
    expect((await as(t, org.faculty).patch(`/api/bookings/${id}`, { notes: 'x' })).status).toBe(
      403,
    );
    expect((await as(t, org.student).patch(`/api/bookings/${id}`, { notes: 'x' })).status).toBe(
      404,
    );
    expect(
      (await as(t, org.admin).patch(`/api/bookings/${id}`, { notes: 'by admin' })).status,
    ).toBe(200);
    expect((await as(t, org.organizer).patch(`/api/bookings/${id}`, {})).status).toBe(400);
    expect(
      (await as(t, org.organizer).patch(`/api/bookings/${id}`, { status: 'confirmed' })).status,
    ).toBe(400);
    await t.ctx.pool.query(
      "UPDATE events SET status = 'draft', approval_level = NULL, start_at = now() - interval '1 hour', end_at = now() + interval '1 hour' WHERE id = $1",
      [eventId],
    );
    expect(
      (await as(t, org.organizer).patch(`/api/bookings/${id}`, { notes: 'late' })).body.error.code,
    ).toBe('BOOKING_WINDOW_CLOSED');
    await as(t, org.organizer).post(`/api/bookings/${id}/cancel`, {});
    expect(
      (await as(t, org.organizer).patch(`/api/bookings/${id}`, { notes: 'zombie' })).body.error
        .code,
    ).toBe('BOOKING_CLOSED');
  });

  it('cancels, frees the slot, and cannot be cancelled twice', async () => {
    const id = idOf(await book(org.organizer));
    const res = await as(t, org.organizer).post(`/api/bookings/${id}/cancel`, {
      comment: 'Plans changed',
    });
    expect(res.body.data).toMatchObject({ status: 'cancelled', closingComment: 'Plans changed' });
    expect(
      (await as(t, org.organizer).post(`/api/bookings/${id}/cancel`, {})).body.error.code,
    ).toBe('BOOKING_CLOSED');
    expect((await book(org.organizer)).status).toBe(201);
    expect(await rows("SELECT 1 FROM audit_log WHERE action = 'booking.cancelled'")).toHaveLength(
      1,
    );
  });

  it('needs a reason, and emails the organizer, when an admin cancels', async () => {
    const id = idOf(await book(org.organizer));
    expect((await as(t, org.admin).post(`/api/bookings/${id}/cancel`, {})).status).toBe(400);
    expect(
      (await as(t, org.faculty).post(`/api/bookings/${id}/cancel`, { comment: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await as(t, org.admin).post(`/api/bookings/${id}/cancel`, {
          comment: 'Hall is being repainted',
        })
      ).body.data.status,
    ).toBe('cancelled');
    await worker().drain();
    expect(t.mailer.sent.find((m) => m.subject.startsWith('Hall booking cancelled'))?.to).toBe(
      org.organizer.user.email,
    );
  });
});

describe('integration with the event lifecycle', () => {
  it('cancelling the event cancels its bookings and releases its resources in the same step', async () => {
    const ev = await createApprovedEvent(t, org);
    const mine = await createConfirmedBooking(t, org, ev, hall);
    const pending = idOf(
      await book(
        org.organizer,
        { ...later(65), acknowledgeWarnings: true },
        ev,
        await createHall(t, org.admin, { name: 'Second hall' }),
      ),
    );
    const rejected = idOf(
      await book(org.organizer, { ...later(66), acknowledgeWarnings: true }, ev),
    );
    await as(t, org.faculty).post(`/api/bookings/${rejected}/reject`, {
      level: 'faculty',
      comment: 'No',
    });
    const res = await createResource(t, org.admin, { quantity: 4 });
    await as(t, org.organizer).post('/api/resource-reservations', {
      eventId: ev,
      resourceId: res,
      quantity: 2,
    });
    const unrelated = idOf(
      await book(org.organizer, { ...later(75), acknowledgeWarnings: true }, eventId),
    );

    expect(
      (
        await as(t, org.organizer).post(`/api/events/${ev}/cancel`, {
          comment: 'Speaker unavailable',
        })
      ).status,
    ).toBe(200);
    expect((await status(mine)).status).toBe('cancelled');
    expect((await status(pending)).status).toBe('cancelled');
    expect((await status(rejected)).status).toBe('rejected'); // history is not rewritten
    expect((await status(unrelated)).status).toBe('pending'); // other events untouched
    expect(await rows('SELECT status, release_reason FROM resource_reservations')).toEqual([
      { status: 'released', release_reason: 'The event was cancelled' },
    ]);
    expect(
      (
        await rows(
          "SELECT comment FROM booking_history WHERE booking_id = $1 AND action = 'cancel'",
          [mine],
        )
      )[0]!.comment,
    ).toBe('The event was cancelled');
    // the slot of the cancelled event's confirmed booking is free for others again
    expect((await book(org.organizer, { acknowledgeWarnings: true }, eventId)).status).toBe(201);
  });

  it('frees the hall for others once the event is cancelled', async () => {
    const ev = await createApprovedEvent(t, org);
    await createConfirmedBooking(t, org, ev, hall);
    expect((await book(org.organizer)).status).toBe(409);
    await as(t, org.organizer).post(`/api/events/${ev}/cancel`, { comment: 'Cancelled' });
    expect((await book(org.organizer)).status).toBe(201);
  });

  it('keeps hall bookings, but releases resources, when an approved event is revised', async () => {
    const ev = await createApprovedEvent(t, org);
    const booking = await createConfirmedBooking(t, org, ev, hall);
    const res = await createResource(t, org.admin);
    await as(t, org.organizer).post('/api/resource-reservations', {
      eventId: ev,
      resourceId: res,
      quantity: 1,
    });
    expect((await as(t, org.organizer).post(`/api/events/${ev}/revise`)).body.data.status).toBe(
      'draft',
    );
    expect((await status(booking)).status).toBe('confirmed');
    expect((await rows('SELECT status FROM resource_reservations'))[0]).toEqual({
      status: 'released',
    });
    // after revising, the event no longer covers the same time: the booking says so
    await as(t, org.organizer).patch(`/api/events/${ev}`, futureRange(61));
    expect((await as(t, org.organizer).get(`/api/bookings/${booking}`)).body.data.coversEvent).toBe(
      false,
    );
  });

  it('keeps bookings when an event is unpublished, withdrawn or closed', async () => {
    const ev = await createApprovedEvent(t, org);
    const booking = await createConfirmedBooking(t, org, ev, hall);
    await as(t, org.organizer).post(`/api/events/${ev}/publish`);
    await as(t, org.organizer).post(`/api/events/${ev}/unpublish`);
    expect((await status(booking)).status).toBe('confirmed');
  });

  it('refreshes the department kept on bookings when the event changes department before submission', async () => {
    const ev = await createDraft(t, org.admin, { title: 'Admin event', departmentId: org.cse });
    const id = idOf(await book(org.admin, {}, ev));
    expect(
      (await rows('SELECT department_id FROM hall_bookings WHERE id = $1', [id]))[0]!.department_id,
    ).toBe(org.cse);
    await as(t, org.admin).patch(`/api/events/${ev}`, { departmentId: org.ece });
    await as(t, org.admin).post(`/api/events/${ev}/submit`);
    expect(
      (await rows('SELECT department_id FROM hall_bookings WHERE id = $1', [id]))[0]!.department_id,
    ).toBe(org.ece);
  });
});

describe('availability search', () => {
  it('shows each active hall with its status, conflicts, capacity and facility fit', async () => {
    const closed = await createHall(t, org.admin, { name: 'Closed Hall', isActive: false });
    const other = await createHall(t, org.admin, {
      name: 'Seminar Room',
      capacity: 30,
      facilities: ['projector'],
    });
    await book(org.organizer);
    const r = futureRange();
    const res = await as(t, org.student).get(
      `/api/bookings/availability?startAt=${encodeURIComponent(r.startAt)}&endAt=${encodeURIComponent(r.endAt)}&attendance=100&facilities=projector,stage`,
    );
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.data.map((x: { hall: { name: string } }) => [x.hall.name, x]),
    );
    expect(byName['Closed Hall']).toBeUndefined();
    expect(closed).toBeDefined();
    expect(byName['Main Hall']).toMatchObject({
      available: false,
      capacityOk: true,
      missingFacilities: [],
    });
    expect(byName['Main Hall'].conflicts[0]).toMatchObject({ status: 'pending' });
    expect(byName['Seminar Room']).toMatchObject({
      available: true,
      capacityOk: false,
      missingFacilities: ['stage'],
      conflicts: [],
    });
    expect(other).toBeDefined();
  });

  it("shows what is happening to everyone, but hides other people's draft event titles", async () => {
    const r = futureRange();
    const q = `startAt=${encodeURIComponent(r.startAt)}&endAt=${encodeURIComponent(r.endAt)}`;
    const ev = await createApprovedEvent(t, org, { title: 'Open Day' });
    await as(t, org.organizer).post(`/api/events/${ev}/publish`);
    await createConfirmedBooking(t, org, ev, hall);
    const seen = async (who: LoggedIn) =>
      (await as(t, who).get(`/api/bookings/availability?${q}`)).body.data[0].conflicts[0]
        .eventTitle;
    expect(await seen(org.student)).toBe('Open Day'); // published, so anyone may see it
    await as(t, org.organizer).post(`/api/events/${ev}/unpublish`);
    expect(await seen(org.student)).toBeNull(); // approved but not public: "Reserved"
    expect(await seen(org.faculty)).toBe('Open Day');
  });

  it('can list only free halls and validates the query', async () => {
    await createHall(t, org.admin, { name: 'Seminar Room' });
    await book(org.organizer);
    const r = futureRange();
    const q = `startAt=${encodeURIComponent(r.startAt)}&endAt=${encodeURIComponent(r.endAt)}`;
    const free = await as(t, org.organizer).get(
      `/api/bookings/availability?${q}&onlyAvailable=true`,
    );
    expect(free.body.data.map((x: { hall: { name: string } }) => x.hall.name)).toEqual([
      'Seminar Room',
    ]);
    expect(
      (
        await as(t, org.organizer).get(
          `/api/bookings/availability?startAt=${encodeURIComponent(r.endAt)}&endAt=${encodeURIComponent(r.startAt)}`,
        )
      ).status,
    ).toBe(400);
    expect((await as(t, org.organizer).get('/api/bookings/availability')).status).toBe(400);
    expect((await request(t.app).get(`/api/bookings/availability?${q}`)).status).toBe(401);
  });
});

describe('audit trail', () => {
  it('records each booking action exactly once', async () => {
    const id = idOf(await book(org.organizer));
    await as(t, org.organizer).patch(`/api/bookings/${id}`, { notes: 'Updated' });
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    await as(t, org.hod).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' });
    await as(t, org.organizer).post(`/api/bookings/${id}/cancel`, {});
    const counts = Object.fromEntries(
      (
        await rows(
          "SELECT action, count(*)::int AS n FROM audit_log WHERE action LIKE 'booking.%' GROUP BY action",
        )
      ).map((r) => [r.action, r.n]),
    );
    expect(counts).toEqual({
      'booking.requested': 1,
      'booking.updated': 1,
      'booking.approval_granted': 2,
      'booking.cancelled': 1,
    });
  });
});
