import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  as,
  bookingBody,
  buildOrg,
  buildTestApp,
  createDraft,
  createHall,
  futureRange,
  resetDb,
  type Org,
} from './helpers.js';

// These tests run real simultaneous HTTP requests against the real PostgreSQL test database.
// They are the proof that the hall-booking guarantee holds under concurrency.
// Many simultaneous requests with real password hashing: about 7 s here, several times slower on a shared CI runner.
// A timed-out test leaves requests running into the next test's reset, so the limit must not be tight.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
const t = buildTestApp();
let org: Org;
let hall: string;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
  hall = await createHall(t, org.admin, { name: 'Main Hall', capacity: 500, facilities: [] });
});
afterAll(() => t.close());

const rows = async (sql: string, params: unknown[] = []) =>
  (await t.ctx.pool.query(sql, params)).rows;
const drafts = async (n: number) => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++)
    ids.push(await createDraft(t, org.organizer, { title: `Concurrent event ${i}` }));
  return ids;
};
const hours = (day: number, fromHour: number, toHour: number) => {
  const r = futureRange(day);
  const base = new Date(r.startAt).getTime() - 10 * 3_600_000; // midnight IST of that day
  return {
    startAt: new Date(base + fromHour * 3_600_000).toISOString(),
    endAt: new Date(base + toHour * 3_600_000).toISOString(),
  };
};
const request = (ev: string, slot: { startAt: string; endAt: string }) =>
  as(t, org.organizer).post(
    '/api/bookings',
    bookingBody(ev, hall, { ...slot, acknowledgeWarnings: true }),
  );

/** Number of pairs of active bookings of one hall that overlap in time. Must always be zero. */
const overlappingPairs = async () =>
  (
    await rows(
      `SELECT count(*)::int AS n FROM hall_bookings a JOIN hall_bookings b
         ON a.id < b.id AND a.hall_id = b.hall_id
        AND tstzrange(a.start_at, a.end_at, '[)') && tstzrange(b.start_at, b.end_at, '[)')
      WHERE a.status IN ('pending', 'confirmed') AND b.status IN ('pending', 'confirmed')`,
    )
  )[0].n as number;

