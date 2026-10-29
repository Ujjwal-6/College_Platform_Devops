import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attendanceReport } from '../src/modules/attendance/index.js';
import { signCheckInToken } from '../src/modules/attendance/qr.js';
import { as, buildOrg, buildTestApp, resetDb, type LoggedIn, type Org } from './helpers.js';
import {
  createPublishedEvent,
  createTeam,
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
const audit = (action: string) =>
  q('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [action]);
/** Pretends the person left shortly before the event's end. */
const leftNearEnd = (regId: string) =>
  q(
    `UPDATE attendance SET checked_out_at = (SELECT end_at - interval '5 minutes' FROM events WHERE id = event_id)
      WHERE registration_id = $1`,
    [regId],
  );
const registrationIds = async (ev: string) =>
  (
    await q('SELECT id FROM registrations WHERE event_id = $1 ORDER BY registered_at, id', [ev])
  ).map((r) => r.id as string);
const rowsOf = (ev: string) => q('SELECT * FROM attendance WHERE event_id = $1', [ev]);
const sql = (ev: string, start: string, end: string) =>
  q(
    `UPDATE events SET start_at = now() + interval '${start}', end_at = now() + interval '${end}' WHERE id = $1`,
    [ev],
  );
/** In the middle of the event: it began 1 hour ago and ends in 1 hour. */
const midEvent = (ev: string) => sql(ev, '-1 hour', '1 hour');
const tokenOf = async (who: LoggedIn, regId: string) =>
  (await as(t, who).get(`/api/registrations/${regId}/qr`)).body.data.token as string;
const checkIn = (who: LoggedIn, ev: string, token: string) =>
  post(t, who, `/api/events/${ev}/check-ins`, { token });
const checkOut = (who: LoggedIn, ev: string, token: string) =>
  post(t, who, `/api/events/${ev}/check-outs`, { token });
const outByHand = (who: LoggedIn, ev: string, body: object) =>
  post(t, who, `/api/events/${ev}/check-outs/manual`, body);
const walkIn = (who: LoggedIn, ev: string, email: string) =>
  post(t, who, `/api/events/${ev}/check-ins/walk-in`, { email });
const setSettings = (who: LoggedIn, ev: string, body: object) =>
  as(t, who).put(`/api/events/${ev}/attendance-settings`, body);

async function gate(n = 3, over: Record<string, unknown> = {}) {
  const ev = await createPublishedEvent(t, org, over);
  const people = await students(t, n);
  const regs: string[] = [];
  for (const p of people) regs.push((await register(t, p, ev)).body.data.id as string);
  await midEvent(ev);
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) tokens.push(await tokenOf(people[i]!, regs[i]!));
  return { ev, people, regs, tokens };
}

describe('the 15-minute check-in window', () => {
  it('opens 15 minutes before the start and not earlier', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    const reg = await register(t, sam!, ev);
    const token = await tokenOf(sam!, reg.body.data.id);
    await sql(ev, '16 minutes', '2 hours');
    const early = await checkIn(org.organizer, ev, token);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('CHECK_IN_CLOSED');
    const opensAt = Date.parse(early.body.error.details.opensAt);
    const startsAt = (await q('SELECT start_at FROM events WHERE id = $1', [ev]))[0]
      .start_at as Date;
    expect(startsAt.getTime() - opensAt).toBe(15 * 60_000);
    await sql(ev, '14 minutes', '2 hours');
    expect((await checkIn(org.organizer, ev, token)).status).toBe(201);
  });
});

