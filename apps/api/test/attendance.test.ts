import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signCheckInToken } from '../src/modules/attendance/qr.js';
import { as, buildOrg, buildTestApp, resetDb, type LoggedIn, type Org } from './helpers.js';
import {
  createPublishedEvent,
  createTeam,
  joinTeam,
  post,
  register,
  sessionFor,
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
const audit = (action: string) => q('SELECT * FROM audit_log WHERE action = $1', [action]);
const rowsOf = (ev: string) => q('SELECT * FROM attendance WHERE event_id = $1', [ev]);

/** Moves a published event into its check-in window: it starts in half an hour. */
const openWindow = (ev: string) =>
  q(
    "UPDATE events SET start_at = now() + interval '10 minutes', end_at = now() + interval '3 hours' WHERE id = $1",
    [ev],
  );
const tokenOf = async (who: LoggedIn, regId: string) =>
  (await as(t, who).get(`/api/registrations/${regId}/qr`)).body.data.token as string;
const scan = (who: LoggedIn, ev: string, token: string) =>
  post(t, who, `/api/events/${ev}/check-ins`, { token });
const manual = (who: LoggedIn, ev: string, body: object) =>
  post(t, who, `/api/events/${ev}/check-ins/manual`, body);
const assign = (who: LoggedIn, ev: string, email: string) =>
  post(t, who, `/api/events/${ev}/volunteers`, { email });

/** A published event whose check-in window is open, with `n` registered people and their codes. */
async function gate(n = 3, over: Record<string, unknown> = {}) {
  const ev = await createPublishedEvent(t, org, over);
  const people = await students(t, n);
  const regs: string[] = [];
  for (const p of people) regs.push((await register(t, p, ev)).body.data.id as string);
  await openWindow(ev);
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) tokens.push(await tokenOf(people[i]!, regs[i]!));
  return { ev, people, regs, tokens };
}

describe('scanning a gate pass', () => {
  it('records the person as checked in, with who scanned, and audits it (FR-7.2)', async () => {
    const { ev, people, regs, tokens } = await gate(3);
    const res = await scan(org.organizer, ev, tokens[0]!);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      registrationId: regs[0],
      attendee: { id: people[0]!.user.id },
      team: null,
      method: 'qr',
      counts: { registered: 3, checkedIn: 1 },
    });
    const [row] = await rowsOf(ev);
    expect(row).toMatchObject({
      registration_id: regs[0],
      user_id: people[0]!.user.id,
      checked_in_by: org.organizer.user.id,
      method: 'qr',
      reason: null,
    });
    expect(await audit('attendance.checked_in')).toHaveLength(1);
  });

  it('says "already checked in" with the time on a second scan, and keeps one record', async () => {
    const { ev, tokens } = await gate(1);
    const first = await scan(org.organizer, ev, tokens[0]!);
    const second = await scan(org.organizer, ev, tokens[0]!);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_CHECKED_IN');
    expect(second.body.error.details).toMatchObject({
      checkedInAt: first.body.data.checkedInAt,
      method: 'qr',
    });
    expect(await rowsOf(ev)).toHaveLength(1);
    expect(await audit('attendance.checked_in')).toHaveLength(1);
  });

  it('checks every member of a team in separately, and names the team', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead, member] = await students(t, 2);
    const created = await createTeam(t, lead!, ev, 'Gate Crashers');
    const joined = await joinTeam(t, member!, created.body.data.invitationCode);
    await openWindow(ev);
    const a = await scan(
      org.organizer,
      ev,
      await tokenOf(lead!, created.body.data.registration.id),
    );
    const b = await scan(
      org.organizer,
      ev,
      await tokenOf(member!, joined.body.data.registration.id),
    );
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.team).toBe('Gate Crashers');
    expect(b.body.data.counts).toEqual({ registered: 2, checkedIn: 2, inside: 2 });
  });

  it('works from a code the registrant fetched, end to end', async () => {
    const { ev, people, regs } = await gate(1);
    const pass = await as(t, people[0]!).get(`/api/registrations/${regs[0]}/qr`);
    expect((await scan(org.organizer, ev, pass.body.data.token)).status).toBe(201);
    const after = await as(t, people[0]!).get(`/api/registrations/${regs[0]}/qr`);
    expect(after.body.data.checkedInAt).toBeTruthy();
  });
});

