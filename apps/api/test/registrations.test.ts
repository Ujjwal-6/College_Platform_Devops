import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, buildOrg, buildTestApp, resetDb, type Org } from './helpers.js';
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
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

describe('individual registration', () => {
  it('registers a person, takes a seat, audits it and queues a confirmation email', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 3 });
    const [sam] = await students(t, 1);
    const res = await register(t, sam!, ev);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ eventId: ev, status: 'registered', team: null });

    const sum = await as(t, sam!).get(`/api/events/${ev}/registration-summary`);
    expect(sum.body.data).toMatchObject({
      capacity: 3,
      registered: 1,
      seatsLeft: 2,
      open: true,
      full: false,
      mine: { id: res.body.data.id, status: 'registered' },
    });
    expect(await audit('registration.created')).toHaveLength(1);
    const mail = await emails('registration.confirmed');
    expect(mail).toHaveLength(1);
    expect(mail[0].payload.to).toBe(sam!.user.email);
  });

  it('refuses a second registration (409), and the database refuses it too', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    expect((await register(t, sam!, ev)).status).toBe(201);
    const again = await register(t, sam!, ev);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REGISTERED');
    await expect(
      q('INSERT INTO registrations (event_id, user_id) VALUES ($1, $2)', [ev, sam!.user.id]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'registrations_event_user_key' });
  });

  it('is open to any signed-in role, including the organizer of the event', async () => {
    const ev = await createPublishedEvent(t, org);
    for (const who of [org.student, org.faculty, org.hod, org.admin, org.organizer]) {
      expect((await register(t, who, ev)).status).toBe(201);
    }
  });

  it('needs a signed-in user', async () => {
    const ev = await createPublishedEvent(t, org);
    expect((await request(t.app).post(`/api/events/${ev}/registrations`).send({})).status).toBe(
      401,
    );
    expect((await request(t.app).get(`/api/events/${ev}/registration-summary`)).status).toBe(401);
    expect((await request(t.app).get('/api/registrations')).status).toBe(401);
  });

  it('says the event is full with 409 EVENT_FULL', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 2 });
    const [a, b, c] = await students(t, 3);
    expect((await register(t, a!, ev)).status).toBe(201);
    expect((await register(t, b!, ev)).status).toBe(201);
    const res = await register(t, c!, ev);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_FULL');
    const sum = await as(t, c!).get(`/api/events/${ev}/registration-summary`);
    expect(sum.body.data).toMatchObject({ seatsLeft: 0, full: true });
  });

  it('has no limit when the event has no capacity', async () => {
    const ev = await createPublishedEvent(t, org);
    for (const s of await students(t, 5)) expect((await register(t, s, ev)).status).toBe(201);
    const sum = await as(t, org.student).get(`/api/events/${ev}/registration-summary`);
    expect(sum.body.data).toMatchObject({
      capacity: null,
      registered: 5,
      seatsLeft: null,
      full: false,
    });
  });

  it('is closed unless the event is published and before its deadline', async () => {
    const [sam] = await students(t, 1);
    const approved = await (async () => {
      const { createApprovedEvent } = await import('./helpers.js');
      return createApprovedEvent(t, org);
    })();
    const notYet = await register(t, sam!, approved);
    expect(notYet.status).toBe(404); // approved events are not visible to a plain student
    const asOrganizerView = await register(t, org.organizer, approved);
    expect(asOrganizerView.status).toBe(409);
    expect(asOrganizerView.body.error.code).toBe('REGISTRATION_CLOSED');

    const ev = await createPublishedEvent(t, org);
    await q("UPDATE events SET registration_deadline = now() - interval '1 hour' WHERE id = $1", [
      ev,
    ]);
    const late = await register(t, sam!, ev);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('REGISTRATION_CLOSED');
    expect((await as(t, sam!).get(`/api/events/${ev}/registration-summary`)).body.data.open).toBe(
      false,
    );
  });

  it('keeps private drafts invisible (404)', async () => {
    const { createDraft } = await import('./helpers.js');
    const draft = await createDraft(t, org.organizer);
    const [sam] = await students(t, 1);
    expect((await register(t, sam!, draft)).status).toBe(404);
    expect((await as(t, sam!).get(`/api/events/${draft}/registration-summary`)).status).toBe(404);
  });

  it('keeps individual and team events apart (409 WRONG_REGISTRATION_MODE)', async () => {
    const solo = await createPublishedEvent(t, org);
    const teams = await createPublishedEvent(t, org, teamEvent());
    const [sam] = await students(t, 1);
    const a = await register(t, sam!, teams);
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('WRONG_REGISTRATION_MODE');
    const b = await createTeam(t, sam!, solo, 'Lone Wolves');
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('WRONG_REGISTRATION_MODE');
  });

  it('rejects unknown fields, bad ids and an unknown event', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    expect((await post(t, sam!, `/api/events/${ev}/registrations`, { vip: true })).status).toBe(
      400,
    );
    expect((await post(t, sam!, '/api/events/not-a-uuid/registrations')).status).toBe(400);
    expect(
      (await post(t, sam!, '/api/events/11111111-1111-4111-8111-111111111111/registrations'))
        .status,
    ).toBe(404);
  });
});

