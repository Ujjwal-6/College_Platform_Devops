import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { registerNotificationHandlers } from '../src/modules/notifications/notify.js';
import { JobWorker } from '../src/platform/jobs/worker.js';
import {
  approveFully,
  as,
  buildOrg,
  buildTestApp,
  createDraft,
  createTestDepartment,
  createTestUser,
  loginAs,
  resetDb,
  type LoggedIn,
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

const approve = (who: LoggedIn, id: string, level: string, comment?: string) =>
  as(t, who).post(`/api/events/${id}/approve`, { level, ...(comment ? { comment } : {}) });
const reject = (who: LoggedIn, id: string, level: string, comment?: string) =>
  as(t, who).post(`/api/events/${id}/reject`, {
    level,
    ...(comment === undefined ? {} : { comment }),
  });
const submitted = async (
  who: LoggedIn = org.organizer,
  overrides: Record<string, unknown> = {},
) => {
  const id = await createDraft(t, who, overrides);
  const res = await as(t, who).post(`/api/events/${id}/submit`);
  if (res.status !== 200)
    throw new Error(`submit failed: ${res.status} ${JSON.stringify(res.body)}`);
  return id;
};
const state = async (id: string) =>
  (
    await t.ctx.pool.query(
      'SELECT status, approval_level, submission_round FROM events WHERE id = $1',
      [id],
    )
  ).rows[0] as { status: string; approval_level: string | null; submission_round: number };
const decisions = async (id: string) =>
  (
    await t.ctx.pool.query(
      'SELECT round, level, decision, approver_id, comment FROM event_approvals WHERE event_id = $1 ORDER BY decided_at, id',
      [id],
    )
  ).rows;

describe('the full workflow', () => {
  it('goes Faculty → HOD → Admin and records every decision', async () => {
    const id = await submitted();
    expect(await state(id)).toMatchObject({
      status: 'pending_approval',
      approval_level: 'faculty',
      submission_round: 1,
    });

    const f = await approve(org.faculty, id, 'faculty', 'Looks good');
    expect(f.status).toBe(200);
    expect(f.body.data).toMatchObject({ status: 'pending_approval', approvalLevel: 'hod' });
    expect(await state(id)).toMatchObject({ approval_level: 'hod' });

    const h = await approve(org.hod, id, 'hod');
    expect(h.body.data).toMatchObject({ status: 'pending_approval', approvalLevel: 'admin' });

    const a = await approve(org.admin, id, 'admin', 'Final OK');
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ status: 'approved', approvalLevel: null });
    expect(a.body.data.approvedAt).toEqual(expect.any(String));

    expect(await decisions(id)).toEqual([
      {
        round: 1,
        level: 'faculty',
        decision: 'approved',
        approver_id: org.faculty.user.id,
        comment: 'Looks good',
      },
      { round: 1, level: 'hod', decision: 'approved', approver_id: org.hod.user.id, comment: null },
      {
        round: 1,
        level: 'admin',
        decision: 'approved',
        approver_id: org.admin.user.id,
        comment: 'Final OK',
      },
    ]);
    const detail = (await as(t, org.organizer).get(`/api/events/${id}`)).body.data;
    expect(
      detail.workflow.approvals.map((x: { approverName: string; level: string }) => x.level),
    ).toEqual(['faculty', 'hod', 'admin']);
    expect(detail.workflow.approvals[0].approverName).toEqual(expect.any(String));
    expect(detail.workflow.approvals[0].decidedAt).toEqual(expect.any(String));
  });

  it('audits each decision exactly once and marks the final one', async () => {
    const id = await submitted();
    await approveFully(t, id, { faculty: org.faculty, hod: org.hod, admin: org.admin });
    const { rows } = await t.ctx.pool.query(
      "SELECT actor_id, metadata FROM audit_log WHERE action = 'event.approval_granted' ORDER BY id",
    );
    expect(rows.map((r) => r.metadata.level)).toEqual(['faculty', 'hod', 'admin']);
    expect(rows.map((r) => r.metadata.final === true)).toEqual([false, false, true]);
    expect(rows.map((r) => r.actor_id)).toEqual([
      org.faculty.user.id,
      org.hod.user.id,
      org.admin.user.id,
    ]);
  });

  it('shows the action buttons only to the person whose turn it is', async () => {
    const id = await submitted();
    const can = async (who: LoggedIn) =>
      (await as(t, who).get(`/api/events/${id}`)).body.data.actions.canApprove;
    expect(await can(org.faculty)).toBe(true);
    expect(await can(org.hod)).toBe(false);
    expect(await can(org.admin)).toBe(false);
    expect(await can(org.organizer)).toBe(false);
    await approve(org.faculty, id, 'faculty');
    expect(await can(org.faculty)).toBe(false);
    expect(await can(org.faculty2)).toBe(false);
    expect(await can(org.hod)).toBe(true);
  });
});

