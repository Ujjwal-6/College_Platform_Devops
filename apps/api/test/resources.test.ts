import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  as,
  buildOrg,
  buildTestApp,
  createApprovedEvent,
  createDraft,
  createResource,
  futureRange,
  resetDb,
  type LoggedIn,
  type Org,
} from './helpers.js';

const t = buildTestApp();
let org: Org;
let eventId: string; // an approved event: 10:00-12:00 IST, 60 days ahead
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
  eventId = await createApprovedEvent(t, org);
});
afterAll(() => t.close());

const rows = async (sql: string, params: unknown[] = []) =>
  (await t.ctx.pool.query(sql, params)).rows;
const reserve = (
  who: LoggedIn,
  resourceId: string,
  quantity: number,
  extra: Record<string, unknown> = {},
  ev = eventId,
) => as(t, who).post('/api/resource-reservations', { eventId: ev, resourceId, quantity, ...extra });
/** A window on the event's day, given as hours from midnight IST. */
const day = (fromHour: number, toHour: number, daysAhead = 60) => {
  const base = new Date(futureRange(daysAhead).startAt).getTime() - 10 * 3_600_000;
  return {
    startAt: new Date(base + fromHour * 3_600_000).toISOString(),
    endAt: new Date(base + toHour * 3_600_000).toISOString(),
  };
};
const unitsInUse = async (resourceId: string) =>
  (
    await rows(
      `SELECT COALESCE(MAX(used), 0)::int AS peak FROM (
         SELECT (SELECT COALESCE(SUM(b.quantity), 0) FROM resource_reservations b
                  WHERE b.resource_id = a.resource_id AND b.status = 'confirmed' AND b.start_at <= a.start_at AND b.end_at > a.start_at) AS used
           FROM resource_reservations a WHERE a.resource_id = $1 AND a.status = 'confirmed') u`,
      [resourceId],
    )
  )[0].peak as number;

