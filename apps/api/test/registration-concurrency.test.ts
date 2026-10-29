import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { as, buildOrg, buildTestApp, resetDb, type LoggedIn, type Org } from './helpers.js';
import {
  createPublishedEvent,
  createTeam,
  joinTeam,
  post,
  register,
  students,
  teamEvent,
} from './registration-helpers.js';

// Real simultaneous HTTP requests against the real PostgreSQL test database: the proof that seats and
// team places cannot be over-booked. Slow shared CI machines need generous limits; a timed-out test
// would leave requests running into the next test's reset.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const registeredCount = async (eventId: string) =>
  (
    await q(
      "SELECT count(*)::int AS n FROM registrations WHERE event_id = $1 AND status = 'registered'",
      [eventId],
    )
  )[0].n as number;
const statuses = (results: { status: number }[]) => results.map((r) => r.status).sort();
const codes = (results: { body: { error?: { code: string } } }[]) =>
  results.map((r) => r.body.error?.code).filter(Boolean);

describe('simultaneous registrations for the last seats (AC-3.1)', () => {
  it('lets exactly 10 of 50 people in when capacity is 10, over several rounds', async () => {
    const people = await students(t, 50);
    for (let round = 0; round < 3; round++) {
      const ev = await createPublishedEvent(t, org, { capacity: 10, title: `Round ${round}` });
      const results = await Promise.all(people.map((p) => register(t, p, ev)));
      expect(
        results.filter((r) => r.status === 201),
        `round ${round}`,
      ).toHaveLength(10);
      const refused = results.filter((r) => r.status !== 201);
      expect(refused).toHaveLength(40);
      expect(refused.every((r) => r.status === 409 && r.body.error.code === 'EVENT_FULL')).toBe(
        true,
      );
      expect(await registeredCount(ev), `round ${round}`).toBe(10);
    }
  });

  it('never gives one person two seats when they ask many times at once', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 5 });
    const [sam] = await students(t, 1);
    const results = await Promise.all(Array.from({ length: 10 }, () => register(t, sam!, ev)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(codes(results))).toEqual(new Set(['ALREADY_REGISTERED']));
    expect(await registeredCount(ev)).toBe(1);
  });

  it('answers repeated simultaneous requests with the same key as one registration', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => register(t, sam!, ev, 'same-key-abcdefgh')),
    );
    expect(statuses(results)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(9);
    expect(await q('SELECT 1 FROM registrations')).toHaveLength(1);
    expect(await q("SELECT 1 FROM audit_log WHERE action = 'registration.created'")).toHaveLength(
      1,
    );
    expect(
      await q("SELECT 1 FROM jobs WHERE payload->>'notification' = 'registration.confirmed'"),
    ).toHaveLength(1);
  });

  it('keeps the count right while people cancel and others register at the same time', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 3 });
    const people = await students(t, 12);
    const first = await Promise.all(people.slice(0, 3).map((p) => register(t, p, ev)));
    expect(statuses(first)).toEqual([201, 201, 201]);

    const cancels = first.map((r, i) =>
      post(t, people[i]!, `/api/registrations/${r.body.data.id}/cancel`),
    );
    const newcomers = people.slice(3).map((p) => register(t, p, ev));
    const results = await Promise.all([...cancels, ...newcomers]);

    expect(results.slice(0, 3).map((r) => r.status)).toEqual([200, 200, 200]);
    const won = results.slice(3).filter((r) => r.status === 201).length;
    expect(await registeredCount(ev)).toBe(won);
    expect(won).toBeLessThanOrEqual(3);
    expect(codes(results)).not.toContain('INTERNAL_ERROR');
  });

  it('lets a freed last seat go to exactly one of several simultaneous people', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 1 });
    const [holder, ...rest] = await students(t, 9);
    const held = await register(t, holder!, ev);
    const results = await Promise.all([
      post(t, holder!, `/api/registrations/${held.body.data.id}/cancel`),
      ...rest.map((p) => register(t, p, ev)),
    ]);
    expect(results[0]!.status).toBe(200);
    expect(results.slice(1).filter((r) => r.status === 201).length).toBeLessThanOrEqual(1);
    expect(await registeredCount(ev)).toBeLessThanOrEqual(1);
  });
});