describe('cancelling a registration', () => {
  it('frees the seat, can be repeated, and allows registering again', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 1 });
    const [a, b] = await students(t, 2);
    const reg = await register(t, a!, ev);
    expect((await register(t, b!, ev)).body.error.code).toBe('EVENT_FULL');

    const cancel = await post(t, a!, `/api/registrations/${reg.body.data.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'self' });
    expect(await audit('registration.cancelled')).toHaveLength(1);

    const repeat = await post(t, a!, `/api/registrations/${reg.body.data.id}/cancel`);
    expect(repeat.status).toBe(200);
    expect(await audit('registration.cancelled')).toHaveLength(1);

    expect((await register(t, b!, ev)).status).toBe(201);
    expect((await register(t, a!, ev)).body.error.code).toBe('EVENT_FULL');
  });

  it('lets the same person register again after cancelling, with a new email', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    const first = await register(t, sam!, ev);
    await post(t, sam!, `/api/registrations/${first.body.data.id}/cancel`);
    const second = await register(t, sam!, ev);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data).toMatchObject({
      status: 'registered',
      cancelledAt: null,
      cancelReason: null,
    });
    expect(await emails('registration.confirmed')).toHaveLength(2);
    expect(await q('SELECT 1 FROM registrations WHERE event_id = $1', [ev])).toHaveLength(1);
  });

  it('is limited to the registrant (404 for anyone else, even an admin)', async () => {
    const ev = await createPublishedEvent(t, org);
    const [a, b] = await students(t, 2);
    const reg = await register(t, a!, ev);
    const path = `/api/registrations/${reg.body.data.id}/cancel`;
    expect((await post(t, b!, path)).status).toBe(404);
    expect((await post(t, org.admin, path)).status).toBe(404);
    expect((await request(t.app).post(path).send({})).status).toBe(401);
    expect(
      (await as(t, a!).get(`/api/events/${ev}/registration-summary`)).body.data.registered,
    ).toBe(1);
  });

  it('is refused once the event has started (409 EVENT_STARTED)', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    const reg = await register(t, sam!, ev);
    await q(
      "UPDATE events SET start_at = now() - interval '2 hours', end_at = now() - interval '1 hour' WHERE id = $1",
      [ev],
    );
    const res = await post(t, sam!, `/api/registrations/${reg.body.data.id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_STARTED');
  });

  it('lists my registrations with the event they belong to', async () => {
    const e1 = await createPublishedEvent(t, org, { title: 'Robotics Meet' });
    const e2 = await createPublishedEvent(t, org, { title: 'Hack Night' });
    const [sam, other] = await students(t, 2);
    await register(t, sam!, e1);
    await register(t, sam!, e2);
    await register(t, other!, e1);
    const res = await as(t, sam!).get('/api/registrations');
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { event: { title: string } }) => r.event.title).sort()).toEqual([
      'Hack Night',
      'Robotics Meet',
    ]);
    expect((await as(t, sam!).get('/api/registrations?foo=1')).status).toBe(400);
  });
});