describe('checking out (leaving the event)', () => {
  it('records leaving for someone who was checked in, with how long they stayed', async () => {
    const { ev, people, regs, tokens } = await gate(2);
    await checkIn(org.organizer, ev, tokens[0]!);
    await q(
      "UPDATE attendance SET checked_in_at = now() - interval '45 minutes' WHERE registration_id = $1",
      [regs[0]],
    );

    const res = await checkOut(org.organizer, ev, tokens[0]!);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      registrationId: regs[0],
      attendee: { id: people[0]!.user.id },
      method: 'qr',
      stayedMinutes: 45,
      leftEarly: true,
      counts: { registered: 2, checkedIn: 1, inside: 0 },
    });
    const [row] = await rowsOf(ev);
    expect(row).toMatchObject({
      check_out_method: 'qr',
      check_out_reason: null,
      checked_out_by: org.organizer.user.id,
    });
    expect(row.checked_out_at).toBeTruthy();
    expect(await audit('attendance.checked_out')).toHaveLength(1);
  });

  it('refuses to check out someone who was never checked in, and can only be done once', async () => {
    const { ev, tokens } = await gate(2);
    const none = await checkOut(org.organizer, ev, tokens[0]!);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NOT_CHECKED_IN');

    await checkIn(org.organizer, ev, tokens[0]!);
    const first = await checkOut(org.organizer, ev, tokens[0]!);
    const second = await checkOut(org.organizer, ev, tokens[0]!);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_CHECKED_OUT');
    expect(second.body.error.details.checkedOutAt).toBe(first.body.data.checkedOutAt);
    expect(await audit('attendance.checked_out')).toHaveLength(1);
  });

  it('does not let a person check in again after leaving', async () => {
    const { ev, tokens } = await gate(1);
    await checkIn(org.organizer, ev, tokens[0]!);
    await checkOut(org.organizer, ev, tokens[0]!);
    expect((await checkIn(org.organizer, ev, tokens[0]!)).body.error.code).toBe(
      'ALREADY_CHECKED_IN',
    );
  });

  it('says whether the person left early (more than 15 minutes before the end)', async () => {
    const { ev, tokens } = await gate(2);
    await checkIn(org.organizer, ev, tokens[0]!);
    await checkIn(org.organizer, ev, tokens[1]!);
    expect((await checkOut(org.organizer, ev, tokens[0]!)).body.data.leftEarly).toBe(true); // an hour before the end

    await sql(ev, '-2 hours', '10 minutes'); // now it is nearly over
    const late = await checkOut(org.organizer, ev, tokens[1]!);
    expect(late.body.data.leftEarly).toBe(false);
  });

  it('is for scanners only: organizer, admin and assigned volunteers', async () => {
    const { ev, people, tokens } = await gate(3);
    for (const tok of tokens) await checkIn(org.organizer, ev, tok);
    const vol = await sessionFor(t);
    await post(t, org.organizer, `/api/events/${ev}/volunteers`, { email: vol.user.email });
    for (const who of [people[0]!, org.student, org.faculty, org.hod, org.otherOrganizer]) {
      expect((await checkOut(who, ev, tokens[0]!)).status).toBe(403);
    }
    expect(
      (await request(t.app).post(`/api/events/${ev}/check-outs`).send({ token: tokens[0] })).status,
    ).toBe(401);
    expect((await checkOut(vol, ev, tokens[0]!)).status).toBe(201);
    expect((await checkOut(org.admin, ev, tokens[1]!)).status).toBe(201);
    expect((await rowsOf(ev)).filter((r) => r.checked_out_at)).toHaveLength(2);
  });

  it('rejects bad, expired and other-event codes (400) and records nothing', async () => {
    const a = await gate(1);
    const b = await gate(1);
    await checkIn(org.organizer, a.ev, a.tokens[0]!);
    const expired = signCheckInToken(t.ctx.config, {
      registrationId: a.regs[0]!,
      eventId: a.ev,
      expiresAt: new Date(Date.now() - 60_000),
    });
    for (const [ev, token] of [
      [a.ev, 'nonsense'],
      [a.ev, a.tokens[0]!.slice(0, -3)],
      [b.ev, a.tokens[0]!],
      [a.ev, expired],
    ] as const) {
      expect((await checkOut(org.organizer, ev, token)).status).toBe(400);
    }
    expect((await rowsOf(a.ev))[0].checked_out_at).toBeNull();
  });

  it('is open from the start of check-in until an hour after the end', async () => {
    const { ev, tokens } = await gate(2);
    await checkIn(org.organizer, ev, tokens[0]!);
    await checkIn(org.organizer, ev, tokens[1]!);

    await sql(ev, '-3 hours', '-30 minutes'); // ended half an hour ago: still open
    expect((await checkOut(org.organizer, ev, tokens[0]!)).status).toBe(201);
    await q("UPDATE events SET status = 'closed' WHERE id = $1", [ev]); // closing the event does not stop it
    await sql(ev, '-3 hours', '-90 minutes'); // ended an hour and a half ago: closed
    const late = await checkOut(org.organizer, ev, tokens[1]!);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CHECK_OUT_CLOSED');
  });

  it('works for each member of a team', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead] = await students(t, 1);
    const created = await createTeam(t, lead!, ev, 'Leavers');
    await midEvent(ev);
    const token = await tokenOf(lead!, created.body.data.registration.id);
    await checkIn(org.organizer, ev, token);
    expect((await checkOut(org.organizer, ev, token)).body.data.team).toBe('Leavers');
  });

  it('does not let a checked-in registration be cancelled, before or after checking out', async () => {
    const { ev, people, regs, tokens } = await gate(1);
    await checkIn(org.organizer, ev, tokens[0]!);
    await checkOut(org.organizer, ev, tokens[0]!);
    await sql(ev, '10 minutes', '2 hours'); // cancelling is refused once an event has started; test the other rule
    const res = await post(t, people[0]!, `/api/registrations/${regs[0]}/cancel`);
    expect(res.body.error.code).toBe('ALREADY_CHECKED_IN');
  });
});