describe('resource catalogue', () => {
  it('lets admins create and change resources and audits it', async () => {
    const res = await as(t, org.admin).post('/api/resources', {
      name: 'Projector',
      category: 'av',
      quantity: 8,
      description: 'HD',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Projector', quantity: 8, status: 'available' });
    const patched = await as(t, org.admin).patch(`/api/resources/${res.body.data.id}`, {
      quantity: 10,
      status: 'maintenance',
    });
    expect(patched.body.data).toMatchObject({ quantity: 10, status: 'maintenance' });
    const audit = await rows(
      "SELECT action FROM audit_log WHERE action LIKE 'resource.%' ORDER BY id",
    );
    expect(audit.map((a) => a.action)).toEqual(['resource.created', 'resource.updated']);
  });

  it('allows only admins to change the catalogue and everyone to read it', async () => {
    const id = await createResource(t, org.admin, { name: 'Chairs', quantity: 300 });
    for (const who of [org.student, org.organizer, org.faculty, org.hod]) {
      expect(
        (await as(t, who).post('/api/resources', { name: 'Nope', category: 'x1', quantity: 1 }))
          .status,
      ).toBe(403);
      expect((await as(t, who).patch(`/api/resources/${id}`, { quantity: 1 })).status).toBe(403);
    }
    expect((await as(t, org.student).get('/api/resources')).body.data).toHaveLength(1);
    expect((await request(t.app).get('/api/resources')).status).toBe(401);
  });

  it('hides retired resources from non-admins', async () => {
    await createResource(t, org.admin, { name: 'Old OHP', status: 'retired' });
    expect((await as(t, org.student).get('/api/resources')).body.data).toEqual([]);
    expect((await as(t, org.admin).get('/api/resources')).body.data).toHaveLength(1);
  });

  it('keeps names unique and validates input', async () => {
    await createResource(t, org.admin, { name: 'Microphone' });
    expect(
      (
        await as(t, org.admin).post('/api/resources', {
          name: 'MICROPHONE',
          category: 'av',
          quantity: 1,
        })
      ).body.error.code,
    ).toBe('RESOURCE_NAME_TAKEN');
    for (const bad of [
      { quantity: 0 },
      { quantity: -1 },
      { quantity: 1.5 },
      { name: 'x' },
      { status: 'lost' },
      { colour: 'red' },
    ]) {
      expect(
        (
          await as(t, org.admin).post('/api/resources', {
            name: 'Cable',
            category: 'av',
            quantity: 3,
            ...bad,
          })
        ).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    expect(
      (
        await as(t, org.admin).patch('/api/resources/00000000-0000-4000-8000-000000000000', {
          quantity: 2,
        })
      ).status,
    ).toBe(404);
  });
});

describe('reserving a resource', () => {
  it("reserves for an approved event, defaulting to the event's time", async () => {
    const id = await createResource(t, org.admin, { quantity: 5 });
    const res = await reserve(org.organizer, id, 3, { notes: 'Stage left' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      quantity: 3,
      status: 'confirmed',
      startAt: futureRange().startAt,
      endAt: futureRange().endAt,
      notes: 'Stage left',
    });
    expect(
      await rows("SELECT target_id FROM audit_log WHERE action = 'resource.reserved'"),
    ).toEqual([{ target_id: res.body.data.id }]);
  });

  it('works for published events and refuses events that are not fully approved', async () => {
    const id = await createResource(t, org.admin);
    await as(t, org.organizer).post(`/api/events/${eventId}/publish`);
    expect((await reserve(org.organizer, id, 1)).status).toBe(201);
    const draft = await createDraft(t, org.organizer, { title: 'Draft event' });
    const pending = await createDraft(t, org.organizer, { title: 'Pending event' });
    await as(t, org.organizer).post(`/api/events/${pending}/submit`);
    for (const ev of [draft, pending]) {
      const res = await reserve(org.organizer, id, 1, {}, ev);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EVENT_NOT_APPROVED');
    }
    const cancelled = await createApprovedEvent(t, org, { title: 'Cancelled event' });
    await as(t, org.organizer).post(`/api/events/${cancelled}/cancel`, { comment: 'x' });
    expect((await reserve(org.organizer, id, 1, {}, cancelled)).body.error.code).toBe(
      'EVENT_NOT_APPROVED',
    );
  });

  it('must be done before the event starts', async () => {
    const id = await createResource(t, org.admin);
    await t.ctx.pool.query(
      "UPDATE events SET start_at = now() - interval '1 hour', end_at = now() + interval '1 hour' WHERE id = $1",
      [eventId],
    );
    expect((await reserve(org.organizer, id, 1)).body.error.code).toBe('BOOKING_WINDOW_CLOSED');
  });

  it('is limited to the event organizer and admins', async () => {
    const id = await createResource(t, org.admin);
    expect((await reserve(org.admin, id, 1)).status).toBe(201);
    expect(
      (
        await reserve(org.faculty, id, 1, {
          endAt: day(12, 13).endAt,
          startAt: day(12, 13).startAt,
        })
      ).status,
    ).toBe(403);
    expect((await reserve(org.hod, id, 1)).status).toBe(403);
    expect((await reserve(org.otherFaculty, id, 1)).status).toBe(404);
    const reservedAndPublic = await as(t, org.organizer).post(`/api/events/${eventId}/publish`);
    expect(reservedAndPublic.status).toBe(200);
    expect((await reserve(org.student, id, 1)).status).toBe(403);
    expect((await request(t.app).post('/api/resource-reservations').send({})).status).toBe(401);
  });

  it('refuses unavailable resources', async () => {
    const maintenance = await createResource(t, org.admin, { status: 'maintenance' });
    const retired = await createResource(t, org.admin, { status: 'retired' });
    for (const id of [maintenance, retired])
      expect((await reserve(org.organizer, id, 1)).body.error.code).toBe('RESOURCE_UNAVAILABLE');
    expect((await reserve(org.organizer, '00000000-0000-4000-8000-000000000000', 1)).status).toBe(
      400,
    );
  });

  it.each([
    ['zero quantity', { quantity: 0 }],
    ['fractional quantity', { quantity: 1.5 }],
    ['only one end of the window', { startAt: futureRange().startAt }],
    ['window without offset', { startAt: '2031-01-01T10:00:00', endAt: '2031-01-01T11:00:00' }],
    [
      'end before start',
      (() => {
        const w = day(12, 13);
        return { startAt: w.endAt, endAt: w.startAt };
      })(),
    ],
    [
      'window in the past',
      { startAt: '2020-01-01T10:00:00+05:30', endAt: '2020-01-01T11:00:00+05:30' },
    ],
    ['unknown field', { price: 5 }],
  ])('rejects %s with 400', async (_name, extra) => {
    const id = await createResource(t, org.admin);
    const res = await as(t, org.organizer).post('/api/resource-reservations', {
      eventId,
      resourceId: id,
      quantity: 1,
      ...extra,
    });
    expect(res.status).toBe(400);
  });

  it('returns the existing reservation for an identical repeated request', async () => {
    const id = await createResource(t, org.admin);
    const first = await reserve(org.organizer, id, 2);
    const again = await reserve(org.organizer, id, 2);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await rows('SELECT 1 FROM resource_reservations')).toHaveLength(1);
  });
});

describe('quantity-aware allocation', () => {
  it('never allocates more units than exist, and says how many are free', async () => {
    const id = await createResource(t, org.admin, { name: 'Projector', quantity: 5 });
    expect((await reserve(org.organizer, id, 3)).status).toBe(201);
    const second = await reserve(org.organizer, id, 3, {
      endAt: day(11, 13).endAt,
      startAt: day(11, 13).startAt,
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
      details: { total: 5, available: 2, requested: 3 },
    });
    expect(
      (
        await reserve(org.organizer, id, 2, {
          startAt: day(11, 13).startAt,
          endAt: day(11, 13).endAt,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await reserve(org.organizer, id, 6, {
          startAt: day(14, 15).startAt,
          endAt: day(14, 15).endAt,
        })
      ).body.error.details.available,
    ).toBe(5);
  });

  it('lets non-overlapping windows each use the full stock', async () => {
    const id = await createResource(t, org.admin, { quantity: 5 });
    expect((await reserve(org.organizer, id, 5, day(8, 10))).status).toBe(201);
    expect((await reserve(org.organizer, id, 5, day(10, 12))).status).toBe(201); // starts exactly when the other ends
    expect((await reserve(org.organizer, id, 5, day(12, 14))).status).toBe(201);
    expect((await reserve(org.organizer, id, 1, day(9, 11))).status).toBe(409);
  });

  it('counts the peak at any instant, not the sum of everything that overlaps the window', async () => {
    const id = await createResource(t, org.admin, { quantity: 5 });
    expect((await reserve(org.organizer, id, 3, day(10, 11))).status).toBe(201);
    expect((await reserve(org.organizer, id, 3, day(11, 12))).status).toBe(201);
    // 3 + 2 = 5 at 10:00-11:00 and 3 + 2 = 5 at 11:00-12:00: fits, although 3 + 3 + 2 = 8 overlaps the window
    expect((await reserve(org.organizer, id, 2, day(10, 12))).status).toBe(201);
    // one more unit anywhere in 10:00-12:00 would make 6
    expect((await reserve(org.organizer, id, 1, day(10, 12))).body.error.code).toBe(
      'RESOURCE_EXHAUSTED',
    );
    expect((await reserve(org.organizer, id, 1, day(10, 10.5))).body.error.code).toBe(
      'RESOURCE_EXHAUSTED',
    );
    expect((await reserve(org.organizer, id, 1, day(12, 13))).status).toBe(201);
    expect(await unitsInUse(id)).toBeLessThanOrEqual(5);
  });

  it('shares stock between different events', async () => {
    const id = await createResource(t, org.admin, { quantity: 4 });
    const other = await createApprovedEvent(t, org, { title: 'Second event' });
    expect((await reserve(org.organizer, id, 3)).status).toBe(201);
    expect((await reserve(org.organizer, id, 2, {}, other)).body.error.details.available).toBe(1);
  });

  it('shows availability for a window', async () => {
    const id = await createResource(t, org.admin, { name: 'Projector', quantity: 5 });
    await createResource(t, org.admin, {
      name: 'Broken mixer',
      quantity: 2,
      status: 'maintenance',
    });
    await reserve(org.organizer, id, 3);
    const w = futureRange();
    const res = await as(t, org.student).get(
      `/api/resources/availability?startAt=${encodeURIComponent(w.startAt)}&endAt=${encodeURIComponent(w.endAt)}`,
    );
    const byName = Object.fromEntries(
      res.body.data.map((x: { resource: { name: string } }) => [x.resource.name, x]),
    );
    expect(byName['Projector']).toMatchObject({ inUse: 3, available: 2 });
    expect(byName['Broken mixer']).toMatchObject({ available: 0 });
    expect((await as(t, org.student).get('/api/resources/availability')).status).toBe(400);
  });
});

describe('simultaneous allocation', () => {
  it('never exceeds the stock when many requests arrive at the same moment', async () => {
    const id = await createResource(t, org.admin, { quantity: 5 });
    // 12 different (but overlapping) windows so they are 12 distinct requests, not retries of one
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reserve(org.organizer, id, 1, {
          startAt: day(10, 12).startAt,
          endAt: new Date(new Date(day(10, 12).endAt).getTime() + i * 60_000).toISOString(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(
      results
        .filter((r) => r.status === 409)
        .every((r) => r.body.error.code === 'RESOURCE_EXHAUSTED'),
    ).toBe(true);
    expect(await unitsInUse(id)).toBe(5);
  });

  it('lets only one of several large requests through', async () => {
    const id = await createResource(t, org.admin, { quantity: 5 });
    for (let round = 0; round < 3; round++) {
      await t.ctx.pool.query('TRUNCATE resource_reservations');
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          reserve(org.organizer, id, 3, {
            startAt: day(10, 12).startAt,
            endAt: new Date(new Date(day(10, 12).endAt).getTime() + i * 60_000).toISOString(),
          }),
        ),
      );
      expect(
        results.filter((r) => r.status === 201),
        `round ${round}`,
      ).toHaveLength(1);
      expect(await unitsInUse(id)).toBe(3);
    }
  });

  it('treats identical simultaneous requests as one reservation', async () => {
    const id = await createResource(t, org.admin, { quantity: 5 });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserve(org.organizer, id, 2)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    expect(await rows('SELECT 1 FROM resource_reservations')).toHaveLength(1);
  });

  it('keeps the total right when reservations are increased at the same moment', async () => {
    const id = await createResource(t, org.admin, { quantity: 6 });
    const a = (await reserve(org.organizer, id, 2)).body.data.id as string;
    const b = (await reserve(org.organizer, id, 2, day(10, 13))).body.data.id as string;
    const results = await Promise.all([
      as(t, org.organizer).patch(`/api/resource-reservations/${a}`, { quantity: 4 }),
      as(t, org.organizer).patch(`/api/resource-reservations/${b}`, { quantity: 4 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await unitsInUse(id)).toBeLessThanOrEqual(6);
  });
});

describe('changing and releasing reservations', () => {
  it('changes quantity within the limit, refuses beyond it, and frees units on release', async () => {
    const id = await createResource(t, org.admin, { quantity: 5 });
    const a = (await reserve(org.organizer, id, 2)).body.data.id as string;
    expect(
      (await as(t, org.organizer).patch(`/api/resource-reservations/${a}`, { quantity: 5 })).body
        .data.quantity,
    ).toBe(5);
    expect(
      (await as(t, org.organizer).patch(`/api/resource-reservations/${a}`, { quantity: 6 })).body
        .error.code,
    ).toBe('RESOURCE_EXHAUSTED');
    expect(
      (
        await as(t, org.organizer).patch(`/api/resource-reservations/${a}`, {
          quantity: 1,
          notes: 'Smaller',
        })
      ).body.data,
    ).toMatchObject({ quantity: 1, notes: 'Smaller' });
    expect((await as(t, org.organizer).patch(`/api/resource-reservations/${a}`, {})).status).toBe(
      400,
    );

    const released = await as(t, org.organizer).post(`/api/resource-reservations/${a}/release`, {
      comment: 'Not needed',
    });
    expect(released.body.data).toMatchObject({ status: 'released', releaseReason: 'Not needed' });
    expect((await reserve(org.organizer, id, 5)).status).toBe(201); // stock is free again
    expect(
      (await as(t, org.organizer).post(`/api/resource-reservations/${a}/release`)).body.error.code,
    ).toBe('RESERVATION_CLOSED');
    expect(
      (await as(t, org.organizer).patch(`/api/resource-reservations/${a}`, { quantity: 1 })).body
        .error.code,
    ).toBe('RESERVATION_CLOSED');
    const audit = await rows(
      "SELECT action FROM audit_log WHERE action LIKE 'resource.%' ORDER BY id",
    );
    expect(audit.map((x) => x.action)).toEqual([
      'resource.created',
      'resource.reserved',
      'resource.reservation_updated',
      'resource.reservation_updated',
      'resource.released',
      'resource.reserved',
    ]);
  });

  it('allows only the organizer or an admin to change or release', async () => {
    const id = await createResource(t, org.admin);
    const a = (await reserve(org.organizer, id, 1)).body.data.id as string;
    expect(
      (await as(t, org.faculty).patch(`/api/resource-reservations/${a}`, { quantity: 2 })).status,
    ).toBe(403);
    expect((await as(t, org.faculty).post(`/api/resource-reservations/${a}/release`)).status).toBe(
      403,
    );
    expect(
      (await as(t, org.otherFaculty).post(`/api/resource-reservations/${a}/release`)).status,
    ).toBe(404);
    expect(
      (await as(t, org.student).patch(`/api/resource-reservations/${a}`, { quantity: 2 })).status,
    ).toBe(404);
    expect((await as(t, org.admin).post(`/api/resource-reservations/${a}/release`)).status).toBe(
      200,
    );
    expect(
      (
        await as(t, org.admin).patch(
          '/api/resource-reservations/00000000-0000-4000-8000-000000000000',
          { quantity: 2 },
        )
      ).status,
    ).toBe(404);
  });

  it("lists an event's reservations for the organizer, admins and department staff only", async () => {
    const id = await createResource(t, org.admin, { name: 'Projector' });
    await reserve(org.organizer, id, 2);
    for (const who of [org.organizer, org.admin, org.faculty, org.hod]) {
      expect(
        (await as(t, who).get(`/api/resource-reservations?eventId=${eventId}`)).body.data,
      ).toMatchObject([{ resourceName: 'Projector', quantity: 2 }]);
    }
    await as(t, org.organizer).post(`/api/events/${eventId}/publish`);
    expect(
      (await as(t, org.student).get(`/api/resource-reservations?eventId=${eventId}`)).body.data,
    ).toEqual([]);
    expect(
      (await as(t, org.otherFaculty).get(`/api/resource-reservations?eventId=${eventId}`)).body
        .data,
    ).toEqual([]);
    expect((await as(t, org.organizer).get('/api/resource-reservations')).status).toBe(400);
  });

  it('will not shrink the total below what is already reserved for the future', async () => {
    const id = await createResource(t, org.admin, { quantity: 6 });
    await reserve(org.organizer, id, 4);
    const refused = await as(t, org.admin).patch(`/api/resources/${id}`, { quantity: 3 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'RESOURCE_IN_USE',
      details: { committed: 4 },
    });
    expect((await as(t, org.admin).patch(`/api/resources/${id}`, { quantity: 4 })).status).toBe(
      200,
    );
    expect(
      (await as(t, org.admin).patch(`/api/resources/${id}`, { status: 'maintenance' })).status,
    ).toBe(200); // existing reservations stay
    expect(await unitsInUse(id)).toBe(4);
  });
});

describe('resources follow the event lifecycle', () => {
  it('releases reservations when the event is cancelled or sent back for revision, but not when unpublished', async () => {
    const id = await createResource(t, org.admin);
    const keep = await createApprovedEvent(t, org, { title: 'Stays approved' });
    await reserve(org.organizer, id, 1);
    await reserve(org.organizer, id, 1, {}, keep);
    await as(t, org.organizer).post(`/api/events/${eventId}/publish`);
    await as(t, org.organizer).post(`/api/events/${eventId}/unpublish`);
    expect(
      (await rows("SELECT 1 FROM resource_reservations WHERE status = 'confirmed'")).length,
    ).toBe(2);

    await as(t, org.organizer).post(`/api/events/${eventId}/revise`);
    expect(
      (
        await rows(
          'SELECT event_id, status, release_reason FROM resource_reservations ORDER BY created_at',
        )
      )[0],
    ).toMatchObject({
      event_id: eventId,
      status: 'released',
      release_reason: 'The event was sent back to draft for revision',
    });
    expect((await reserve(org.organizer, id, 1)).body.error.code).toBe('EVENT_NOT_APPROVED'); // the event is a draft again

    await as(t, org.organizer).post(`/api/events/${keep}/cancel`, { comment: 'Called off' });
    expect(
      await rows("SELECT 1 FROM resource_reservations WHERE status = 'confirmed'"),
    ).toHaveLength(0);
    expect(await rows("SELECT 1 FROM audit_log WHERE action = 'resource.released'")).toHaveLength(
      2,
    );
  });
});