describe('rejecting bad codes (AC-7.1, AC-7.3)', () => {
  it('rejects a tampered, truncated or invented code with 400 and records nothing', async () => {
    const { ev, tokens } = await gate(1);
    const [version, payload, signature] = tokens[0]!.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        x: 4102444800,
      }),
    ).toString('base64url');
    const bad = [
      `${version}.${forgedPayload}.${signature}`,
      `${version}.${payload}.${signature.slice(0, -4)}`,
      `${version}.${payload}`,
      'EQ1.eyJ9.AAAA',
      'hello',
    ];
    for (const token of bad) {
      const res = await scan(org.organizer, ev, token);
      expect(res.status, token).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await rowsOf(ev)).toHaveLength(0);
  });

  it('rejects a pass from another event (400) and records nothing at either event', async () => {
    const a = await gate(1);
    const b = await gate(1);
    const res = await scan(org.organizer, b.ev, a.tokens[0]!);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/different event/);
    expect(await rowsOf(a.ev)).toHaveLength(0);
    expect(await rowsOf(b.ev)).toHaveLength(0);
    expect((await scan(org.organizer, a.ev, a.tokens[0]!)).status).toBe(201); // right event: fine
  });

  it('rejects an expired pass with its own message', async () => {
    const { ev, regs } = await gate(1);
    const expired = signCheckInToken(t.ctx.config, {
      registrationId: regs[0]!,
      eventId: ev,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await scan(org.organizer, ev, expired);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/expired/);
  });

  it('rejects a body that is not exactly { token } (400)', async () => {
    const { ev, tokens } = await gate(1);
    expect((await post(t, org.organizer, `/api/events/${ev}/check-ins`, {})).status).toBe(400);
    expect(
      (await post(t, org.organizer, `/api/events/${ev}/check-ins`, { token: tokens[0], extra: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await post(t, org.organizer, '/api/events/not-a-uuid/check-ins', { token: 'x' })).status,
    ).toBe(400);
  });

  it('refuses the pass of a cancelled registration, and of someone only on the waitlist', async () => {
    const { ev, people, regs, tokens } = await gate(2, { capacity: 2 });
    await post(t, people[0]!, `/api/registrations/${regs[0]}/cancel`);
    const cancelled = await scan(org.organizer, ev, tokens[0]!);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.code).toBe('REGISTRATION_NOT_ACTIVE');

    // the cancelled seat is taken; a third person now waits, and a code made for them is still refused
    const [waiter, extra] = await students(t, 2);
    await register(t, extra!, ev);
    await openWindow(ev);
    const queued = await post(t, waiter!, `/api/events/${ev}/registrations`, { waitlist: true });
    const forged = signCheckInToken(t.ctx.config, {
      registrationId: queued.body.data.id,
      eventId: ev,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const res = await scan(org.organizer, ev, forged);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/waitlist/);
    expect(await rowsOf(ev)).toHaveLength(0);
  });
});

describe('who may scan (AC-7.4)', () => {
  it('needs a signed-in user, and refuses everyone who is not the organizer, an admin or an assigned volunteer', async () => {
    const { ev, people, tokens } = await gate(1);
    expect(
      (await request(t.app).post(`/api/events/${ev}/check-ins`).send({ token: tokens[0] })).status,
    ).toBe(401);
    const outsiders = [
      people[0]!,
      org.student,
      org.faculty,
      org.hod,
      org.otherOrganizer,
      org.otherFaculty,
    ];
    for (const who of outsiders) {
      expect((await scan(who, ev, tokens[0]!)).status).toBe(403);
    }
    expect(await rowsOf(ev)).toHaveLength(0);
  });

  it('lets an admin scan', async () => {
    const { ev, tokens } = await gate(1);
    expect((await scan(org.admin, ev, tokens[0]!)).status).toBe(201);
  });

  it('lets an assigned volunteer scan, and stops when they are removed', async () => {
    const { ev, tokens } = await gate(2);
    const vol = await sessionFor(t);
    expect((await scan(vol, ev, tokens[0]!)).status).toBe(403);
    expect((await assign(org.organizer, ev, vol.user.email)).status).toBe(200);
    expect((await scan(vol, ev, tokens[0]!)).status).toBe(201);
    expect((await rowsOf(ev))[0].checked_in_by).toBe(vol.user.id);
    expect(
      (await as(t, org.organizer).delete(`/api/events/${ev}/volunteers/${vol.user.id}`)).status,
    ).toBe(200);
    expect((await scan(vol, ev, tokens[1]!)).status).toBe(403);
  });

  it('does not let a volunteer of one event scan at another', async () => {
    const a = await gate(1);
    const b = await gate(1);
    const vol = await sessionFor(t);
    await assign(org.organizer, a.ev, vol.user.email);
    expect((await scan(vol, b.ev, b.tokens[0]!)).status).toBe(403);
  });

  it('hides an event that is not public from people who cannot see it (404)', async () => {
    const { createDraft } = await import('./helpers.js');
    const draft = await createDraft(t, org.organizer);
    expect((await scan(org.student, draft, 'EQ1.x.y')).status).toBe(404);
  });
});

describe('the check-in window', () => {
  it('is closed until 15 minutes before the start', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    const reg = await register(t, sam!, ev);
    const token = await tokenOf(sam!, reg.body.data.id);
    const res = await scan(org.organizer, ev, token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHECK_IN_CLOSED');
    expect(res.body.error.details.opensAt).toBeTruthy();

    await q(
      "UPDATE events SET start_at = now() + interval '20 minutes', end_at = now() + interval '5 hours' WHERE id = $1",
      [ev],
    );
    expect((await scan(org.organizer, ev, token)).body.error.code).toBe('CHECK_IN_CLOSED');
    await q(
      "UPDATE events SET start_at = now() + interval '14 minutes', end_at = now() + interval '5 hours' WHERE id = $1",
      [ev],
    );
    expect((await scan(org.organizer, ev, token)).status).toBe(201);
  });

  it('closes when the event ends, and for events that are no longer published', async () => {
    const { ev, tokens } = await gate(2);
    await q(
      "UPDATE events SET start_at = now() - interval '3 hours', end_at = now() - interval '1 minute' WHERE id = $1",
      [ev],
    );
    expect((await scan(org.organizer, ev, tokens[0]!)).body.error.code).toBe('CHECK_IN_CLOSED');
    await openWindow(ev);
    await q("UPDATE events SET status = 'closed' WHERE id = $1", [ev]);
    expect((await scan(org.organizer, ev, tokens[1]!)).body.error.code).toBe('CHECK_IN_CLOSED');
    expect(await rowsOf(ev)).toHaveLength(0);
  });
});

describe('manual check-in (FR-7.4)', () => {
  it('lets the organizer check someone in with a reason, and logs it', async () => {
    const { ev, people, regs } = await gate(2);
    const res = await manual(org.organizer, ev, {
      registrationId: regs[0],
      reason: 'Phone battery died',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ method: 'manual', attendee: { id: people[0]!.user.id } });
    expect((await rowsOf(ev))[0]).toMatchObject({ method: 'manual', reason: 'Phone battery died' });
    const logged = await audit('attendance.manual_check_in');
    expect(logged).toHaveLength(1);
    expect(logged[0].metadata).toMatchObject({
      reason: 'Phone battery died',
      registrationId: regs[0],
    });
    expect(
      (await manual(org.admin, ev, { registrationId: regs[1], reason: 'Lost the pass' })).status,
    ).toBe(201);
  });

  it('is for organizers and admins only, not volunteers or staff', async () => {
    const { ev, regs } = await gate(1);
    const vol = await sessionFor(t);
    await assign(org.organizer, ev, vol.user.email);
    for (const who of [vol, org.faculty, org.hod, org.student, org.otherOrganizer]) {
      expect(
        (await manual(who, ev, { registrationId: regs[0], reason: 'No scanner' })).status,
      ).toBe(403);
    }
    expect((await request(t.app).post(`/api/events/${ev}/check-ins/manual`).send({})).status).toBe(
      401,
    );
    expect(await rowsOf(ev)).toHaveLength(0);
  });

  it('needs a real reason and a registration of this event that is still active', async () => {
    const a = await gate(2);
    const b = await gate(1);
    const api = (body: object) => manual(org.organizer, a.ev, body);
    expect((await api({ registrationId: a.regs[0] })).status).toBe(400);
    expect((await api({ registrationId: a.regs[0], reason: 'x' })).status).toBe(400);
    expect((await api({ registrationId: a.regs[0], reason: '   ' })).status).toBe(400);
    expect((await api({ registrationId: a.regs[0], reason: 'ok reason', extra: 1 })).status).toBe(
      400,
    );
    expect((await api({ registrationId: b.regs[0], reason: 'wrong event' })).status).toBe(404);
    expect(
      (await api({ registrationId: '11111111-1111-4111-8111-111111111111', reason: 'unknown' }))
        .status,
    ).toBe(404);
    await post(t, a.people[1]!, `/api/registrations/${a.regs[1]}/cancel`);
    expect(
      (await api({ registrationId: a.regs[1], reason: 'was cancelled' })).body.error.code,
    ).toBe('REGISTRATION_NOT_ACTIVE');
    expect(await rowsOf(a.ev)).toHaveLength(0);
  });

  it('cannot check the same person in twice, by hand or by scan, in either order', async () => {
    const { ev, regs, tokens } = await gate(2);
    await manual(org.organizer, ev, { registrationId: regs[0], reason: 'First by hand' });
    expect((await scan(org.organizer, ev, tokens[0]!)).body.error.code).toBe('ALREADY_CHECKED_IN');
    expect(
      (await manual(org.organizer, ev, { registrationId: regs[0], reason: 'Again' })).body.error
        .code,
    ).toBe('ALREADY_CHECKED_IN');
    await scan(org.organizer, ev, tokens[1]!);
    const again = await manual(org.organizer, ev, {
      registrationId: regs[1],
      reason: 'After the scan',
    });
    expect(again.body.error.code).toBe('ALREADY_CHECKED_IN');
    expect(again.body.error.details.method).toBe('qr');
    expect(await rowsOf(ev)).toHaveLength(2);
  });
});

describe('what the database guarantees', () => {
  it('allows one attendance row per registration and ties a reason to manual check-ins', async () => {
    const { ev, people, regs } = await gate(1);
    const insert = (method: string, reason: string | null, reg = regs[0]) =>
      q(
        `INSERT INTO attendance (registration_id, event_id, user_id, checked_in_by, method, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [reg, ev, people[0]!.user.id, org.organizer.user.id, method, reason],
      );
    await expect(insert('manual', null)).rejects.toMatchObject({
      constraint: 'attendance_reason_check',
    });
    await expect(insert('manual', '  ')).rejects.toMatchObject({
      constraint: 'attendance_reason_check',
    });
    await expect(insert('qr', 'a reason')).rejects.toMatchObject({
      constraint: 'attendance_reason_check',
    });
    await expect(insert('telepathy', null)).rejects.toMatchObject({
      constraint: 'attendance_method_check',
    });
    await insert('qr', null);
    await expect(insert('qr', null)).rejects.toMatchObject({
      code: '23505',
      constraint: 'attendance_registration_key',
    });
    await expect(insert('manual', 'second try')).rejects.toMatchObject({
      constraint: 'attendance_registration_key',
    });
  });
});

describe('simultaneous scans (AC-7.2)', () => {
  it('records exactly one check-in when one pass is scanned by many scanners at once', async () => {
    const { ev, tokens } = await gate(1);
    const volunteers = await students(t, 4);
    for (const v of volunteers) await assign(org.organizer, ev, v.user.email);
    const scanners = [org.organizer, org.admin, ...volunteers];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => scan(scanners[i % scanners.length]!, ev, tokens[0]!)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const refused = results.filter((r) => r.status !== 201);
    expect(refused).toHaveLength(11);
    expect(
      refused.every((r) => r.status === 409 && r.body.error.code === 'ALREADY_CHECKED_IN'),
    ).toBe(true);
    expect(await rowsOf(ev)).toHaveLength(1);
    expect(await audit('attendance.checked_in')).toHaveLength(1);
  });

  it('checks many different people in at the same time without losing or doubling any', async () => {
    const { ev, tokens } = await gate(25);
    const results = await Promise.all(tokens.map((tok) => scan(org.organizer, ev, tok)));
    expect(results.map((r) => r.status)).toEqual(Array(25).fill(201));
    expect(await rowsOf(ev)).toHaveLength(25);
    const summary = await as(t, org.organizer).get(`/api/events/${ev}/attendance`);
    expect(summary.body.summary).toMatchObject({ registered: 25, checkedIn: 25, remaining: 0 });
  });

  it('never lets a registration be both cancelled and checked in, whichever request wins', async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb(t.ctx);
      org = await buildOrg(t);
      const { ev, people, regs, tokens } = await gate(10);
      const results = await Promise.all([
        ...tokens.map((tok) => scan(org.organizer, ev, tok)),
        ...people.map((p, i) => post(t, p, `/api/registrations/${regs[i]}/cancel`)),
      ]);
      expect(results.map((r) => r.body?.error?.code)).not.toContain('INTERNAL_ERROR');
      const both = await q(
        `SELECT 1 FROM attendance a JOIN registrations r ON r.id = a.registration_id
          WHERE a.event_id = $1 AND r.status <> 'registered'`,
        [ev],
      );
      expect(both, `round ${round}`).toHaveLength(0);
      // every person ends up either checked in or cancelled, never neither and never both
      const checked = (await rowsOf(ev)).length;
      const cancelled = (
        await q("SELECT 1 FROM registrations WHERE event_id = $1 AND status = 'cancelled'", [ev])
      ).length;
      expect(checked + cancelled, `round ${round}`).toBe(10);
    }
  });

  it('refuses to cancel a registration after the person has been checked in', async () => {
    const { ev, people, regs, tokens } = await gate(1);
    await scan(org.organizer, ev, tokens[0]!);
    const res = await post(t, people[0]!, `/api/registrations/${regs[0]}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CHECKED_IN');
    expect((await q('SELECT status FROM registrations WHERE id = $1', [regs[0]]))[0].status).toBe(
      'registered',
    );
  });
});

describe('live attendance (FR-7.5)', () => {
  it('shows the counts and the latest check-ins to scanners and department staff', async () => {
    const { ev, people, tokens } = await gate(4);
    await scan(org.organizer, ev, tokens[0]!);
    await scan(org.admin, ev, tokens[2]!);
    const vol = await sessionFor(t);
    await assign(org.organizer, ev, vol.user.email);

    for (const who of [org.organizer, org.admin, vol, org.faculty, org.hod]) {
      const res = await as(t, who).get(`/api/events/${ev}/attendance`);
      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject({
        registered: 4,
        checkedIn: 2,
        remaining: 2,
        open: true,
      });
      expect(res.body.data.map((r: { attendee: { id: string } }) => r.attendee.id)).toEqual([
        people[2]!.user.id,
        people[0]!.user.id,
      ]);
      expect(res.body.data[0]).toMatchObject({
        method: 'qr',
        checkedInBy: expect.stringContaining('admin'),
      });
    }
    for (const who of [people[1]!, org.student, org.otherFaculty, org.otherHod]) {
      expect((await as(t, who).get(`/api/events/${ev}/attendance`)).status).toBe(403);
    }
    expect((await request(t.app).get(`/api/events/${ev}/attendance`)).status).toBe(401);
  });

  it('shows the window and reports it closed when it is', async () => {
    const ev = await createPublishedEvent(t, org);
    const res = await as(t, org.organizer).get(`/api/events/${ev}/attendance`);
    expect(res.body.summary).toMatchObject({ registered: 0, checkedIn: 0, open: false });
    expect(Date.parse(res.body.summary.closesAt)).toBeGreaterThan(
      Date.parse(res.body.summary.opensAt),
    );
  });

  it('pages the list and validates the query', async () => {
    const { ev, tokens } = await gate(5);
    for (const tok of tokens) await scan(org.organizer, ev, tok);
    const api = as(t, org.organizer);
    const p1 = await api.get(`/api/events/${ev}/attendance?limit=2&offset=0`);
    const p2 = await api.get(`/api/events/${ev}/attendance?limit=2&offset=2`);
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.page.total).toBe(5);
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
    for (const bad of ['limit=0', 'limit=101', 'offset=-1', 'x=1']) {
      expect((await api.get(`/api/events/${ev}/attendance?${bad}`)).status).toBe(400);
    }
  });
});

describe('volunteers', () => {
  it('assigns by email in any case, lists them, and does nothing twice', async () => {
    const ev = await createPublishedEvent(t, org);
    const vol = await sessionFor(t);
    const first = await assign(org.organizer, ev, vol.user.email.toUpperCase());
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.data[0]).toMatchObject({ userId: vol.user.id, email: vol.user.email });
    const again = await assign(org.admin, ev, vol.user.email);
    expect(again.body.data).toHaveLength(1);
    expect(await audit('volunteer.assigned')).toHaveLength(1);
    expect((await as(t, org.organizer).get(`/api/events/${ev}/volunteers`)).body.data).toHaveLength(
      1,
    );

    const removed = await as(t, org.organizer).delete(
      `/api/events/${ev}/volunteers/${vol.user.id}`,
    );
    expect(removed.body.data).toHaveLength(0);
    await as(t, org.organizer).delete(`/api/events/${ev}/volunteers/${vol.user.id}`);
    expect(await audit('volunteer.removed')).toHaveLength(1);
  });

  it('is managed by the organizer and admins only', async () => {
    const ev = await createPublishedEvent(t, org);
    const vol = await sessionFor(t);
    const other = await sessionFor(t);
    await assign(org.organizer, ev, vol.user.email);
    for (const who of [vol, org.faculty, org.hod, org.student, org.otherOrganizer]) {
      expect((await assign(who, ev, other.user.email)).status).toBe(403);
      expect((await as(t, who).get(`/api/events/${ev}/volunteers`)).status).toBe(403);
      expect((await as(t, who).delete(`/api/events/${ev}/volunteers/${vol.user.id}`)).status).toBe(
        403,
      );
    }
    expect(
      (await request(t.app).post(`/api/events/${ev}/volunteers`).send({ email: 'a@b.co' })).status,
    ).toBe(401);
  });

  it('refuses unknown or deactivated accounts, bad input, and ended events', async () => {
    const ev = await createPublishedEvent(t, org);
    expect((await assign(org.organizer, ev, 'nobody@college.test')).status).toBe(404);
    const gone = await sessionFor(t);
    await q('UPDATE users SET is_active = false WHERE id = $1', [gone.user.id]);
    expect((await assign(org.organizer, ev, gone.user.email)).status).toBe(404);
    expect(
      (await post(t, org.organizer, `/api/events/${ev}/volunteers`, { email: 'not-an-email' }))
        .status,
    ).toBe(400);
    expect(
      (await post(t, org.organizer, `/api/events/${ev}/volunteers`, { email: 'a@b.co', x: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await as(t, org.organizer).delete(`/api/events/${ev}/volunteers/not-a-uuid`)).status,
    ).toBe(400);
    const live = await sessionFor(t);
    await as(t, org.organizer).post(`/api/events/${ev}/cancel`, { comment: 'Called off' });
    expect((await assign(org.organizer, ev, live.user.email)).status).toBe(409);
  });
});

describe('which events can I scan for', () => {
  it('lists published, unfinished events by role', async () => {
    const mine = await createPublishedEvent(t, org, { title: 'Mine' });
    const theirs = await createPublishedEvent(t, org, { title: 'Theirs' });
    const finished = await createPublishedEvent(t, org, { title: 'Finished' });
    await q(
      "UPDATE events SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1",
      [finished],
    );
    const { createApprovedEvent } = await import('./helpers.js');
    await createApprovedEvent(t, org, { title: 'Unpublished' });
    const vol = await sessionFor(t);
    await assign(org.organizer, theirs, vol.user.email);

    const titles = async (who: LoggedIn) =>
      (await as(t, who).get('/api/check-in/events')).body.data
        .map((e: { title: string }) => e.title)
        .sort();
    expect(await titles(org.organizer)).toEqual(['Mine', 'Theirs']);
    expect(await titles(org.admin)).toEqual(['Mine', 'Theirs']);
    expect(await titles(vol)).toEqual(['Theirs']);
    expect(await titles(org.student)).toEqual([]);
    expect((await as(t, vol).get('/api/check-in/events')).body.data[0].role).toBe('volunteer');
    expect((await as(t, org.organizer).get('/api/check-in/events')).body.data[0].role).toBe(
      'organizer',
    );
    expect((await request(t.app).get('/api/check-in/events')).status).toBe(401);
    expect(mine).toBeTruthy();
  });
});

describe('my own pass', () => {
  it('gives the registrant a signed code and its picture, never cached', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam, other] = await students(t, 2);
    const reg = await register(t, sam!, ev);
    const res = await as(t, sam!).get(`/api/registrations/${reg.body.data.id}/qr`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.token).toMatch(/^EQ1\.[\w-]+\.[\w-]+$/);
    expect(res.body.data.qrImage).toMatch(/^data:image\/png;base64,/);
    expect(res.body.data).toMatchObject({
      gatePassReady: false,
      checkedInAt: null,
      checkedOutAt: null,
    });
    expect(Date.parse(res.body.data.expiresAt)).toBeGreaterThan(Date.now());

    expect((await as(t, other!).get(`/api/registrations/${reg.body.data.id}/qr`)).status).toBe(404);
    expect((await as(t, org.admin).get(`/api/registrations/${reg.body.data.id}/qr`)).status).toBe(
      404,
    );
    expect((await request(t.app).get(`/api/registrations/${reg.body.data.id}/qr`)).status).toBe(
      401,
    );
    expect((await as(t, sam!).get('/api/registrations/not-a-uuid/qr')).status).toBe(400);
  });

  it('gives nothing to a cancelled registration', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    const reg = await register(t, sam!, ev);
    await post(t, sam!, `/api/registrations/${reg.body.data.id}/cancel`);
    const res = await as(t, sam!).get(`/api/registrations/${reg.body.data.id}/qr`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REGISTRATION_NOT_ACTIVE');
  });
});