describe('checking out by hand', () => {
  it('is for the organizer and admins, needs a reason, and logs it', async () => {
    const { ev, regs, tokens } = await gate(2);
    await checkIn(org.organizer, ev, tokens[0]!);
    await checkIn(org.organizer, ev, tokens[1]!);
    const vol = await sessionFor(t);
    await post(t, org.organizer, `/api/events/${ev}/volunteers`, { email: vol.user.email });
    for (const who of [vol, org.faculty, org.student]) {
      expect(
        (await outByHand(who, ev, { registrationId: regs[0], reason: 'Left at the gate' })).status,
      ).toBe(403);
    }
    for (const bad of [
      { registrationId: regs[0] },
      { registrationId: regs[0], reason: 'x' },
      { registrationId: regs[0], reason: 'fine reason', extra: 1 },
    ]) {
      expect((await outByHand(org.organizer, ev, bad)).status).toBe(400);
    }
    const ok = await outByHand(org.organizer, ev, {
      registrationId: regs[0],
      reason: 'Pass would not scan',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.method).toBe('manual');
    expect((await rowsOf(ev)).find((r) => r.registration_id === regs[0])).toMatchObject({
      check_out_method: 'manual',
      check_out_reason: 'Pass would not scan',
    });
    const logged = await audit('attendance.manual_check_out');
    expect(logged[0].metadata).toMatchObject({
      reason: 'Pass would not scan',
      registrationId: regs[0],
    });
    expect(
      (await outByHand(org.admin, ev, { registrationId: regs[1], reason: 'Admin recorded it' }))
        .status,
    ).toBe(201);
    expect(
      (await outByHand(org.organizer, ev, { registrationId: regs[1], reason: 'Again please' })).body
        .error.code,
    ).toBe('ALREADY_CHECKED_OUT');
  });

  it('needs the person to have been checked in', async () => {
    const { ev, regs } = await gate(1);
    expect(
      (await outByHand(org.organizer, ev, { registrationId: regs[0], reason: 'Never came in' }))
        .body.error.code,
    ).toBe('NOT_CHECKED_IN');
  });
});

describe('what the database guarantees about leaving', () => {
  it('keeps the check-out fields together, in order and explained', async () => {
    const { ev, regs, tokens } = await gate(1);
    await checkIn(org.organizer, ev, tokens[0]!);
    const update = (set: string, ...params: unknown[]) =>
      q(`UPDATE attendance SET ${set} WHERE registration_id = $1`, [regs[0], ...params]);
    const by = org.organizer.user.id;
    await expect(update('checked_out_at = now()')).rejects.toMatchObject({
      constraint: 'attendance_checkout_check',
    });
    await expect(
      update("checked_out_at = now(), checked_out_by = $2, check_out_method = 'manual'", by),
    ).rejects.toMatchObject({ constraint: 'attendance_checkout_check' });
    await expect(
      update(
        "checked_out_at = now(), checked_out_by = $2, check_out_method = 'qr', check_out_reason = 'why'",
        by,
      ),
    ).rejects.toMatchObject({ constraint: 'attendance_checkout_check' });
    await expect(
      update(
        "checked_out_at = now() - interval '1 day', checked_out_by = $2, check_out_method = 'qr'",
        by,
      ),
    ).rejects.toMatchObject({ constraint: 'attendance_checkout_check' });
    await expect(
      update("checked_out_at = now(), checked_out_by = $2, check_out_method = 'teleport'", by),
    ).rejects.toMatchObject({ constraint: 'attendance_checkout_check' });
    await update("checked_out_at = now(), checked_out_by = $2, check_out_method = 'qr'", by);
  });
});

describe('simultaneous check-outs', () => {
  it('records leaving once when one pass is scanned at several exits at the same time', async () => {
    const { ev, tokens } = await gate(1);
    await checkIn(org.organizer, ev, tokens[0]!);
    const vols = await students(t, 3);
    for (const v of vols)
      await post(t, org.organizer, `/api/events/${ev}/volunteers`, { email: v.user.email });
    const scanners = [org.organizer, org.admin, ...vols];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        checkOut(scanners[i % scanners.length]!, ev, tokens[0]!),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status !== 201)
        .every((r) => r.body.error.code === 'ALREADY_CHECKED_OUT'),
    ).toBe(true);
    expect(await audit('attendance.checked_out')).toHaveLength(1);
  });

  it('checks many people in and out at once without mixing anyone up', async () => {
    const { ev, tokens } = await gate(20);
    await Promise.all(tokens.map((tok) => checkIn(org.organizer, ev, tok)));
    const outs = await Promise.all(tokens.map((tok) => checkOut(org.organizer, ev, tok)));
    expect(outs.map((r) => r.status)).toEqual(Array(20).fill(201));
    const rows = await rowsOf(ev);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.checked_out_at)).toBe(true);
  });
});