describe('simultaneous team joins (AC-3.4)', () => {
  it('never exceeds the maximum team size', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent({ teamSizeMax: 4 }));
    const [lead, ...joiners] = await students(t, 16);
    const code: string = (await createTeam(t, lead!, ev, 'Crowded')).body.data.invitationCode;
    const results = await Promise.all(joiners.map((p) => joinTeam(t, p, code)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(new Set(codes(results))).toEqual(new Set(['TEAM_FULL']));
    const team = (await q('SELECT id FROM teams'))[0];
    expect(
      await q("SELECT 1 FROM registrations WHERE team_id = $1 AND status = 'registered'", [
        team.id,
      ]),
    ).toHaveLength(4);
  });

  it('respects the event capacity across teams that fill up together', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent({ capacity: 5, teamSizeMax: 4 }));
    const people = await students(t, 12);
    const results = await Promise.all(people.map((p, i) => createTeam(t, p, ev, `Team ${i}`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(new Set(codes(results))).toEqual(new Set(['EVENT_FULL']));
    expect(await registeredCount(ev)).toBe(5);
    expect(await q('SELECT 1 FROM teams')).toHaveLength(5); // refused requests leave no team behind
  });

  it('creates one team when several people pick the same name at once', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const people = await students(t, 8);
    const results = await Promise.all(people.map((p) => createTeam(t, p, ev, 'Same Name')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(codes(results))).toEqual(new Set(['TEAM_NAME_TAKEN']));
    expect(await q('SELECT 1 FROM teams')).toHaveLength(1);
    expect(await q('SELECT 1 FROM registrations')).toHaveLength(1);
  });

  it('never leaves a team without its leader when the leader leaves during joins', async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb(t.ctx);
      org = await buildOrg(t);
      const ev = await createPublishedEvent(t, org, teamEvent({ teamSizeMax: 4 }));
      const [lead, first, ...joiners] = await students(t, 8);
      const created = await createTeam(t, lead!, ev, 'Leaderless?');
      const code: string = created.body.data.invitationCode;
      await joinTeam(t, first!, code);
      const results = await Promise.all([
        post(t, lead!, `/api/registrations/${created.body.data.registration.id}/cancel`),
        ...joiners.map((p) => joinTeam(t, p, code)),
      ]);
      expect(codes(results)).not.toContain('INTERNAL_ERROR');

      const [team] = await q('SELECT id, leader_id, status FROM teams');
      const members = await q(
        "SELECT user_id FROM registrations WHERE team_id = $1 AND status = 'registered'",
        [team.id],
      );
      expect(team.status, `round ${round}`).toBe('active');
      expect(members.length).toBeLessThanOrEqual(4);
      expect(
        members.map((m) => m.user_id),
        `round ${round}`,
      ).toContain(team.leader_id);
    }
  });
});

describe('an event cancelled during registration', () => {
  it('leaves nobody registered, whichever side of the cancellation each request landed on', async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb(t.ctx);
      org = await buildOrg(t);
      const ev = await createPublishedEvent(t, org, { capacity: 30 });
      const people = await students(t, 20);
      const results = await Promise.all([
        ...people.map((p) => register(t, p, ev)),
        as(t, org.organizer).post(`/api/events/${ev}/cancel`, { comment: 'Called off' }),
      ]);
      const cancel = results[results.length - 1]!;
      expect(cancel.status, `round ${round}`).toBe(200);
      expect(await registeredCount(ev), `round ${round}`).toBe(0);
      const refused = results.slice(0, -1).filter((r) => r.status !== 201);
      expect(
        refused.every((r) => r.status === 404 || r.body.error.code === 'REGISTRATION_CLOSED'),
      ).toBe(true);
      // a cancelled event is hidden from students (404); a late request may also see it as closed
      // everyone who got in before the cancellation was told, exactly once
      const accepted = results.slice(0, -1).filter((r) => r.status === 201).length;
      expect(
        await q(
          "SELECT 1 FROM jobs WHERE payload->>'notification' = 'registration.event_cancelled'",
        ),
      ).toHaveLength(accepted);
    }
  });

  it('does not let the event be unpublished once a registration got in', async () => {
    const ev = await createPublishedEvent(t, org);
    const people = await students(t, 10);
    const results = await Promise.all([
      ...people.map((p) => register(t, p, ev)),
      as(t, org.organizer).post(`/api/events/${ev}/unpublish`),
    ]);
    const unpublish = results[results.length - 1]!;
    const accepted = results.slice(0, -1).filter((r) => r.status === 201).length;
    const registered = await registeredCount(ev);
    expect(registered).toBe(accepted);
    // either the unpublish won (and later registrations were refused) or some registration was already in
    if (unpublish.status === 200) {
      expect(accepted).toBe(0);
    } else {
      expect(unpublish.body.error.code).toBe('EVENT_HAS_REGISTRATIONS');
      expect(accepted).toBeGreaterThan(0);
    }
  });
});

describe('people share one login each (sanity for the helpers)', () => {
  it('creates distinct users', async () => {
    const people: LoggedIn[] = await students(t, 5);
    expect(new Set(people.map((p) => p.user.id)).size).toBe(5);
  });
});