describe('teams and invitation codes', () => {
  it('creates a team: the leader takes a seat and receives a code once', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent({ capacity: 10 }));
    const [lead] = await students(t, 1);
    const res = await createTeam(t, lead!, ev, 'Code Ninjas');
    expect(res.status).toBe(201);
    expect(res.body.data.invitationCode).toMatch(CODE);
    expect(res.body.data.team).toMatchObject({
      name: 'Code Ninjas',
      size: 1,
      minSize: 2,
      maxSize: 4,
      complete: false,
      leader: { id: lead!.user.id },
      invitation: { active: true },
    });
    expect(res.body.data.registration.team).toMatchObject({ name: 'Code Ninjas', isLeader: true });
    expect(
      (await as(t, lead!).get(`/api/events/${ev}/registration-summary`)).body.data.registered,
    ).toBe(1);
    expect(await audit('team.created')).toHaveLength(1);
  });

  it('never stores or returns the code again: only its hash is kept', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead] = await students(t, 1);
    const res = await createTeam(t, lead!, ev, 'Hash Squad');
    const code: string = res.body.data.invitationCode;
    const teamId: string = res.body.data.team.id;
    const stored = JSON.stringify(await q('SELECT * FROM teams WHERE id = $1', [teamId]));
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(code.replace(/-/g, ''));
    const view = await as(t, lead!).get(`/api/teams/${teamId}`);
    expect(JSON.stringify(view.body)).not.toContain(code);
    expect(JSON.stringify(await q('SELECT payload FROM jobs'))).not.toContain(code);
    expect(JSON.stringify(await q('SELECT metadata FROM audit_log'))).not.toContain(code);
  });

  it('lets members join with the code, however it is typed, until the team is full', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent({ teamSizeMax: 3 }));
    const [lead, m1, m2, m3] = await students(t, 4);
    const created = await createTeam(t, lead!, ev, 'Trio');
    const code: string = created.body.data.invitationCode;

    const j1 = await joinTeam(t, m1!, code.toLowerCase());
    expect(j1.status).toBe(201);
    expect(j1.body.data.team).toMatchObject({ size: 2, complete: true });
    const j2 = await joinTeam(t, m2!, code.replace(/-/g, ' ').toLowerCase());
    expect(j2.status).toBe(201);
    expect(j2.body.data.registration.team.isLeader).toBe(false);
    expect(j2.body.data.team).not.toHaveProperty('invitation');

    const full = await joinTeam(t, m3!, code);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('TEAM_FULL');
    expect(await emails('registration.confirmed')).toHaveLength(3);
  });

  it('gives the same answer for a wrong, malformed, expired and revoked code', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead, a, b, c, d] = await students(t, 5);
    const code: string = (await createTeam(t, lead!, ev, 'Secret Club')).body.data.invitationCode;
    const teamId: string = (await q('SELECT id FROM teams'))[0].id;

    const wrong = await joinTeam(t, a!, '0000-0000-0000-0000');
    const malformed = await joinTeam(t, a!, 'nope');
    await q("UPDATE teams SET invitation_expires_at = now() - interval '1 minute' WHERE id = $1", [
      teamId,
    ]);
    const expired = await joinTeam(t, b!, code);
    await q("UPDATE teams SET invitation_expires_at = now() + interval '1 day' WHERE id = $1", [
      teamId,
    ]);
    expect((await joinTeam(t, c!, code)).status).toBe(201); // valid again: the expiry check is real
    await as(t, lead!).post(`/api/teams/${teamId}/invitation/revoke`);
    const revoked = await joinTeam(t, d!, code);

    for (const res of [wrong, malformed, expired, revoked]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVALID_INVITATION');
      expect(res.body.error.message).toBe('This invitation code is invalid or has expired');
    }
    expect(
      await q('SELECT 1 FROM registrations WHERE user_id = ANY($1)', [
        [a!.user.id, b!.user.id, d!.user.id],
      ]),
    ).toHaveLength(0);
  });

  it('refuses a name that is taken in the same event, ignoring case', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [a, b] = await students(t, 2);
    expect((await createTeam(t, a!, ev, 'Falcons')).status).toBe(201);
    const dup = await createTeam(t, b!, ev, 'falcons');
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TEAM_NAME_TAKEN');
    expect(await q('SELECT 1 FROM registrations WHERE user_id = $1', [b!.user.id])).toHaveLength(0);
  });

  it('keeps a person in one team per event', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [a, b] = await students(t, 2);
    const codeA: string = (await createTeam(t, a!, ev, 'Alpha')).body.data.invitationCode;
    const codeB: string = (await createTeam(t, b!, ev, 'Beta')).body.data.invitationCode;
    for (const [who, code] of [
      [a!, codeB],
      [b!, codeA],
      [a!, codeA],
    ] as const) {
      const res = await joinTeam(t, who, code);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_REGISTERED');
    }
    expect((await createTeam(t, a!, ev, 'Gamma')).body.error.code).toBe('ALREADY_REGISTERED');
  });

  it('counts every team member against the event capacity', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent({ capacity: 3 }));
    const [a, b, c, d, e] = await students(t, 5);
    const code: string = (await createTeam(t, a!, ev, 'Big Team')).body.data.invitationCode;
    expect((await joinTeam(t, b!, code)).status).toBe(201);
    expect((await joinTeam(t, c!, code)).status).toBe(201);
    const full = await joinTeam(t, d!, code);
    expect(full.body.error.code).toBe('EVENT_FULL');
    expect((await createTeam(t, e!, ev, 'Late Team')).body.error.code).toBe('EVENT_FULL');
  });

  it('shows a team only to its members and the event staff', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead, member, outsider] = await students(t, 3);
    const created = await createTeam(t, lead!, ev, 'Visible');
    const teamId: string = created.body.data.team.id;
    await joinTeam(t, member!, created.body.data.invitationCode);

    const asLead = await as(t, lead!).get(`/api/teams/${teamId}`);
    expect(asLead.status).toBe(200);
    expect(asLead.body.data.members.map((m: { name: string }) => m.name)).toHaveLength(2);
    expect(asLead.body.data.invitation).toMatchObject({ active: true });
    const asMember = await as(t, member!).get(`/api/teams/${teamId}`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.data).not.toHaveProperty('invitation');
    for (const staff of [org.organizer, org.faculty, org.hod, org.admin]) {
      expect((await as(t, staff).get(`/api/teams/${teamId}`)).status).toBe(200);
    }
    for (const nobody of [outsider!, org.otherFaculty, org.otherHod]) {
      expect((await as(t, nobody).get(`/api/teams/${teamId}`)).status).toBe(404);
    }
    expect((await request(t.app).get(`/api/teams/${teamId}`)).status).toBe(401);
    expect((await as(t, lead!).get('/api/teams/not-a-uuid')).status).toBe(400);
  });

  it('lets only the leader renew or revoke the code; a new code replaces the old one', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead, member, outsider, joiner, late] = await students(t, 5);
    const created = await createTeam(t, lead!, ev, 'Renewers');
    const teamId: string = created.body.data.team.id;
    const oldCode: string = created.body.data.invitationCode;
    await joinTeam(t, member!, oldCode);

    expect((await as(t, member!).post(`/api/teams/${teamId}/invitation`)).status).toBe(403);
    expect((await as(t, outsider!).post(`/api/teams/${teamId}/invitation`)).status).toBe(404);
    expect((await as(t, org.admin).post(`/api/teams/${teamId}/invitation/revoke`)).status).toBe(
      403,
    );

    const renewed = await as(t, lead!).post(`/api/teams/${teamId}/invitation`);
    expect(renewed.status).toBe(200);
    const newCode: string = renewed.body.data.invitationCode;
    expect(newCode).toMatch(CODE);
    expect(newCode).not.toBe(oldCode);
    expect((await joinTeam(t, joiner!, oldCode)).status).toBe(404);
    expect((await joinTeam(t, joiner!, newCode)).status).toBe(201);

    expect((await as(t, lead!).post(`/api/teams/${teamId}/invitation/revoke`)).status).toBe(200);
    expect((await joinTeam(t, late!, newCode)).status).toBe(404);
    const view = await as(t, lead!).get(`/api/teams/${teamId}`);
    expect(view.body.data.invitation.active).toBe(false);
    expect(await audit('team.invitation_regenerated')).toHaveLength(1);
    expect(await audit('team.invitation_revoked')).toHaveLength(1);
  });

  it('hands leadership to the longest-standing member when the leader leaves, and dissolves an empty team', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent({ capacity: 5 }));
    const [lead, m1, m2] = await students(t, 3);
    const created = await createTeam(t, lead!, ev, 'Succession');
    const teamId: string = created.body.data.team.id;
    const code: string = created.body.data.invitationCode;
    const r1 = await joinTeam(t, m1!, code);
    const r2 = await joinTeam(t, m2!, code);

    const leave = await post(
      t,
      lead!,
      `/api/registrations/${created.body.data.registration.id}/cancel`,
    );
    expect(leave.status).toBe(200);
    const after = await as(t, m1!).get(`/api/teams/${teamId}`);
    expect(after.body.data).toMatchObject({ size: 2, leader: { id: m1!.user.id } });
    expect(after.body.data.invitation).toMatchObject({ active: true }); // the new leader sees the invitation state
    expect(await audit('team.leader_changed')).toHaveLength(1);

    await post(t, m2!, `/api/registrations/${r2.body.data.registration.id}/cancel`);
    expect((await as(t, m1!).get(`/api/teams/${teamId}`)).body.data).toMatchObject({
      size: 1,
      leader: { id: m1!.user.id },
    });
    await post(t, m1!, `/api/registrations/${r1.body.data.registration.id}/cancel`);
    expect(
      (await q('SELECT status, invitation_hash FROM teams WHERE id = $1', [teamId]))[0],
    ).toEqual({
      status: 'dissolved',
      invitation_hash: null,
    });
    expect(await audit('team.dissolved')).toHaveLength(1);
    expect((await joinTeam(t, lead!, code)).status).toBe(404);
    expect(
      (await as(t, lead!).get(`/api/events/${ev}/registration-summary`)).body.data.registered,
    ).toBe(0);
  });

  it('frees a team place when a member leaves, so someone else can join', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent({ teamSizeMax: 2 }));
    const [lead, m1, m2] = await students(t, 3);
    const created = await createTeam(t, lead!, ev, 'Pair');
    const code: string = created.body.data.invitationCode;
    const joined = await joinTeam(t, m1!, code);
    expect((await joinTeam(t, m2!, code)).body.error.code).toBe('TEAM_FULL');
    await post(t, m1!, `/api/registrations/${joined.body.data.registration.id}/cancel`);
    expect((await joinTeam(t, m2!, code)).status).toBe(201);
  });

  it('flags a team below the minimum size but does not remove it', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent({ teamSizeMin: 3, teamSizeMax: 4 }));
    const [lead, m1] = await students(t, 2);
    const created = await createTeam(t, lead!, ev, 'Small');
    await joinTeam(t, m1!, created.body.data.invitationCode);
    const view = await as(t, lead!).get(`/api/teams/${created.body.data.team.id}`);
    expect(view.body.data).toMatchObject({ size: 2, minSize: 3, complete: false });
  });

  it('limits attempts with a code per person (429)', async () => {
    const limited = buildTestApp({ INVITATION_CODE_RATE_LIMIT_MAX: '3' });
    try {
      const [guesser, other] = [await sessionFor(limited), await sessionFor(limited)];
      for (let i = 0; i < 3; i++)
        expect((await joinTeam(limited, guesser, '0000-0000-0000-0000')).status).toBe(404);
      const blocked = await joinTeam(limited, guesser, '0000-0000-0000-0000');
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect((await joinTeam(limited, other, '0000-0000-0000-0000')).status).toBe(404); // another person is not affected
    } finally {
      await limited.close();
    }
  });

  it('limits registration attempts per person (429)', async () => {
    const limited = buildTestApp({ REGISTRATION_RATE_LIMIT_MAX: '2' });
    try {
      const ev = await createPublishedEvent(t, org);
      const sam = await sessionFor(limited);
      expect((await register(limited, sam, ev)).status).toBe(201);
      expect((await register(limited, sam, ev)).status).toBe(409);
      expect((await register(limited, sam, ev)).status).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('who sees the registrants', () => {
  it('shows names and emails to the organizer, department staff and admins only', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead, member] = await students(t, 2);
    const created = await createTeam(t, lead!, ev, 'Listed');
    await joinTeam(t, member!, created.body.data.invitationCode);

    for (const staff of [org.organizer, org.faculty, org.faculty2, org.hod, org.admin]) {
      const res = await as(t, staff).get(`/api/events/${ev}/registrations`);
      expect(res.status).toBe(200);
      expect(res.body.page.total).toBe(2);
      expect(res.body.data[0]).toMatchObject({
        user: { id: lead!.user.id, email: lead!.user.email },
        team: { name: 'Listed', isLeader: true },
      });
    }
    for (const other of [lead!, org.student, org.otherFaculty, org.otherHod, org.otherOrganizer]) {
      expect((await as(t, other).get(`/api/events/${ev}/registrations`)).status).toBe(403);
    }
    expect((await request(t.app).get(`/api/events/${ev}/registrations`)).status).toBe(401);
  });

  it('filters by status and pages through the list', async () => {
    const ev = await createPublishedEvent(t, org);
    const people = await students(t, 5);
    const regs = [];
    for (const p of people) regs.push(await register(t, p, ev));
    await post(t, people[0]!, `/api/registrations/${regs[0]!.body.data.id}/cancel`);

    const api = as(t, org.organizer);
    expect(
      (await api.get(`/api/events/${ev}/registrations?status=registered`)).body.page.total,
    ).toBe(4);
    expect(
      (await api.get(`/api/events/${ev}/registrations?status=cancelled`)).body.data,
    ).toHaveLength(1);
    const p1 = await api.get(`/api/events/${ev}/registrations?limit=2&offset=0`);
    const p2 = await api.get(`/api/events/${ev}/registrations?limit=2&offset=2`);
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.page.total).toBe(5);
    expect(p2.body.data.map((r: { id: string }) => r.id)).not.toEqual(
      p1.body.data.map((r: { id: string }) => r.id),
    );
    for (const bad of ['status=weird', 'limit=0', 'limit=101', 'offset=-1', 'x=1']) {
      expect((await api.get(`/api/events/${ev}/registrations?${bad}`)).status).toBe(400);
    }
  });

  it('shows seat counts to every signed-in person without naming anyone', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 4 });
    const [a, b] = await students(t, 2);
    await register(t, a!, ev);
    const res = await as(t, b!).get(`/api/events/${ev}/registration-summary`);
    expect(res.body.data).toMatchObject({ registered: 1, seatsLeft: 3, mine: null });
    expect(JSON.stringify(res.body)).not.toContain(a!.user.email);
  });
});