describe('the organizer’s attendance settings', () => {
  it('defaults to no walk-ins and check-out required, and shows that to scanners and staff', async () => {
    const ev = await createPublishedEvent(t, org);
    const vol = await sessionFor(t);
    await post(t, org.organizer, `/api/events/${ev}/volunteers`, { email: vol.user.email });
    for (const who of [org.organizer, org.admin, vol, org.faculty, org.hod]) {
      const res = await as(t, who).get(`/api/events/${ev}/attendance-settings`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ allowWalkIns: false, requireCheckOut: true });
    }
    for (const who of [org.student, org.otherFaculty]) {
      expect((await as(t, who).get(`/api/events/${ev}/attendance-settings`)).status).toBe(403);
    }
    expect((await request(t.app).get(`/api/events/${ev}/attendance-settings`)).status).toBe(401);
  });

  it('is changed by the organizer or an admin only, one setting at a time, and audited', async () => {
    const ev = await createPublishedEvent(t, org);
    const vol = await sessionFor(t);
    await post(t, org.organizer, `/api/events/${ev}/volunteers`, { email: vol.user.email });
    for (const who of [vol, org.faculty, org.hod, org.student, org.otherOrganizer]) {
      expect((await setSettings(who, ev, { allowWalkIns: true })).status).toBe(403);
    }
    expect((await setSettings(org.organizer, ev, { allowWalkIns: true })).body.data).toEqual({
      allowWalkIns: true,
      requireCheckOut: true,
    });
    expect((await setSettings(org.admin, ev, { requireCheckOut: false })).body.data).toEqual({
      allowWalkIns: true,
      requireCheckOut: false,
    });
    expect((await as(t, vol).get(`/api/events/${ev}/attendance-settings`)).body.data).toEqual({
      allowWalkIns: true,
      requireCheckOut: false,
    });
    const logged = await audit('attendance.settings_changed');
    expect(logged).toHaveLength(2);
    expect(logged[1].metadata).toMatchObject({
      before: { allowWalkIns: true, requireCheckOut: true },
      after: { allowWalkIns: true, requireCheckOut: false },
    });
  });

  it('rejects empty, unknown or wrongly typed changes (400) and ended events (409)', async () => {
    const ev = await createPublishedEvent(t, org);
    for (const bad of [
      {},
      { allowWalkIns: 'yes' },
      { other: true },
      { allowWalkIns: true, extra: 1 },
    ]) {
      expect((await setSettings(org.organizer, ev, bad)).status).toBe(400);
    }
    await as(t, org.organizer).post(`/api/events/${ev}/cancel`, { comment: 'Called off' });
    expect((await setSettings(org.organizer, ev, { allowWalkIns: true })).status).toBe(409);
  });
});

