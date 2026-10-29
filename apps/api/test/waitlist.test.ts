import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { as, buildOrg, buildTestApp, resetDb, type LoggedIn, type Org } from './helpers.js';
import {
  createPublishedEvent,
  createTeam,
  post,
  register,
  students,
  teamEvent,
} from './registration-helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const emails = async (notification: string) =>
  q("SELECT payload FROM jobs WHERE type = 'email.send' AND payload->>'notification' = $1", [
    notification,
  ]);
const audit = (action: string) => q('SELECT * FROM audit_log WHERE action = $1', [action]);
const queue = (who: LoggedIn, ev: string) =>
  post(t, who, `/api/events/${ev}/registrations`, { waitlist: true });
const cancel = (who: LoggedIn, regId: string) => post(t, who, `/api/registrations/${regId}/cancel`);
const count = async (ev: string, status: string) =>
  (
    await q('SELECT count(*)::int AS n FROM registrations WHERE event_id = $1 AND status = $2', [
      ev,
      status,
    ])
  )[0].n as number;

/** A full event of `capacity` seats, its holders, and `waiting` people queued in order. */
async function fullEvent(capacity: number, waiting: number, over: Record<string, unknown> = {}) {
  const ev = await createPublishedEvent(t, org, { capacity, ...over });
  const people = await students(t, capacity + waiting);
  const holders = people.slice(0, capacity);
  const queued = people.slice(capacity);
  const held = [];
  for (const h of holders) held.push((await register(t, h, ev)).body.data.id as string);
  const waits = [];
  for (const w of queued) waits.push((await queue(w, ev)).body.data.id as string);
  return { ev, holders, queued, held, waits };
}