describe('following the event lifecycle', () => {
  it('cancels every registration and team, and emails each person, when the event is cancelled', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead, m1, other] = await students(t, 3);
    const created = await createTeam(t, lead!, ev, 'Doomed');
    await joinTeam(t, m1!, created.body.data.invitationCode);
    const solo = await createPublishedEvent(t, org);
    await register(t, other!, solo);

    const res = await as(t, org.organizer).post(`/api/events/${ev}/cancel`, {
      comment: 'Venue lost',
    });
    expect(res.status).toBe(200);

    const rows = await q('SELECT status, cancel_reason FROM registrations WHERE event_id = $1', [
      ev,
    ]);
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r) => r.status === 'cancelled' && r.cancel_reason === 'event_cancelled'),
    ).toBe(true);
    expect((await q('SELECT status FROM teams'))[0].status).toBe('dissolved');
    const mail = await emails('registration.event_cancelled');
    expect(mail.map((m) => m.payload.to).sort()).toEqual([lead!.user.email, m1!.user.email].sort());
    expect((await as(t, other!).get('/api/registrations')).body.data[0].status).toBe('registered'); // other events untouched
    expect(await audit('registration.cancelled')).toHaveLength(2);
    expect((await joinTeam(t, other!, created.body.data.invitationCode)).status).toBe(404);
  });

  it('refuses to unpublish or revise while people are registered, and allows it once they leave', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    const reg = await register(t, sam!, ev);

    for (const action of ['unpublish', 'revise']) {
      const res = await as(t, org.organizer).post(`/api/events/${ev}/${action}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EVENT_HAS_REGISTRATIONS');
    }
    expect((await as(t, org.organizer).get(`/api/events/${ev}`)).body.data.status).toBe(
      'published',
    );

    await post(t, sam!, `/api/registrations/${reg.body.data.id}/cancel`);
    expect((await as(t, org.organizer).post(`/api/events/${ev}/unpublish`)).status).toBe(200);
    // an unpublished (approved) event is hidden from students; its organizer sees that registration is closed
    expect((await register(t, sam!, ev)).status).toBe(404);
    expect((await register(t, org.organizer, ev)).body.error.code).toBe('REGISTRATION_CLOSED');
  });
});

describe('repeating a request (Idempotency-Key)', () => {
  it('creates one registration, one audit row and one email, and replays the first answer', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    const key = 'reg-0001-abcdefgh';
    const first = await register(t, sam!, ev, key);
    const second = await register(t, sam!, ev, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await q('SELECT 1 FROM registrations')).toHaveLength(1);
    expect(await audit('registration.created')).toHaveLength(1);
    expect(await emails('registration.confirmed')).toHaveLength(1);
  });

  it('refuses the same key for a different request (422)', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead] = await students(t, 1);
    const key = 'team-key-12345678';
    expect((await createTeam(t, lead!, ev, 'First Name', key)).status).toBe(201);
    const other = await createTeam(t, lead!, ev, 'Second Name', key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await q('SELECT 1 FROM teams')).toHaveLength(1);
  });

  it('replays a team creation without making a second team or a new code', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead] = await students(t, 1);
    const key = 'team-key-abcdefgh';
    const first = await createTeam(t, lead!, ev, 'Only Once', key);
    const again = await createTeam(t, lead!, ev, 'Only Once', key);
    expect(again.body).toEqual(first.body);
    expect(await q('SELECT 1 FROM teams')).toHaveLength(1);
  });

  it('replays a join', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead, m] = await students(t, 2);
    const code: string = (await createTeam(t, lead!, ev, 'Joinable')).body.data.invitationCode;
    const key = 'join-key-abcdefgh';
    const a = await joinTeam(t, m!, code, key);
    const b = await joinTeam(t, m!, code, key);
    expect(a.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(await q('SELECT 1 FROM registrations WHERE team_id IS NOT NULL')).toHaveLength(2);
  });

  it('does not remember failures, so a corrected retry with the same key works', async () => {
    const ev = await createPublishedEvent(t, org, { capacity: 1 });
    const [a, b] = await students(t, 2);
    const reg = await register(t, a!, ev);
    const key = 'retry-key-abcdefg';
    expect((await register(t, b!, ev, key)).body.error.code).toBe('EVENT_FULL');
    await post(t, a!, `/api/registrations/${reg.body.data.id}/cancel`);
    expect((await register(t, b!, ev, key)).status).toBe(201);
  });

  it('keeps keys separate per person', async () => {
    const ev = await createPublishedEvent(t, org);
    const [a, b] = await students(t, 2);
    const key = 'shared-key-abcdefg';
    expect((await register(t, a!, ev, key)).status).toBe(201);
    expect((await register(t, b!, ev, key)).status).toBe(201);
    expect(await q('SELECT 1 FROM registrations')).toHaveLength(2);
  });

  it('forgets a key after a day', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    const key = 'old-key-abcdefghij';
    await register(t, sam!, ev, key);
    await q("UPDATE idempotency_keys SET created_at = now() - interval '25 hours'");
    const again = await register(t, sam!, ev, key); // treated as a new request, which is now a duplicate
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REGISTERED');
  });

  it.each(['short', 'has spaces in it!!', 'x'.repeat(65)])(
    'rejects the malformed key %j (400)',
    async (key) => {
      const ev = await createPublishedEvent(t, org);
      const [sam] = await students(t, 1);
      expect((await register(t, sam!, ev, key)).status).toBe(400);
      expect(await q('SELECT 1 FROM registrations')).toHaveLength(0);
    },
  );
});