describe('walk-ins (when the organizer allows them)', () => {
  const walkInEvent = async (over: Record<string, unknown> = {}) => {
    const ev = await createPublishedEvent(t, org, over);
    await midEvent(ev);
    return ev;
  };

  it('is refused unless the organizer turned walk-ins on', async () => {
    const ev = await walkInEvent();
    const [guest] = await students(t, 1);
    const res = await walkIn(org.organizer, ev, guest!.user.email);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALK_INS_NOT_ALLOWED');
    expect(await q('SELECT 1 FROM registrations')).toHaveLength(0);
  });

  it('registers and checks the person in at once, using a seat', async () => {
    const ev = await walkInEvent({ capacity: 5 });
    await setSettings(org.organizer, ev, { allowWalkIns: true });
    const [guest] = await students(t, 1);
    const res = await walkIn(org.organizer, ev, guest!.user.email.toUpperCase());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      method: 'walk_in',
      attendee: { id: guest!.user.id },
      counts: { registered: 1, checkedIn: 1, inside: 1 },
    });
    expect(
      (await q('SELECT status FROM registrations WHERE user_id = $1', [guest!.user.id]))[0].status,
    ).toBe('registered');
    expect((await rowsOf(ev))[0]).toMatchObject({
      method: 'walk_in',
      reason: null,
      checked_in_by: org.organizer.user.id,
    });
    expect(await audit('attendance.walk_in')).toHaveLength(1);
    const reg = await audit('registration.created');
    expect(reg[0].metadata).toMatchObject({ walkIn: true });
    expect(
      (await as(t, guest!).get(`/api/events/${ev}/registration-summary`)).body.data.registered,
    ).toBe(1);
  });

  it('can be done by volunteers and admins, not by other people', async () => {
    const ev = await walkInEvent();
    await setSettings(org.organizer, ev, { allowWalkIns: true });
    const vol = await sessionFor(t);
    await post(t, org.organizer, `/api/events/${ev}/volunteers`, { email: vol.user.email });
    const [g1, g2, g3] = await students(t, 3);
    expect((await walkIn(vol, ev, g1!.user.email)).status).toBe(201);
    expect((await walkIn(org.admin, ev, g2!.user.email)).status).toBe(201);
    for (const who of [g3!, org.student, org.faculty, org.otherOrganizer]) {
      expect((await walkIn(who, ev, g3!.user.email)).status).toBe(403);
    }
    expect(
      (
        await request(t.app)
          .post(`/api/events/${ev}/check-ins/walk-in`)
          .send({ email: g3!.user.email })
      ).status,
    ).toBe(401);
  });

  it('does not exceed the capacity, and says the event is full', async () => {
    const ev = await walkInEvent({ capacity: 1 });
    await setSettings(org.organizer, ev, { allowWalkIns: true });
    const [a, b] = await students(t, 2);
    expect((await walkIn(org.organizer, ev, a!.user.email)).status).toBe(201);
    const full = await walkIn(org.organizer, ev, b!.user.email);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('EVENT_FULL');
    expect(await rowsOf(ev)).toHaveLength(1);
  });

  it('refuses someone who is already registered or waiting, with a hint', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 1 });
    const [holder, waiter] = await students(t, 2);
    await register(t, holder!, ev);
    await post(t, waiter!, `/api/events/${ev}/registrations`, { waitlist: true });
    await midEvent(ev);
    await setSettings(org.organizer, ev, { allowWalkIns: true });
    for (const who of [holder!, waiter!]) {
      const res = await walkIn(org.organizer, ev, who.user.email);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_REGISTERED');
    }
    expect(await rowsOf(ev)).toHaveLength(0);
  });

  it('works even after the registration deadline, but not for team events or outside the window', async () => {
    const ev = await walkInEvent();
    await q("UPDATE events SET registration_deadline = now() - interval '2 hours' WHERE id = $1", [
      ev,
    ]);
    await setSettings(org.organizer, ev, { allowWalkIns: true });
    const [a] = await students(t, 1);
    expect((await walkIn(org.organizer, ev, a!.user.email)).status).toBe(201);

    const team = await createPublishedEvent(t, org, teamEvent());
    await midEvent(team);
    await setSettings(org.organizer, team, { allowWalkIns: true });
    const [b] = await students(t, 1);
    expect((await walkIn(org.organizer, team, b!.user.email)).body.error.code).toBe(
      'WALK_IN_NOT_AVAILABLE',
    );

    const later = await createPublishedEvent(t, org);
    await setSettings(org.organizer, later, { allowWalkIns: true });
    const [c] = await students(t, 1);
    expect((await walkIn(org.organizer, later, c!.user.email)).body.error.code).toBe(
      'CHECK_IN_CLOSED',
    );
  });

  it('refuses unknown or deactivated accounts and bad input', async () => {
    const ev = await walkInEvent();
    await setSettings(org.organizer, ev, { allowWalkIns: true });
    expect((await walkIn(org.organizer, ev, 'nobody@college.test')).status).toBe(404);
    const gone = await sessionFor(t);
    await q('UPDATE users SET is_active = false WHERE id = $1', [gone.user.id]);
    expect((await walkIn(org.organizer, ev, gone.user.email)).status).toBe(404);
    expect(
      (await post(t, org.organizer, `/api/events/${ev}/check-ins/walk-in`, { email: 'nope' }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(t, org.organizer, `/api/events/${ev}/check-ins/walk-in`, {
          email: 'a@b.co',
          x: 1,
        })
      ).status,
    ).toBe(400);
    expect(await q('SELECT 1 FROM registrations')).toHaveLength(0);
  });

  it('then leaves like anyone else, but cannot cancel the registration', async () => {
    const ev = await walkInEvent();
    await setSettings(org.organizer, ev, { allowWalkIns: true });
    const [guest] = await students(t, 1);
    const res = await walkIn(org.organizer, ev, guest!.user.email);
    const reg = res.body.data.registrationId as string;
    await sql(ev, '10 minutes', '2 hours');
    expect((await post(t, guest!, `/api/registrations/${reg}/cancel`)).body.error.code).toBe(
      'ALREADY_CHECKED_IN',
    );
    await midEvent(ev);
    expect(
      (await outByHand(org.organizer, ev, { registrationId: reg, reason: 'No pass for walk-ins' }))
        .status,
    ).toBe(201);
  });

  it('gives the last seats to exactly as many walk-ins as there are, however many arrive together', async () => {
    const ev = await walkInEvent({ capacity: 5 });
    await setSettings(org.organizer, ev, { allowWalkIns: true });
    const guests = await students(t, 15);
    const results = await Promise.all(
      guests.map((g, i) => walkIn(i % 2 ? org.admin : org.organizer, ev, g.user.email)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(
      results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'EVENT_FULL'),
    ).toBe(true);
    expect(await rowsOf(ev)).toHaveLength(5);
    expect(
      await q("SELECT 1 FROM registrations WHERE event_id = $1 AND status = 'registered'", [ev]),
    ).toHaveLength(5);
  });

  it('checks a person in once when the same walk-in is entered by several people together', async () => {
    const ev = await walkInEvent();
    await setSettings(org.organizer, ev, { allowWalkIns: true });
    const [guest] = await students(t, 1);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => walkIn(org.organizer, ev, guest!.user.email)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await rowsOf(ev)).toHaveLength(1);
    expect(
      await q('SELECT 1 FROM registrations WHERE user_id = $1', [guest!.user.id]),
    ).toHaveLength(1);
  });
});