describe('who may decide, and when', () => {
  it('requires authentication', async () => {
    const id = await submitted();
    const request = (await import('supertest')).default;
    expect(
      (await request(t.app).post(`/api/events/${id}/approve`).send({ level: 'faculty' })).status,
    ).toBe(401);
  });

  it('rejects out-of-order and wrong-role decisions without changing anything', async () => {
    const id = await submitted();
    // HOD and admin cannot jump ahead: the screen they used is stale (409) or they lack the role (403)
    expect((await approve(org.hod, id, 'hod')).status).toBe(409);
    expect((await approve(org.admin, id, 'admin')).status).toBe(409);
    expect((await approve(org.hod, id, 'faculty')).status).toBe(403);
    expect((await approve(org.admin, id, 'faculty')).status).toBe(403); // admin cannot stand in for faculty
    expect((await reject(org.admin, id, 'faculty', 'No')).status).toBe(403);
    expect(await state(id)).toMatchObject({
      status: 'pending_approval',
      approval_level: 'faculty',
    });
    expect(await decisions(id)).toEqual([]);

    await approve(org.faculty, id, 'faculty');
    expect((await approve(org.faculty2, id, 'hod')).status).toBe(403); // faculty cannot do the HOD level
    expect((await approve(org.admin, id, 'hod')).status).toBe(403);
    expect((await approve(org.admin, id, 'admin')).status).toBe(409);
  });

  it('keeps students and plain organizers out of approvals', async () => {
    const id = await submitted();
    expect([403, 404]).toContain((await approve(org.student, id, 'faculty')).status);
    expect([403, 404]).toContain((await approve(org.otherOrganizer, id, 'faculty')).status);
    expect(await decisions(id)).toEqual([]);
  });

  it('never lets another department decide (cross-department)', async () => {
    const id = await submitted();
    expect((await approve(org.otherFaculty, id, 'faculty')).status).toBe(404); // cannot even see it
    await approve(org.faculty, id, 'faculty');
    expect((await approve(org.otherHod, id, 'hod')).status).toBe(404);
    expect(await state(id)).toMatchObject({ approval_level: 'hod' });

    // and the reverse: CSE staff cannot decide an ECE event
    const ecId = await submitted(org.otherOrganizer);
    expect((await approve(org.faculty, ecId, 'faculty')).status).toBe(404);
    expect((await approve(org.hod, ecId, 'faculty')).status).toBe(404);
    expect((await approve(org.otherFaculty, ecId, 'faculty')).status).toBe(200);
  });

  it('admins can see and decide events of every department at the admin level', async () => {
    const ecId = await submitted(org.otherOrganizer);
    await approve(org.otherFaculty, ecId, 'faculty');
    await approve(org.otherHod, ecId, 'hod');
    expect((await approve(org.admin, ecId, 'admin')).body.data.status).toBe('approved');
  });

  it('rejects decisions on events that are not waiting for approval', async () => {
    const draft = await createDraft(t, org.organizer);
    expect((await approve(org.admin, draft, 'faculty')).status).toBe(409);
    const done = await submitted();
    await approveFully(t, done, { faculty: org.faculty, hod: org.hod, admin: org.admin });
    const again = await approve(org.admin2, done, 'admin');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('validates the request body', async () => {
    const id = await submitted();
    expect((await as(t, org.faculty).post(`/api/events/${id}/approve`, {})).status).toBe(400);
    expect(
      (await as(t, org.faculty).post(`/api/events/${id}/approve`, { level: 'ceo' })).status,
    ).toBe(400);
    expect(
      (
        await as(t, org.faculty).post(`/api/events/${id}/approve`, {
          level: 'faculty',
          approver: 'x',
        })
      ).status,
    ).toBe(400);
    expect((await reject(org.faculty, id, 'faculty')).status).toBe(400); // comment required
    expect((await reject(org.faculty, id, 'faculty', '   ')).status).toBe(400);
  });

  it('applies role changes immediately: a former faculty member can no longer approve', async () => {
    const id = await submitted();
    await t.ctx.pool.query("UPDATE user_roles SET role = 'student' WHERE user_id = $1", [
      org.faculty.user.id,
    ]);
    // having lost the faculty role they also lose sight of the department's pending events
    expect((await approve(org.faculty, id, 'faculty')).status).toBe(404);
    expect((await approve(org.faculty2, id, 'faculty')).status).toBe(200);
  });

  it('refuses deactivated approvers (401)', async () => {
    const id = await submitted();
    await t.ctx.pool.query('UPDATE users SET is_active = false WHERE id = $1', [
      org.faculty.user.id,
    ]);
    expect((await approve(org.faculty, id, 'faculty')).status).toBe(401);
  });
});

describe('creator cannot approve their own event', () => {
  it('blocks a faculty member from approving their own event, but colleagues can', async () => {
    const id = await submitted(org.faculty);
    const self = await approve(org.faculty, id, 'faculty');
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
    expect((await as(t, org.faculty).get('/api/events?scope=approvals')).body.data).toEqual([]);
    expect((await approve(org.faculty2, id, 'faculty')).status).toBe(200);
  });

  it('blocks a HOD from approving their own event at the HOD level', async () => {
    const id = await submitted(org.hod);
    await approve(org.faculty, id, 'faculty');
    const self = await approve(org.hod, id, 'hod');
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
    expect((await approve(org.hod2, id, 'hod')).status).toBe(200);
  });

  it('blocks an admin from giving final approval to their own event', async () => {
    const id = await submitted(org.admin, { departmentId: org.cse });
    await approve(org.faculty, id, 'faculty');
    await approve(org.hod, id, 'hod');
    expect((await approve(org.admin, id, 'admin')).body.error.code).toBe('SELF_APPROVAL');
    expect((await approve(org.admin2, id, 'admin')).body.data.status).toBe('approved');
  });

  it('refuses to submit when nobody else could approve a level', async () => {
    // ECE has exactly one HOD. If that HOD creates the event, the HOD level can never be satisfied.
    const draft = await createDraft(t, org.otherHod);
    const res = await as(t, org.otherHod).post(`/api/events/${draft}/submit`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'NO_APPROVER_AVAILABLE',
      details: { levels: ['hod'] },
    });
    expect((await state(draft)).status).toBe('draft');
  });

  it('refuses to submit when a level has nobody at all', async () => {
    const lonely = await createTestDepartment(t.ctx, 'Lonely Dept');
    const owner = await loginAs(
      t,
      await createTestUser(t.ctx, { roles: ['organizer'], departmentId: lonely }),
    );
    const draft = await createDraft(t, owner);
    const res = await as(t, owner).post(`/api/events/${draft}/submit`);
    expect(res.status).toBe(409);
    expect(res.body.error.details.levels).toEqual(['faculty', 'hod']);
  });
});

describe('the same person cannot approve two levels', () => {
  async function dualRoleDepartment() {
    const dept = await createTestDepartment(t.ctx, 'Dual Dept');
    const owner = await loginAs(
      t,
      await createTestUser(t.ctx, { roles: ['organizer'], departmentId: dept }),
    );
    const both = await loginAs(
      t,
      await createTestUser(t.ctx, { roles: ['faculty', 'hod'], departmentId: dept }),
    );
    return { dept, owner, both };
  }

  it('refuses submission when one person would have to cover two levels', async () => {
    const { owner } = await dualRoleDepartment();
    const draft = await createDraft(t, owner);
    const res = await as(t, owner).post(`/api/events/${draft}/submit`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_APPROVER_AVAILABLE');
  });

  it('stops a faculty+HOD user from deciding both levels of one submission', async () => {
    const { dept, owner, both } = await dualRoleDepartment();
    const plainFaculty = await loginAs(
      t,
      await createTestUser(t.ctx, { roles: ['faculty'], departmentId: dept }),
    );
    const id = await createDraft(t, owner);
    expect((await as(t, owner).post(`/api/events/${id}/submit`)).status).toBe(200);

    expect((await approve(both, id, 'faculty')).status).toBe(200);
    const second = await approve(both, id, 'hod');
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_DECIDED');
    expect(await state(id)).toMatchObject({ approval_level: 'hod' });
    expect(plainFaculty).toBeDefined();
  });

  it('is also enforced by the database (unique decision per person per round)', async () => {
    const id = await submitted();
    await approve(org.faculty, id, 'faculty');
    await expect(
      t.ctx.pool.query(
        "INSERT INTO event_approvals (event_id, round, level, decision, approver_id) VALUES ($1, 1, 'hod', 'approved', $2)",
        [id, org.faculty.user.id],
      ),
    ).rejects.toThrow(/event_approvals_person_once/);
    await expect(
      t.ctx.pool.query(
        "INSERT INTO event_approvals (event_id, round, level, decision, approver_id) VALUES ($1, 1, 'faculty', 'approved', $2)",
        [id, org.hod.user.id],
      ),
    ).rejects.toThrow(/event_approvals_level_once/);
    await expect(
      t.ctx.pool.query(
        "INSERT INTO event_approvals (event_id, round, level, decision, approver_id) VALUES ($1, 1, 'admin', 'rejected', $2)",
        [id, org.admin.user.id],
      ),
    ).rejects.toThrow(/event_approvals_reject_comment_check/);
  });
});

describe('duplicate and concurrent decisions', () => {
  it('rejects a repeated approval (double click) and one from a colleague on the same level', async () => {
    const id = await submitted();
    expect((await approve(org.faculty, id, 'faculty')).status).toBe(200);
    const again = await approve(org.faculty, id, 'faculty');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('STALE_DECISION');
    expect((await approve(org.faculty2, id, 'faculty')).body.error.code).toBe('STALE_DECISION');
    expect(await decisions(id)).toHaveLength(1);
  });

  it('with two faculty approving at the same moment exactly one decision is recorded', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await submitted(org.organizer, { title: `Race ${round}` });
      const results = await Promise.all([
        approve(org.faculty, id, 'faculty'),
        approve(org.faculty2, id, 'faculty'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await decisions(id)).toHaveLength(1);
      expect(await state(id)).toMatchObject({ approval_level: 'hod' });
    }
  });

  it('with the same user double-submitting, exactly one succeeds', async () => {
    const id = await submitted();
    const results = await Promise.all([
      approve(org.faculty, id, 'faculty'),
      approve(org.faculty, id, 'faculty'),
      approve(org.faculty, id, 'faculty'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await decisions(id)).toHaveLength(1);
  });

  it('an approval and a rejection racing leave one consistent outcome', async () => {
    const id = await submitted();
    const results = await Promise.all([
      approve(org.faculty, id, 'faculty'),
      reject(org.faculty2, id, 'faculty', 'Not now'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = await decisions(id);
    expect(rows).toHaveLength(1);
    expect(await state(id)).toMatchObject(
      rows[0]!.decision === 'approved'
        ? { status: 'pending_approval', approval_level: 'hod' }
        : { status: 'draft', approval_level: null },
    );
  });

  it('two admins racing on the final level produce one approval', async () => {
    const id = await submitted();
    await approve(org.faculty, id, 'faculty');
    await approve(org.hod, id, 'hod');
    const results = await Promise.all([
      approve(org.admin, id, 'admin'),
      approve(org.admin2, id, 'admin'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await decisions(id)).toHaveLength(3);
    expect((await state(id)).status).toBe('approved');
    expect(
      await t.ctx.pool.query(
        "SELECT 1 FROM audit_log WHERE action = 'event.approval_granted' AND metadata->>'final' = 'true'",
      ),
    ).toHaveProperty('rowCount', 1);
  });

  it('a decision racing a withdrawal cannot approve a withdrawn event', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await submitted(org.organizer, { title: `Withdraw race ${i}` });
      const [a, w] = await Promise.all([
        approve(org.faculty, id, 'faculty'),
        as(t, org.organizer).post(`/api/events/${id}/withdraw`),
      ]);
      const s = await state(id);
      if (w.status === 200 && a.status === 200) {
        // approval committed first, withdrawal second: back to draft either way
        expect(s.status).toBe('draft');
      } else {
        // the loser saw a draft (404 for staff who may not view drafts) or a non-pending event (409)
        expect([a.status, w.status].some((code) => code === 404 || code === 409)).toBe(true);
      }
      expect(['draft', 'pending_approval']).toContain(s.status);
    }
  });
});

describe('rejection and resubmission', () => {
  it('returns the event to draft with the comment, notifies the organizer and keeps the history', async () => {
    const id = await submitted();
    await approve(org.faculty, id, 'faculty');
    const res = await reject(org.hod, id, 'hod', 'Clashes with lab exams');
    expect(res.status).toBe(200);
    // the event is a private draft again, so the rejecting HOD only gets the outcome back
    expect(res.body.data).toEqual({ id, status: 'draft', approvalLevel: null });
    expect((await as(t, org.hod).get(`/api/events/${id}`)).status).toBe(404);
    const owner = (await as(t, org.organizer).get(`/api/events/${id}`)).body.data;
    expect(owner.lastRejection).toMatchObject({
      level: 'hod',
      comment: 'Clashes with lab exams',
      by: org.hod.user.id,
    });
    expect(owner.actions).toMatchObject({ canEdit: true, canSubmit: true });
    expect(await decisions(id)).toMatchObject([
      { decision: 'approved', level: 'faculty' },
      { decision: 'rejected', level: 'hod', comment: 'Clashes with lab exams' },
    ]);
    expect(
      await t.ctx.pool.query("SELECT 1 FROM audit_log WHERE action = 'event.approval_rejected'"),
    ).toHaveProperty('rowCount', 1);

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
    const mail = t.mailer.sent.find((m) => m.subject.startsWith('Event rejected'));
    expect(mail?.to).toBe(org.organizer.user.email);
    expect(mail?.text).toContain('Clashes with lab exams');
  });

  it('allows editing and resubmitting; the new round starts at Faculty and old approvals do not count', async () => {
    const id = await submitted();
    await approve(org.faculty, id, 'faculty');
    await reject(org.hod, id, 'hod', 'Please shorten the event');
    expect(
      (await as(t, org.organizer).patch(`/api/events/${id}`, { description: 'Shortened' })).status,
    ).toBe(200);
    const again = await as(t, org.organizer).post(`/api/events/${id}/submit`);
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({
      status: 'pending_approval',
      approvalLevel: 'faculty',
      submissionRound: 2,
      lastRejection: null,
    });

    // the same faculty member may approve again in the new round, and the HOD cannot skip ahead
    expect((await approve(org.hod, id, 'hod')).status).toBe(409);
    expect((await approve(org.faculty, id, 'faculty')).status).toBe(200);
    expect((await approve(org.hod, id, 'hod')).status).toBe(200);
    expect((await approve(org.admin, id, 'admin')).body.data.status).toBe('approved');
    expect((await decisions(id)).filter((d) => d.round === 2)).toHaveLength(3);
  });

  it('lets a person who rejected in round 1 decide again in round 2', async () => {
    const id = await submitted();
    await reject(org.faculty, id, 'faculty', 'Missing budget');
    await as(t, org.organizer).post(`/api/events/${id}/submit`);
    expect((await approve(org.faculty, id, 'faculty')).status).toBe(200);
  });

  it('rejection works at the faculty and admin levels too', async () => {
    const first = await submitted();
    expect((await reject(org.faculty, first, 'faculty', 'No')).body.data.status).toBe('draft');
    const second = await submitted(org.organizer, { title: 'Second event' });
    await approve(org.faculty, second, 'faculty');
    await approve(org.hod, second, 'hod');
    const res = await reject(org.admin, second, 'admin', 'Budget too high');
    expect(res.body.data).toMatchObject({ status: 'draft' });
    expect(
      (await as(t, org.organizer).get(`/api/events/${second}`)).body.data.lastRejection.level,
    ).toBe('admin');
  });

  it('withdrawing and resubmitting also starts a fresh round', async () => {
    const id = await submitted();
    await approve(org.faculty, id, 'faculty');
    await as(t, org.organizer).post(`/api/events/${id}/withdraw`);
    expect((await approve(org.hod, id, 'hod')).status).toBe(404); // a draft again: private to the organizer
    await as(t, org.organizer).post(`/api/events/${id}/submit`);
    expect(await state(id)).toMatchObject({ approval_level: 'faculty', submission_round: 2 });
    expect((await approve(org.faculty, id, 'faculty')).status).toBe(200);
  });

  it('records calendar warnings with the submission for approvers to see', async () => {
    const { startAt } = (await import('./helpers.js')).futureRange(40);
    const day = (await import('./helpers.js')).istDate(startAt);
    const admin = as(t, org.admin);
    expect(
      (
        await admin.post('/api/calendar/entries', {
          type: 'major_fest',
          title: 'Annual Fest',
          startDate: day,
          endDate: day,
        })
      ).status,
    ).toBe(201);
    const id = await submitted(org.organizer, (await import('./helpers.js')).futureRange(40));
    const detail = (await as(t, org.faculty).get(`/api/events/${id}`)).body.data;
    expect(detail.calendarWarnings).toMatchObject([{ title: 'Annual Fest', type: 'major_fest' }]);
  });
});