describe('joining the waitlist', () => {
  it('refuses a plain registration when full, but queues people who ask, in order', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 2 });
    const [a, b, c, d, e] = await students(t, 5);
    await register(t, a!, ev);
    await register(t, b!, ev);

    const plain = await register(t, c!, ev);
    expect(plain.status).toBe(409);
    expect(plain.body.error.code).toBe('EVENT_FULL');

    const w1 = await queue(c!, ev);
    const w2 = await queue(d!, ev);
    const w3 = await queue(e!, ev);
    for (const [res, position] of [
      [w1, 1],
      [w2, 2],
      [w3, 3],
    ] as const) {
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        status: 'waitlisted',
        waitlistPosition: position,
        team: null,
      });
    }
    const sum = await as(t, d!).get(`/api/events/${ev}/registration-summary`);
    expect(sum.body.data).toMatchObject({
      registered: 2,
      seatsLeft: 0,
      full: true,
      waitlisted: 3,
      waitlistOpen: true,
      mine: { status: 'waitlisted', waitlistPosition: 2 },
    });
    expect(await audit('registration.waitlisted')).toHaveLength(3);
    expect(await emails('registration.confirmed')).toHaveLength(2); // waiting people get no confirmation
  });

  it('just registers a person who asked for the waitlist while seats are free', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 3 });
    const [sam] = await students(t, 1);
    const res = await queue(sam!, ev);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'registered', waitlistPosition: null });
    expect(await count(ev, 'waitlisted')).toBe(0);
  });

  it('does not let anyone queue twice, or queue while registered', async () => {
    const { ev, holders, queued } = await fullEvent(1, 1);
    const twice = await queue(queued[0]!, ev);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ALREADY_REGISTERED');
    expect(twice.body.error.message).toMatch(/waitlist/);
    expect((await register(t, queued[0]!, ev)).body.error.code).toBe('ALREADY_REGISTERED');
    expect((await queue(holders[0]!, ev)).body.error.code).toBe('ALREADY_REGISTERED');
    expect(
      await q('SELECT 1 FROM registrations WHERE user_id = $1', [queued[0]!.user.id]),
    ).toHaveLength(1);
  });

  it('is only for individual events', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent({ capacity: 2, teamSizeMax: 2 }));
    const [a, b, c] = await students(t, 3);
    const created = await createTeam(t, a!, ev, 'Full House');
    await post(t, b!, '/api/teams/join', { code: created.body.data.invitationCode });
    expect((await queue(c!, ev)).body.error.code).toBe('WRONG_REGISTRATION_MODE');
    expect((await createTeam(t, c!, ev, 'Latecomers')).body.error.code).toBe('EVENT_FULL');
    const sum = await as(t, c!).get(`/api/events/${ev}/registration-summary`);
    expect(sum.body.data).toMatchObject({ full: true, waitlistOpen: false });
  });

  it('is closed once registration closes, like registration itself', async () => {
    const { ev } = await fullEvent(1, 0);
    await q("UPDATE events SET registration_deadline = now() - interval '1 hour' WHERE id = $1", [
      ev,
    ]);
    const [late] = await students(t, 1);
    expect((await queue(late!, ev)).body.error.code).toBe('REGISTRATION_CLOSED');
  });

  it('rejects a malformed request (400)', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 1 });
    const [sam] = await students(t, 1);
    expect(
      (await post(t, sam!, `/api/events/${ev}/registrations`, { waitlist: 'yes' })).status,
    ).toBe(400);
    expect((await post(t, sam!, `/api/events/${ev}/registrations`, { vip: true })).status).toBe(
      400,
    );
    expect(
      (await request(t.app).post(`/api/events/${ev}/registrations`).send({ waitlist: true }))
        .status,
    ).toBe(401);
  });

  it('replays a repeated request with the same key, and refuses the key for a different request', async () => {
    const { ev } = await fullEvent(1, 0);
    const [sam] = await students(t, 1);
    const key = 'wait-key-abcdefgh';
    const first = await post(t, sam!, `/api/events/${ev}/registrations`, { waitlist: true }, key);
    const again = await post(t, sam!, `/api/events/${ev}/registrations`, { waitlist: true }, key);
    expect(again.body).toEqual(first.body);
    expect(await count(ev, 'waitlisted')).toBe(1);
    const other = await post(t, sam!, `/api/events/${ev}/registrations`, {}, key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('seats passing to the first in line', () => {
  it('promotes in queue order when a seat is given up, and tells the person', async () => {
    const { ev, holders, queued, held } = await fullEvent(2, 3);
    const [c, d, e] = queued;

    expect((await cancel(holders[0]!, held[0]!)).status).toBe(200);
    expect(await count(ev, 'registered')).toBe(2); // the seat went straight to the next person
    const mine = await as(t, c!).get(`/api/events/${ev}/registration-summary`);
    expect(mine.body.data.mine).toMatchObject({ status: 'registered', waitlistPosition: null });
    expect(
      (await as(t, d!).get(`/api/events/${ev}/registration-summary`)).body.data.mine
        .waitlistPosition,
    ).toBe(1);
    expect(
      (await as(t, e!).get(`/api/events/${ev}/registration-summary`)).body.data.mine
        .waitlistPosition,
    ).toBe(2);

    const promoted = await emails('registration.promoted');
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.payload.to).toBe(c!.user.email);
    expect(await audit('registration.promoted')).toHaveLength(1);

    await cancel(holders[1]!, held[1]!);
    expect(
      (await as(t, d!).get(`/api/events/${ev}/registration-summary`)).body.data.mine.status,
    ).toBe('registered');
    expect((await emails('registration.promoted')).map((m) => m.payload.to)).toEqual([
      c!.user.email,
      d!.user.email,
    ]);
  });

  it('lets a person leave the queue without freeing a seat or promoting anyone', async () => {
    const { ev, queued, waits } = await fullEvent(1, 3);
    const [c, d, e] = queued;
    const left = await cancel(d!, waits[1]!);
    expect(left.status).toBe(200);
    expect(left.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'self' });
    expect(
      (await as(t, e!).get(`/api/events/${ev}/registration-summary`)).body.data.mine
        .waitlistPosition,
    ).toBe(2);
    expect(
      (await as(t, c!).get(`/api/events/${ev}/registration-summary`)).body.data.mine
        .waitlistPosition,
    ).toBe(1);
    expect(await count(ev, 'registered')).toBe(1);
    expect(await emails('registration.promoted')).toHaveLength(0);
    // and may queue again, at the back
    const back = await queue(d!, ev);
    expect(back.body.data).toMatchObject({ status: 'waitlisted', waitlistPosition: 3 });
  });

  it('does not promote anyone once registration has closed', async () => {
    const { ev, holders, queued, held } = await fullEvent(1, 1);
    await q("UPDATE events SET registration_deadline = now() - interval '1 hour' WHERE id = $1", [
      ev,
    ]);
    expect((await cancel(holders[0]!, held[0]!)).status).toBe(200);
    expect(await count(ev, 'registered')).toBe(0);
    expect(await count(ev, 'waitlisted')).toBe(1);
    expect(await emails('registration.promoted')).toHaveLength(0);
    expect(queued).toHaveLength(1);
  });

  it('gives a promoted person the same rights as anyone registered, including giving the seat on', async () => {
    const { ev, holders, queued, held } = await fullEvent(1, 2);
    await cancel(holders[0]!, held[0]!);
    const promotedReg = (await as(t, queued[0]!).get(`/api/events/${ev}/registration-summary`)).body
      .data.mine.id;
    await cancel(queued[0]!, promotedReg);
    expect(
      (await as(t, queued[1]!).get(`/api/events/${ev}/registration-summary`)).body.data.mine.status,
    ).toBe('registered');
    expect(await count(ev, 'registered')).toBe(1);
  });

  it('lets a person who gave up their seat register again only by queueing when the seat was taken', async () => {
    const { ev, holders, held } = await fullEvent(1, 1);
    await cancel(holders[0]!, held[0]!); // the waiting person takes the seat
    expect((await register(t, holders[0]!, ev)).body.error.code).toBe('EVENT_FULL');
    const back = await queue(holders[0]!, ev);
    expect(back.status).toBe(201);
    expect(back.body.data).toMatchObject({ status: 'waitlisted', waitlistPosition: 1 });
    expect(
      await q('SELECT 1 FROM registrations WHERE user_id = $1', [holders[0]!.user.id]),
    ).toHaveLength(1);
  });

  it('cancels waiting people, and emails them, when the event is cancelled', async () => {
    const { ev, queued } = await fullEvent(1, 2);
    const res = await as(t, org.organizer).post(`/api/events/${ev}/cancel`, {
      comment: 'Called off',
    });
    expect(res.status).toBe(200);
    expect(await count(ev, 'waitlisted')).toBe(0);
    expect(await count(ev, 'registered')).toBe(0);
    const rows = await q('SELECT cancel_reason FROM registrations WHERE event_id = $1', [ev]);
    expect(rows.every((r) => r.cancel_reason === 'event_cancelled')).toBe(true);
    const mail = await emails('registration.event_cancelled');
    expect(mail).toHaveLength(3);
    for (const w of queued) expect(mail.map((m) => m.payload.to)).toContain(w.user.email);
  });
});

describe('who sees the queue', () => {
  it('shows staff the waiting list with positions, and other people nothing', async () => {
    const { ev, queued } = await fullEvent(1, 3);
    const res = await as(t, org.organizer).get(`/api/events/${ev}/registrations?status=waitlisted`);
    expect(res.status).toBe(200);
    expect(res.body.page.total).toBe(3);
    expect(res.body.data.map((r: { waitlistPosition: number }) => r.waitlistPosition)).toEqual([
      1, 2, 3,
    ]);
    expect(res.body.data[0].user.email).toBe(queued[0]!.user.email);
    for (const other of [queued[0]!, org.student, org.otherFaculty]) {
      expect(
        (await as(t, other).get(`/api/events/${ev}/registrations?status=waitlisted`)).status,
      ).toBe(403);
    }
    const everyone = await as(t, org.organizer).get(
      `/api/events/${ev}/registrations?status=registered`,
    );
    expect(everyone.body.page.total).toBe(1);
  });

  it('shows a person their own place in "my registrations"', async () => {
    const { queued } = await fullEvent(1, 2);
    const res = await as(t, queued[1]!).get('/api/registrations');
    expect(res.body.data[0]).toMatchObject({ status: 'waitlisted', waitlistPosition: 2 });
  });

  it('shows everyone how many are waiting without naming them', async () => {
    const { ev, queued } = await fullEvent(1, 2);
    const res = await as(t, org.student).get(`/api/events/${ev}/registration-summary`);
    expect(res.body.data.waitlisted).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain(queued[0]!.user.email);
  });
});

describe('what the database guarantees', () => {
  it('refuses a waiting row without a queue time, or attached to a team', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [a] = await students(t, 1);
    const created = await createTeam(t, a!, ev, 'Real Team');
    const [b] = await students(t, 1);
    await expect(
      q("INSERT INTO registrations (event_id, user_id, status) VALUES ($1, $2, 'waitlisted')", [
        ev,
        b!.user.id,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'registrations_waitlist_check' });
    await expect(
      q(
        "INSERT INTO registrations (event_id, user_id, status, waitlisted_at, team_id) VALUES ($1, $2, 'waitlisted', now(), $3)",
        [ev, b!.user.id, created.body.data.team.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'registrations_waitlist_check' });
  });

  it('keeps one row per person per event even when queueing', async () => {
    const { ev, queued } = await fullEvent(1, 1);
    await expect(
      q(
        "INSERT INTO registrations (event_id, user_id, status, waitlisted_at) VALUES ($1, $2, 'waitlisted', now())",
        [ev, queued[0]!.user.id],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'registrations_event_user_key' });
  });
});

describe('simultaneous requests around the waitlist', () => {
  it('gives 20 people at once distinct places 1 to 20 and takes no seat', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 3 });
    const holders = await students(t, 3);
    for (const h of holders) await register(t, h, ev);
    const people = await students(t, 20);
    const results = await Promise.all(people.map((p) => queue(p, ev)));
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    const positions = results
      .map((r) => r.body.data.waitlistPosition as number)
      .sort((x, y) => x - y);
    expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await count(ev, 'registered')).toBe(3);
    expect(await count(ev, 'waitlisted')).toBe(20);
  });

  it('passes freed seats to exactly the first people in line while newcomers cannot jump the queue', async () => {
    const { ev, holders, queued, held } = await fullEvent(3, 10);
    const newcomers = await students(t, 5);
    const results = await Promise.all([
      ...holders.map((h, i) => cancel(h, held[i]!)),
      ...newcomers.map((p) => register(t, p, ev)),
    ]);
    expect(results.slice(0, 3).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(
      results.slice(3).every((r) => r.status === 409 && r.body.error.code === 'EVENT_FULL'),
    ).toBe(true);
    expect(await count(ev, 'registered')).toBe(3);
    expect(await count(ev, 'waitlisted')).toBe(7);
    const nowSeated = await q(
      "SELECT user_id FROM registrations WHERE event_id = $1 AND status = 'registered'",
      [ev],
    );
    expect(nowSeated.map((r) => r.user_id).sort()).toEqual(
      queued
        .slice(0, 3)
        .map((p) => p.user.id)
        .sort(),
    );
    expect(await emails('registration.promoted')).toHaveLength(3);
  });

  it('promotes everyone when every holder leaves at once', async () => {
    const { ev, holders, queued, held } = await fullEvent(8, 8);
    const results = await Promise.all(holders.map((h, i) => cancel(h, held[i]!)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(await count(ev, 'registered')).toBe(8);
    expect(await count(ev, 'waitlisted')).toBe(0);
    const seated = await q(
      "SELECT user_id FROM registrations WHERE event_id = $1 AND status = 'registered'",
      [ev],
    );
    expect(seated.map((r) => r.user_id).sort()).toEqual(queued.map((p) => p.user.id).sort());
  });

  it('keeps "no free seat while someone waits" true under a mix of cancels, joins and registrations', async () => {
    const { ev, holders, held } = await fullEvent(4, 4);
    const fresh = await students(t, 10);
    const results = await Promise.all([
      ...holders.slice(0, 2).map((h, i) => cancel(h, held[i]!)),
      ...fresh.slice(0, 5).map((p) => register(t, p, ev)),
      ...fresh.slice(5).map((p) => queue(p, ev)),
    ]);
    expect(results.map((r) => r.body?.error?.code)).not.toContain('INTERNAL_ERROR');
    const registered = await count(ev, 'registered');
    const waiting = await count(ev, 'waitlisted');
    expect(registered).toBeLessThanOrEqual(4);
    if (registered < 4) expect(waiting).toBe(0);
  });

  it('leaves nobody registered or waiting when the event is cancelled during joins', async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb(t.ctx);
      org = await buildOrg(t);
      const { ev } = await fullEvent(2, 0);
      const people = await students(t, 15);
      const results = await Promise.all([
        ...people.map((p) => queue(p, ev)),
        as(t, org.organizer).post(`/api/events/${ev}/cancel`, { comment: 'Called off' }),
      ]);
      expect(results[results.length - 1]!.status, `round ${round}`).toBe(200);
      expect(await count(ev, 'registered'), `round ${round}`).toBe(0);
      expect(await count(ev, 'waitlisted'), `round ${round}`).toBe(0);
    }
  });
});