describe('live numbers and the attendance report', () => {
  it('counts who is inside, who left and who stayed to the end', async () => {
    const { ev, tokens } = await gate(4);
    const regs = await registrationIds(ev);
    for (const tok of tokens) await checkIn(org.organizer, ev, tok);
    await checkOut(org.organizer, ev, tokens[0]!); // an hour early
    await checkOut(org.organizer, ev, tokens[1]!);
    await leftNearEnd(regs[1]!); // this one left just before the end

    const res = await as(t, org.organizer).get(`/api/events/${ev}/attendance`);
    expect(res.body.summary).toMatchObject({
      registered: 4,
      checkedIn: 4,
      inside: 2,
      checkedOut: 2,
      completed: 1,
      remaining: 0,
      open: true,
      checkOutOpen: true,
      settings: { requireCheckOut: true },
    });
    const byOut = res.body.data.filter((r: { checkedOutAt: string | null }) => r.checkedOutAt);
    expect(byOut.map((r: { leftEarly: boolean }) => r.leftEarly).sort()).toEqual([false, true]);
    expect(
      res.body.data.find((r: { checkedOutAt: string | null }) => !r.checkedOutAt).leftEarly,
    ).toBeNull();

    await setSettings(org.organizer, ev, { requireCheckOut: false });
    const relaxed = await as(t, org.organizer).get(`/api/events/${ev}/attendance`);
    expect(relaxed.body.summary.completed).toBe(4); // when check-out is not required, being checked in is enough
  });

  it('gives other features a report of who attended and whether they stayed', async () => {
    const { ev, people, tokens } = await gate(4);
    const regs = await registrationIds(ev);
    for (const tok of tokens) await checkIn(org.organizer, ev, tok);
    await checkOut(org.organizer, ev, tokens[0]!); // left early
    await checkOut(org.organizer, ev, tokens[1]!);
    await leftNearEnd(regs[1]!); // stayed
    // people[2] is still inside, people[3] too

    const report = await attendanceReport(t.ctx.pool, ev);
    const by = Object.fromEntries(report.map((r) => [r.userId, r]));
    expect(report).toHaveLength(4);
    expect(by[people[0]!.user.id]).toMatchObject({ leftEarly: true, completed: false });
    expect(by[people[1]!.user.id]).toMatchObject({ leftEarly: false, completed: true });
    expect(by[people[2]!.user.id]).toMatchObject({
      leftEarly: null,
      completed: false,
      checkedOutAt: null,
    });

    await setSettings(org.organizer, ev, { requireCheckOut: false });
    expect((await attendanceReport(t.ctx.pool, ev)).every((r) => r.completed)).toBe(true);
    expect(await attendanceReport(t.ctx.pool, '11111111-1111-4111-8111-111111111111')).toEqual([]);
  });
});