describe('simultaneous booking requests for one hall and slot', () => {
  it('lets exactly one of 20 simultaneous requests succeed, repeated over several rounds', async () => {
    const events = await drafts(20);
    for (let round = 0; round < 5; round++) {
      const slot = hours(100 + round, 10, 12);
      const results = await Promise.all(events.map((ev) => request(ev, slot)));
      const created = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status === 409);
      expect(created, `round ${round}`).toHaveLength(1);
      expect(refused, `round ${round}`).toHaveLength(19);
      expect(new Set(refused.map((r) => r.body.error.code))).toEqual(new Set(['HALL_UNAVAILABLE']));
      const stored = await rows(
        "SELECT id FROM hall_bookings WHERE tstzrange(start_at, end_at, '[)') && tstzrange($1, $2, '[)') AND status IN ('pending', 'confirmed')",
        [slot.startAt, slot.endAt],
      );
      expect(stored).toEqual([{ id: created[0]!.body.data.id }]);
    }
    expect(await overlappingPairs()).toBe(0);
  });

  it('with partly overlapping windows never leaves two overlapping bookings', async () => {
    const events = await drafts(6);
    for (let round = 0; round < 8; round++) {
      const windows = [
        hours(110 + round, 10, 12),
        hours(110 + round, 11, 13),
        hours(110 + round, 12, 14),
      ];
      const results = await Promise.all(events.map((ev, i) => request(ev, windows[i % 3]!)));
      const winners = results.filter((r) => r.status === 201).length;
      expect(winners, `round ${round}`).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(await overlappingPairs(), `round ${round}`).toBe(0);
    }
  });

  it('accepts simultaneous back-to-back requests (adjacent slots do not conflict)', async () => {
    const events = await drafts(4);
    const slots = [hours(120, 9, 10), hours(120, 10, 11), hours(120, 11, 12), hours(120, 12, 13)];
    const results = await Promise.all(events.map((ev, i) => request(ev, slots[i]!)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
  });

  it('treats a retry that overlaps its own first attempt as the same booking', async () => {
    const [ev] = await drafts(1);
    const slot = hours(130, 10, 12);
    const results = await Promise.all(Array.from({ length: 10 }, () => request(ev!, slot)));
    expect(results.map((r) => r.status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(await rows('SELECT 1 FROM hall_bookings')).toHaveLength(1);
    expect(await rows("SELECT 1 FROM audit_log WHERE action = 'booking.requested'")).toHaveLength(
      1,
    );
  });

  it('serialises a new request racing with a change of an existing booking into the same slot', async () => {
    const [a, b] = await drafts(2);
    const mine = (await request(a!, hours(140, 8, 9))).body.data.id as string;
    const target = hours(140, 10, 12);
    const [created, moved] = await Promise.all([
      request(b!, target),
      as(t, org.organizer).patch(`/api/bookings/${mine}`, { ...target, acknowledgeWarnings: true }),
    ]);
    expect(created.status === 201 || moved.status === 200).toBe(true);
    expect(created.status === 201 && moved.status === 200).toBe(false); // never both
    expect(await overlappingPairs()).toBe(0);
  });
});

describe('simultaneous approvals', () => {
  async function pendingBooking() {
    const [ev] = await drafts(1);
    return (await request(ev!, hours(150, 10, 12))).body.data.id as string;
  }

  it('records one decision when two faculty approve the same step together', async () => {
    for (let i = 0; i < 4; i++) {
      await resetBookings();
      const id = await pendingBooking();
      const results = await Promise.all([
        as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' }),
        as(t, org.faculty2).post(`/api/bookings/${id}/approve`, { level: 'faculty' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        await rows('SELECT 1 FROM booking_approvals WHERE booking_id = $1', [id]),
      ).toHaveLength(1);
    }
  });

  it('confirms once when the HOD and an admin give the final approval together', async () => {
    const id = await pendingBooking();
    await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
    const results = await Promise.all([
      as(t, org.hod).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' }),
      as(t, org.admin).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' }),
      as(t, org.hod2).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await rows('SELECT 1 FROM booking_approvals WHERE booking_id = $1', [id])).toHaveLength(
      2,
    );
    expect((await rows('SELECT status FROM hall_bookings WHERE id = $1', [id]))[0]).toEqual({
      status: 'confirmed',
    });
  });

  it('keeps a decision and a cancellation consistent when they race', async () => {
    for (let i = 0; i < 4; i++) {
      await resetBookings();
      const id = await pendingBooking();
      const [approve, cancel] = await Promise.all([
        as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' }),
        as(t, org.organizer).post(`/api/bookings/${id}/cancel`, {}),
      ]);
      const final = (await rows('SELECT status FROM hall_bookings WHERE id = $1', [id]))[0]
        .status as string;
      expect(cancel.status === 200 || cancel.status === 409).toBe(true);
      if (cancel.status === 200) expect(final).toBe('cancelled');
      else expect(final).not.toBe('cancelled');
      if (final === 'cancelled') expect([200, 409]).toContain(approve.status);
    }
  });

  async function resetBookings() {
    await t.ctx.pool.query('TRUNCATE booking_history, booking_approvals, hall_bookings CASCADE');
  }
});

describe('the database enforces the rule by itself', () => {
  const insert = (hallId: string, ev: string, start: string, end: string, status = 'pending') =>
    t.ctx.pool.query(
      `INSERT INTO hall_bookings (event_id, hall_id, requested_by, event_organizer_id, department_id, start_at, end_at, status, approval_level)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, CASE WHEN $7 = 'pending' THEN 'faculty' END)`,
      [ev, hallId, org.organizer.user.id, org.cse, start, end, status],
    );

  it('rejects an overlapping row even when the service is bypassed, with SQLSTATE 23P01', async () => {
    const [ev] = await drafts(1);
    const s = hours(160, 10, 12);
    await insert(hall, ev!, s.startAt, s.endAt);
    const err = await insert(hall, ev!, hours(160, 11, 13).startAt, hours(160, 11, 13).endAt).catch(
      (e) => e,
    );
    expect(err.code).toBe('23P01');
    expect(err.constraint).toBe('hall_bookings_no_overlap');
  });

  it('accepts adjacent ranges, other halls, and overlaps with rejected or cancelled rows', async () => {
    const [ev] = await drafts(1);
    const other = await createHall(t, org.admin, { name: 'Second Hall' });
    await insert(hall, ev!, hours(161, 10, 12).startAt, hours(161, 10, 12).endAt, 'confirmed');
    await insert(hall, ev!, hours(161, 12, 14).startAt, hours(161, 12, 14).endAt); // starts exactly when the other ends
    await insert(hall, ev!, hours(161, 8, 10).startAt, hours(161, 8, 10).endAt); // ends exactly when it starts
    await insert(other, ev!, hours(161, 10, 12).startAt, hours(161, 10, 12).endAt); // different hall
    await insert(hall, ev!, hours(161, 10, 12).startAt, hours(161, 10, 12).endAt, 'rejected');
    await insert(hall, ev!, hours(161, 10, 12).startAt, hours(161, 10, 12).endAt, 'cancelled');
    expect(await rows('SELECT 1 FROM hall_bookings')).toHaveLength(6);
  });

  it('also guards updates: a cancelled booking cannot be revived into a taken slot, and a row cannot be moved into one', async () => {
    const [ev] = await drafts(1);
    const s = hours(162, 10, 12);
    await insert(hall, ev!, s.startAt, s.endAt);
    await insert(hall, ev!, s.startAt, s.endAt, 'cancelled');
    await expect(
      t.ctx.pool.query(
        "UPDATE hall_bookings SET status = 'pending', approval_level = 'faculty' WHERE status = 'cancelled'",
      ),
    ).rejects.toMatchObject({ code: '23P01' });
    await insert(hall, ev!, hours(162, 14, 16).startAt, hours(162, 14, 16).endAt);
    await expect(
      t.ctx.pool.query('UPDATE hall_bookings SET start_at = $1, end_at = $2 WHERE start_at = $3', [
        hours(162, 11, 13).startAt,
        hours(162, 11, 13).endAt,
        hours(162, 14, 16).startAt,
      ]),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('refuses invalid rows: end before start, bad status, status and approval step out of line', async () => {
    const [ev] = await drafts(1);
    const s = hours(163, 10, 12);
    await expect(insert(hall, ev!, s.endAt, s.startAt)).rejects.toThrow(/time_order/);
    await expect(insert(hall, ev!, s.startAt, s.endAt, 'approved')).rejects.toThrow(/status_check/);
    await expect(
      t.ctx.pool.query(
        `INSERT INTO hall_bookings (event_id, hall_id, requested_by, event_organizer_id, department_id, start_at, end_at, status)
         VALUES ($1, $2, $3, $3, $4, $5, $6, 'pending')`,
        [ev, hall, org.organizer.user.id, org.cse, s.startAt, s.endAt],
      ),
    ).rejects.toThrow(/level_matches_status/);
  });
});
