import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { registerEventHook } from '../src/modules/events/hooks.js';
import { registerNotificationHandlers } from '../src/modules/notifications/notify.js';
import { JobWorker } from '../src/platform/jobs/worker.js';
import {
  approveFully,
  as,
  buildOrg,
  buildTestApp,
  createDraft,
  createTestUser,
  eventBody,
  futureRange,
  loginAs,
  resetDb,
  type Org,
} from './helpers.js';

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  t.mailer.sent.length = 0;
  org = await buildOrg(t);
});
afterAll(() => t.close());

const submit = (who: { accessToken: string }, id: string) =>
  as(t, who).post(`/api/events/${id}/submit`);
const approvers = () => ({ faculty: org.faculty, hod: org.hod, admin: org.admin });

async function approvedEvent(overrides: Record<string, unknown> = {}) {
  const id = await createDraft(t, org.organizer, overrides);
  expect((await submit(org.organizer, id)).status).toBe(200);
  await approveFully(t, id, approvers());
  return id;
}
async function publishedEvent(overrides: Record<string, unknown> = {}) {
  const id = await approvedEvent(overrides);
  expect((await as(t, org.organizer).post(`/api/events/${id}/publish`)).status).toBe(200);
  return id;
}
const rows = async (sql: string, params: unknown[] = []) =>
  (await t.ctx.pool.query(sql, params)).rows;

describe('creating events', () => {
  it('creates a draft owned by the caller in their own department', async () => {
    const res = await as(t, org.organizer).post(
      '/api/events',
      eventBody({ speakers: [{ name: 'Dr. Rao', designation: 'Professor', organization: 'IIT' }] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'draft',
      departmentId: org.cse,
      approvalLevel: null,
      registrationMode: 'individual',
      capacity: null,
      speakers: [{ name: 'Dr. Rao', designation: 'Professor', organization: 'IIT' }],
      actions: { canEdit: true, canSubmit: true, canApprove: false, canPublish: false },
      registrationEligible: false,
    });
    const audit = await rows(
      "SELECT actor_id, target_id FROM audit_log WHERE action = 'event.created'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].target_id).toBe(res.body.data.id);
    expect(await rows('SELECT action, to_status FROM event_history')).toEqual([
      { action: 'create', to_status: 'draft' },
    ]);
  });

  it.each([['faculty'], ['hod']] as const)('lets %s create events', async (role) => {
    expect((await as(t, org[role]).post('/api/events', eventBody())).status).toBe(201);
  });

  it('requires admins to name a department and accepts any existing one', async () => {
    expect((await as(t, org.admin).post('/api/events', eventBody())).status).toBe(400);
    const ok = await as(t, org.admin).post('/api/events', eventBody({ departmentId: org.ece }));
    expect(ok.status).toBe(201);
    expect(ok.body.data.departmentId).toBe(org.ece);
    const missing = await as(t, org.admin).post(
      '/api/events',
      eventBody({ departmentId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(missing.status).toBe(400);
  });

  it('refuses plain students (403)', async () => {
    expect((await as(t, org.student).post('/api/events', eventBody())).status).toBe(403);
  });

  it('refuses a non-admin creating for another department (403) or without a department (409)', async () => {
    expect(
      (await as(t, org.organizer).post('/api/events', eventBody({ departmentId: org.ece }))).status,
    ).toBe(403);
    const orphan = await loginAs(
      t,
      await createTestUser(t.ctx, { roles: ['organizer'], departmentId: null }),
    );
    const res = await as(t, orphan).post('/api/events', eventBody());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_DEPARTMENT');
  });

  it.each([
    ['unknown field', { organizerId: 'x' }],
    [
      'end before start',
      (() => {
        const r = futureRange();
        return { startAt: r.endAt, endAt: r.startAt };
      })(),
    ],
    ['date without UTC offset', { startAt: '2030-01-01T10:00:00' }],
    ['short title', { title: 'ab' }],
    ['zero attendance', { expectedAttendance: 0 }],
    ['team event without sizes', { registrationMode: 'team' }],
    ['team max below min', { registrationMode: 'team', teamSizeMin: 4, teamSizeMax: 2 }],
    ['individual event with team sizes', { teamSizeMin: 2, teamSizeMax: 4 }],
    ['deadline after start', { registrationDeadline: futureRange(61).startAt }],
    ['too many speakers', { speakers: Array.from({ length: 21 }, (_, i) => ({ name: `S${i}` })) }],
  ])('rejects %s with 400', async (_name, extra) => {
    const res = await as(t, org.organizer).post(
      '/api/events',
      eventBody(extra as Record<string, unknown>),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a team event with sizes and a registration deadline', async () => {
    const res = await as(t, org.organizer).post(
      '/api/events',
      eventBody({
        registrationMode: 'team',
        teamSizeMin: 2,
        teamSizeMax: 4,
        capacity: 60,
        registrationDeadline: futureRange(55).startAt,
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      registrationMode: 'team',
      teamSizeMin: 2,
      teamSizeMax: 4,
      capacity: 60,
    });
  });

  it('stores instants in UTC regardless of the offset sent', async () => {
    const res = await as(t, org.organizer).post(
      '/api/events',
      eventBody({ startAt: '2031-03-01T10:00:00+05:30', endAt: '2031-03-01T12:00:00+05:30' }),
    );
    expect(res.body.data.startAt).toBe('2031-03-01T04:30:00.000Z');
  });
});

describe('who can see an event', () => {
  it('keeps drafts private to the owner and admins', async () => {
    const id = await createDraft(t, org.organizer);
    for (const who of [org.organizer, org.admin])
      expect((await as(t, who).get(`/api/events/${id}`)).status).toBe(200);
    for (const who of [org.faculty, org.hod, org.student, org.otherOrganizer, org.otherHod]) {
      expect((await as(t, who).get(`/api/events/${id}`)).status, 'draft hidden').toBe(404);
    }
  });

  it('shows submitted events to their own department staff only', async () => {
    const id = await createDraft(t, org.organizer);
    await submit(org.organizer, id);
    for (const who of [org.faculty, org.hod, org.admin, org.organizer])
      expect((await as(t, who).get(`/api/events/${id}`)).status).toBe(200);
    for (const who of [org.otherFaculty, org.otherHod, org.student, org.otherOrganizer]) {
      expect(
        (await as(t, who).get(`/api/events/${id}`)).status,
        'cross-department / unrelated',
      ).toBe(404);
    }
  });

  it('shows published events to everyone but hides the internal workflow from outsiders', async () => {
    const id = await publishedEvent();
    const outsider = await as(t, org.student).get(`/api/events/${id}`);
    expect(outsider.status).toBe(200);
    expect(outsider.body.data.workflow).toBeNull();
    expect(outsider.body.data.calendar).toBeNull();
    expect(outsider.body.data.actions).toMatchObject({
      canEdit: false,
      canPublish: false,
      canApprove: false,
    });
    const staff = await as(t, org.faculty).get(`/api/events/${id}`);
    expect(staff.body.data.workflow.approvals).toHaveLength(3);
    expect(staff.body.data.workflow.history.map((h: { action: string }) => h.action)).toContain(
      'publish',
    );
  });

  it('requires authentication', async () => {
    expect((await request(t.app).get('/api/events')).status).toBe(401);
    expect(
      (await request(t.app).get('/api/events/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(401);
  });

  it('answers 404 for unknown ids and 400 for malformed ones', async () => {
    expect(
      (await as(t, org.admin).get('/api/events/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
    expect((await as(t, org.admin).get('/api/events/nope')).status).toBe(400);
  });
});

describe('listing events', () => {
  it('published scope shows only published events to any user', async () => {
    await createDraft(t, org.organizer, { title: 'Private draft' });
    const id = await publishedEvent({ title: 'Public fest' });
    const res = await as(t, org.student).get('/api/events');
    expect(res.status).toBe(200);
    expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([id]);
    expect(res.body.page.total).toBe(1);
  });

  it("mine scope lists only the caller's events, filterable by status", async () => {
    const a = await createDraft(t, org.organizer);
    await createDraft(t, org.otherOrganizer);
    const res = await as(t, org.organizer).get('/api/events?scope=mine');
    expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([a]);
    expect(
      (await as(t, org.organizer).get('/api/events?scope=mine&status=published')).body.data,
    ).toHaveLength(0);
  });

  it('department scope: staff see their department without drafts, admins see everything, others are refused', async () => {
    await createDraft(t, org.organizer);
    const live = await createDraft(t, org.organizer, { title: 'Submitted one' });
    await submit(org.organizer, live);
    const ecEvent = await createDraft(t, org.otherOrganizer);
    await submit(org.otherOrganizer, ecEvent);

    const staff = await as(t, org.faculty).get('/api/events?scope=department');
    expect(staff.body.data.map((e: { id: string }) => e.id)).toEqual([live]);
    expect((await as(t, org.admin).get('/api/events?scope=department')).body.page.total).toBe(3);
    expect((await as(t, org.student).get('/api/events?scope=department')).status).toBe(403);
    expect((await as(t, org.organizer).get('/api/events?scope=department')).status).toBe(403);
  });

  it('approvals scope shows each approver only what waits for them', async () => {
    const id = await createDraft(t, org.organizer);
    await submit(org.organizer, id);
    const ecId = await createDraft(t, org.otherOrganizer);
    await submit(org.otherOrganizer, ecId);
    const ids = async (who: { accessToken: string }) =>
      (await as(t, who).get('/api/events?scope=approvals')).body.data.map(
        (e: { id: string }) => e.id,
      );

    expect(await ids(org.faculty)).toEqual([id]);
    expect(await ids(org.otherFaculty)).toEqual([ecId]);
    expect(await ids(org.hod)).toEqual([]); // not their level yet
    expect(await ids(org.admin)).toEqual([]);
    expect((await as(t, org.student).get('/api/events?scope=approvals')).status).toBe(403);

    await as(t, org.faculty).post(`/api/events/${id}/approve`, { level: 'faculty' });
    expect(await ids(org.faculty)).toEqual([]);
    expect(await ids(org.faculty2)).toEqual([]);
    expect(await ids(org.hod)).toEqual([id]);
  });

  it("never lists a user's own event in their approval queue", async () => {
    const hodEvent = await createDraft(t, org.hod, { title: 'HOD event' });
    await submit(org.hod, hodEvent);
    await as(t, org.faculty).post(`/api/events/${hodEvent}/approve`, { level: 'faculty' });
    expect((await as(t, org.hod).get('/api/events?scope=approvals')).body.data).toEqual([]);
    expect(
      (await as(t, org.hod2).get('/api/events?scope=approvals')).body.data.map(
        (e: { id: string }) => e.id,
      ),
    ).toEqual([hodEvent]);
  });

  it('rejects bad query parameters', async () => {
    expect((await as(t, org.admin).get('/api/events?scope=everything')).status).toBe(400);
    expect((await as(t, org.admin).get('/api/events?limit=1000')).status).toBe(400);
    expect((await as(t, org.admin).get('/api/events?sort=title')).status).toBe(400);
  });
});

describe('editing events', () => {
  it('lets the owner edit a draft freely, including speakers, and records the changed fields', async () => {
    const id = await createDraft(t, org.organizer);
    const res = await as(t, org.organizer).patch(`/api/events/${id}`, {
      title: 'New title',
      capacity: 80,
      speakers: [{ name: 'A' }, { name: 'B' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ title: 'New title', capacity: 80 });
    expect(res.body.data.speakers.map((s: { name: string }) => s.name)).toEqual(['A', 'B']);
    const audit = await rows("SELECT metadata FROM audit_log WHERE action = 'event.updated'");
    expect(audit[0].metadata.fields).toEqual(['title', 'capacity', 'speakers']);
  });

  it('validates the merged result (e.g. moving the end before the existing start)', async () => {
    const id = await createDraft(t, org.organizer);
    const res = await as(t, org.organizer).patch(`/api/events/${id}`, {
      endAt: futureRange(10).endAt,
    });
    expect(res.status).toBe(400);
    expect((await as(t, org.organizer).patch(`/api/events/${id}`, {})).status).toBe(400);
    expect(
      (await as(t, org.organizer).patch(`/api/events/${id}`, { status: 'approved' })).status,
    ).toBe(400);
    expect(
      (await as(t, org.organizer).patch(`/api/events/${id}`, { organizerId: org.faculty.user.id }))
        .status,
    ).toBe(400);
  });

  it('refuses edits by anyone else: 403 when they can see it, 404 when they cannot (AC-2.2)', async () => {
    const draft = await createDraft(t, org.organizer);
    expect(
      (await as(t, org.otherOrganizer).patch(`/api/events/${draft}`, { title: 'Hijack attempt' }))
        .status,
    ).toBe(404);
    expect(
      (await as(t, org.admin).patch(`/api/events/${draft}`, { title: 'Admin edit' })).status,
    ).toBe(403);
    const pub = await publishedEvent();
    expect(
      (await as(t, org.otherOrganizer).patch(`/api/events/${pub}`, { title: 'Hijack attempt' }))
        .status,
    ).toBe(403);
    expect((await as(t, org.hod).patch(`/api/events/${pub}`, { title: 'HOD edit' })).status).toBe(
      403,
    );
  });

  it('locks events that are waiting for approval until they are withdrawn', async () => {
    const id = await createDraft(t, org.organizer);
    await submit(org.organizer, id);
    const locked = await as(t, org.organizer).patch(`/api/events/${id}`, {
      title: 'Sneaky change',
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('EVENT_LOCKED');
    expect((await as(t, org.organizer).post(`/api/events/${id}/withdraw`)).body.data.status).toBe(
      'draft',
    );
    expect(
      (await as(t, org.organizer).patch(`/api/events/${id}`, { title: 'Allowed now' })).status,
    ).toBe(200);
  });

  it('allows small corrections after approval but requires "revise" for material changes', async () => {
    const id = await approvedEvent();
    const small = await as(t, org.organizer).patch(`/api/events/${id}`, {
      title: 'Typo fixed',
      description: 'Better text',
      speakers: [{ name: 'New Speaker' }],
    });
    expect(small.status).toBe(200);
    expect(small.body.data.status).toBe('approved');

    const sameValue = await as(t, org.organizer).patch(`/api/events/${id}`, {
      expectedAttendance: 120,
    });
    expect(sameValue.status).toBe(200); // unchanged material value is not a change

    const material = await as(t, org.organizer).patch(`/api/events/${id}`, {
      capacity: 500,
      ...futureRange(70),
    });
    expect(material.status).toBe(409);
    expect(material.body.error.code).toBe('MATERIAL_CHANGE_REQUIRES_REVISION');
    expect(material.body.error.details.fields.sort()).toEqual(['capacity', 'endAt', 'startAt']);
  });

  it('keeps approved status unchanged after a rejected material edit and after a published small edit', async () => {
    const id = await publishedEvent();
    await as(t, org.organizer).patch(`/api/events/${id}`, { expectedAttendance: 999 });
    expect(
      (await as(t, org.organizer).patch(`/api/events/${id}`, { description: 'Updated agenda' }))
        .body.data.status,
    ).toBe('published');
    expect((await as(t, org.organizer).get(`/api/events/${id}`)).body.data.expectedAttendance).toBe(
      120,
    );
  });

  it('does not allow editing closed or cancelled events', async () => {
    const id = await createDraft(t, org.organizer);
    await as(t, org.organizer).post(`/api/events/${id}/cancel`, { comment: 'No longer needed' });
    const res = await as(t, org.organizer).patch(`/api/events/${id}`, { title: 'Zombie edit' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_LOCKED');
  });
});

describe('lifecycle', () => {
  it('moves draft → pending → approved → published → closed and keeps a timeline', async () => {
    const id = await publishedEvent();
    await t.ctx.pool.query(
      "UPDATE events SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour', registration_deadline = NULL WHERE id = $1",
      [id],
    );
    const closed = await as(t, org.organizer).post(`/api/events/${id}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe('closed');
    const actions = (
      await as(t, org.organizer).get(`/api/events/${id}`)
    ).body.data.workflow.history.map((h: { action: string }) => h.action);
    expect(actions).toEqual([
      'create',
      'submit',
      'approve',
      'approve',
      'approve',
      'publish',
      'close',
    ]);
  });

  it('refuses invalid transitions with 409 and leaves the state alone', async () => {
    const draft = await createDraft(t, org.organizer);
    for (const action of ['publish', 'unpublish', 'close', 'withdraw', 'revise']) {
      const res = await as(t, org.organizer).post(`/api/events/${draft}/${action}`);
      expect(res.status, action).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
    }
    expect((await as(t, org.organizer).get(`/api/events/${draft}`)).body.data.status).toBe('draft');
    expect((await submit(org.organizer, draft)).status).toBe(200);
    expect((await submit(org.organizer, draft)).body.error.code).toBe('INVALID_TRANSITION'); // double submit
  });

  it('cannot bypass approval: an unapproved event cannot be published', async () => {
    const id = await createDraft(t, org.organizer);
    await submit(org.organizer, id);
    expect((await as(t, org.organizer).post(`/api/events/${id}/publish`)).status).toBe(409);
    expect((await as(t, org.admin).post(`/api/events/${id}/publish`)).status).toBe(409);
  });

  it('enforces the same rule in the database', async () => {
    const id = await createDraft(t, org.organizer);
    await expect(
      t.ctx.pool.query(
        "UPDATE events SET status = 'published', published_at = now() WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      t.ctx.pool.query("UPDATE events SET status = 'pending_approval' WHERE id = $1", [id]),
    ).rejects.toThrow();
  });

  it('only the owner submits, withdraws and revises; owner or admin publishes, unpublishes and closes', async () => {
    const draft = await createDraft(t, org.organizer);
    expect((await submit(org.admin, draft)).status).toBe(403);
    await submit(org.organizer, draft);
    expect((await as(t, org.admin).post(`/api/events/${draft}/withdraw`)).status).toBe(403);
    await approveFully(t, draft, approvers());
    expect((await as(t, org.admin).post(`/api/events/${draft}/revise`)).status).toBe(403);
    expect((await as(t, org.faculty).post(`/api/events/${draft}/publish`)).status).toBe(403);
    expect((await as(t, org.admin).post(`/api/events/${draft}/publish`)).status).toBe(200);
    expect((await as(t, org.hod).post(`/api/events/${draft}/unpublish`)).status).toBe(403);
    expect((await as(t, org.admin).post(`/api/events/${draft}/unpublish`)).status).toBe(200);
  });

  it('refuses to submit or publish an event whose start is in the past', async () => {
    const id = await createDraft(t, org.organizer, {
      startAt: '2020-01-01T10:00:00+05:30',
      endAt: '2020-01-01T12:00:00+05:30',
    });
    const res = await submit(org.organizer, id);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('startAt');
    const ok = await approvedEvent();
    await t.ctx.pool.query(
      "UPDATE events SET start_at = now() - interval '2 hours', end_at = now() - interval '1 hour' WHERE id = $1",
      [ok],
    );
    expect((await as(t, org.organizer).post(`/api/events/${ok}/publish`)).status).toBe(400);
  });

  it('revise returns an approved or published event to draft, unpublishes it and requires re-approval', async () => {
    const id = await publishedEvent();
    const revised = await as(t, org.organizer).post(`/api/events/${id}/revise`);
    expect(revised.status).toBe(200);
    expect(revised.body.data).toMatchObject({
      status: 'draft',
      approvalLevel: null,
      publishedAt: null,
      approvedAt: null,
      registrationEligible: false,
    });
    expect((await as(t, org.organizer).patch(`/api/events/${id}`, { capacity: 500 })).status).toBe(
      200,
    );
    expect((await as(t, org.organizer).post(`/api/events/${id}/publish`)).status).toBe(409);
    await submit(org.organizer, id);
    await approveFully(t, id, approvers()); // a fresh round: previous approvals do not count
    expect((await as(t, org.organizer).post(`/api/events/${id}/publish`)).status).toBe(200);
  });

  it('unpublish takes an event back to approved', async () => {
    const id = await publishedEvent();
    const res = await as(t, org.organizer).post(`/api/events/${id}/unpublish`);
    expect(res.body.data).toMatchObject({
      status: 'approved',
      publishedAt: null,
      registrationEligible: false,
    });
  });

  it('cancels from any live state, requires a reason, and cannot be undone', async () => {
    const draft = await createDraft(t, org.organizer);
    expect((await as(t, org.organizer).post(`/api/events/${draft}/cancel`, {})).status).toBe(400);
    const res = await as(t, org.organizer).post(`/api/events/${draft}/cancel`, {
      comment: 'Speaker unavailable',
    });
    expect(res.body.data).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Speaker unavailable',
    });
    expect(
      (await as(t, org.organizer).post(`/api/events/${draft}/cancel`, { comment: 'again' })).status,
    ).toBe(409);
    expect((await submit(org.organizer, draft)).status).toBe(409);

    for (const prepare of [
      async () => {
        const id = await createDraft(t, org.organizer);
        await submit(org.organizer, id);
        return id;
      },
      approvedEvent,
      publishedEvent,
    ]) {
      const id = await prepare();
      expect(
        (await as(t, org.admin).post(`/api/events/${id}/cancel`, { comment: 'Policy' })).body.data
          .status,
      ).toBe('cancelled');
    }
    expect(
      (
        await as(t, org.faculty).post(`/api/events/${await publishedEvent()}/cancel`, {
          comment: 'x',
        })
      ).status,
    ).toBe(403);
  });

  it('emails the organizer when an administrator cancels, but not when they cancel themselves', async () => {
    const mine = await createDraft(t, org.organizer);
    await as(t, org.organizer).post(`/api/events/${mine}/cancel`, { comment: 'My choice' });
    expect(await rows("SELECT 1 FROM jobs WHERE job_key LIKE 'event.cancelled:%'")).toHaveLength(0);
    const other = await createDraft(t, org.organizer, { title: 'Another' });
    await as(t, org.admin).post(`/api/events/${other}/cancel`, { comment: 'Venue closed' });
    expect(
      await rows('SELECT 1 FROM jobs WHERE job_key = $1', [`event.cancelled:${other}`]),
    ).toHaveLength(1);
  });

  it('close works only after the event ended, and closing twice is a harmless no-op', async () => {
    const id = await publishedEvent();
    const early = await as(t, org.organizer).post(`/api/events/${id}/close`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('EVENT_NOT_ENDED');

    await t.ctx.pool.query(
      "UPDATE events SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour', registration_deadline = NULL WHERE id = $1",
      [id],
    );
    expect((await as(t, org.organizer).post(`/api/events/${id}/close`)).status).toBe(200);
    expect((await as(t, org.organizer).post(`/api/events/${id}/close`)).status).toBe(200);
    expect(await rows("SELECT 1 FROM audit_log WHERE action = 'event.closed'")).toHaveLength(1);
    expect(await rows("SELECT 1 FROM event_history WHERE action = 'close'")).toHaveLength(1);
    expect((await as(t, org.student).post(`/api/events/${id}/close`)).status).toBe(403);
  });

  it('is eligible for registration only while published and before the deadline', async () => {
    const id = await publishedEvent({ registrationDeadline: futureRange(50).startAt });
    expect((await as(t, org.student).get(`/api/events/${id}`)).body.data.registrationEligible).toBe(
      true,
    );
    await t.ctx.pool.query(
      "UPDATE events SET registration_deadline = now() - interval '1 minute' WHERE id = $1",
      [id],
    );
    expect((await as(t, org.student).get(`/api/events/${id}`)).body.data.registrationEligible).toBe(
      false,
    );
    await t.ctx.pool.query('UPDATE events SET registration_deadline = NULL WHERE id = $1', [id]);
    expect((await as(t, org.student).get(`/api/events/${id}`)).body.data.registrationEligible).toBe(
      true,
    );
    await as(t, org.organizer).post(`/api/events/${id}/unpublish`);
    expect((await as(t, org.student).get(`/api/events/${id}`)).status).toBe(404); // no longer public
    expect(
      (await as(t, org.organizer).get(`/api/events/${id}`)).body.data.registrationEligible,
    ).toBe(false);
  });

  it('writes exactly one audit record per lifecycle action', async () => {
    const id = await publishedEvent();
    await as(t, org.organizer).post(`/api/events/${id}/unpublish`);
    await as(t, org.organizer).post(`/api/events/${id}/revise`);
    await as(t, org.organizer).post(`/api/events/${id}/cancel`, { comment: 'Done' });
    const counts = Object.fromEntries(
      (
        await rows(
          "SELECT action, count(*)::int AS n FROM audit_log WHERE action LIKE 'event.%' GROUP BY action",
        )
      ).map((r) => [r.action, r.n]),
    );
    expect(counts).toEqual({
      'event.created': 1,
      'event.submitted': 1,
      'event.approval_granted': 3,
      'event.published': 1,
      'event.unpublished': 1,
      'event.revised': 1,
      'event.cancelled': 1,
    });
  });
});

describe('integration hooks', () => {
  it('runs inside the transaction with the new state and the previous status', async () => {
    const seen: { action: string; from: string; to: string; actor: string }[] = [];
    const off = registerEventHook(
      async (_tx, tr) =>
        void seen.push({
          action: tr.action,
          from: tr.previousStatus,
          to: tr.event.status,
          actor: tr.actorId,
        }),
    );
    try {
      const id = await createDraft(t, org.organizer);
      await submit(org.organizer, id);
      await as(t, org.organizer).post(`/api/events/${id}/withdraw`);
    } finally {
      off();
    }
    expect(seen).toEqual([
      { action: 'submit', from: 'draft', to: 'pending_approval', actor: org.organizer.user.id },
      { action: 'withdraw', from: 'pending_approval', to: 'draft', actor: org.organizer.user.id },
    ]);
  });

  it('can veto a transition: everything rolls back', async () => {
    const id = await approvedEvent();
    const off = registerEventHook(async (_tx, tr) => {
      if (tr.action === 'publish')
        throw Object.assign(new Error('has registrations'), { status: 409 });
    });
    try {
      expect((await as(t, org.organizer).post(`/api/events/${id}/publish`)).status).toBe(500);
    } finally {
      off();
    }
    expect((await as(t, org.organizer).get(`/api/events/${id}`)).body.data.status).toBe('approved');
    expect(await rows("SELECT 1 FROM audit_log WHERE action = 'event.published'")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM event_history WHERE action = 'publish'")).toHaveLength(0);
    expect((await as(t, org.organizer).post(`/api/events/${id}/publish`)).status).toBe(200); // works again without the hook
  });
});

describe('notifications', () => {
  it('delivers approval requests to the right people and decision updates to the organizer', async () => {
    const id = await createDraft(t, org.organizer, { title: 'Hack Night' });
    await submit(org.organizer, id);
    const worker = new JobWorker({
      pool: t.ctx.pool,
      logger: t.ctx.logger,
      lockSeconds: 60,
      backoffBaseSeconds: 1,
      pollIntervalMs: 100,
      backoffSeconds: () => 0,
    });
    registerNotificationHandlers(worker, t.mailer);
    await worker.drain();

    const recipients = t.mailer.sent.map((m) => m.to).sort();
    const cseFaculty = (
      await rows(
        "SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'faculty' AND u.department_id = $1",
        [org.cse],
      )
    )
      .map((r) => r.email)
      .sort();
    expect(recipients).toEqual(cseFaculty); // CSE faculty only: not ECE faculty, not the organizer
    expect(t.mailer.sent[0]!.subject).toBe('Approval needed: Hack Night');

    t.mailer.sent.length = 0;
    await as(t, org.faculty).post(`/api/events/${id}/approve`, { level: 'faculty' });
    await worker.drain();
    const toOrganizer = t.mailer.sent.filter((m) => m.subject.startsWith('Event approval update'));
    expect(toOrganizer).toHaveLength(1);
    expect(
      t.mailer.sent
        .filter((m) => m.subject.startsWith('Approval needed'))
        .map((m) => m.to)
        .sort(),
    ).toEqual(
      (
        await rows(
          "SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'hod' AND u.department_id = $1",
          [org.cse],
        )
      )
        .map((r) => r.email)
        .sort(),
    );
  });

  it('queues each notification once even if the same step is processed again', async () => {
    const id = await createDraft(t, org.organizer);
    await submit(org.organizer, id);
    const keys = (await rows("SELECT job_key FROM jobs WHERE type = 'email.send'")).map(
      (r) => r.job_key as string,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.startsWith(`event.approval_requested:${id}:1:faculty:`))).toBe(true);
  });
});
