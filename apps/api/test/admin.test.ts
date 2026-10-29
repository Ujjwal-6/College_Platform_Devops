import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { as, buildOrg, buildTestApp, createHall, resetDb, type Org } from './helpers.js';

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

async function insertJob(
  status: string,
  over: { type?: string; payload?: object; attempts?: number; error?: string | null } = {},
): Promise<string> {
  const { rows } = await t.ctx.pool.query(
    `INSERT INTO jobs (type, payload, status, attempts, max_attempts, last_error)
     VALUES ($1, $2, $3, $4, 5, $5) RETURNING id`,
    [
      over.type ?? 'email.send',
      JSON.stringify(over.payload ?? {}),
      status,
      over.attempts ?? 0,
      over.error ?? null,
    ],
  );
  return rows[0].id as string;
}

describe('access control', () => {
  const endpoints: [string, string][] = [
    ['get', '/api/admin/audit-log'],
    ['get', '/api/admin/audit-log/actions'],
    ['get', '/api/admin/jobs'],
    ['post', '/api/admin/jobs/11111111-1111-4111-8111-111111111111/retry'],
  ];

  it.each(endpoints)('refuses %s %s without a token (401)', async (method, path) => {
    const res = await (request(t.app) as unknown as Record<string, (p: string) => request.Test>)[
      method
    ]!(path);
    expect(res.status).toBe(401);
  });

  it.each(endpoints)('refuses %s %s to every non-admin role (403)', async (method, path) => {
    for (const who of [org.organizer, org.faculty, org.hod, org.student]) {
      const api = as(t, who) as unknown as Record<string, (p: string) => request.Test>;
      expect((await api[method]!(path)).status).toBe(403);
    }
  });
});

describe('audit log search', () => {
  it('returns newest first with the actor, and the total', async () => {
    const hall = await createHall(t, org.admin, { name: 'Search Hall' });
    const res = await as(t, org.admin).get('/api/admin/audit-log?action=hall.created');
    expect(res.status).toBe(200);
    expect(res.body.page).toEqual({ total: 1, limit: 50, offset: 0 });
    expect(res.body.data[0]).toMatchObject({
      action: 'hall.created',
      targetType: 'hall',
      targetId: hall,
      actor: { id: org.admin.user.id, email: org.admin.user.email },
    });

    const all = await as(t, org.admin).get('/api/admin/audit-log');
    const times = all.body.data.map((r: { createdAt: string }) => Date.parse(r.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('filters by actor, action, target and time range', async () => {
    const hall = await createHall(t, org.admin, { name: 'Filter Hall' });
    const api = as(t, org.admin);

    const byActor = await api.get(`/api/admin/audit-log?actorId=${org.admin.user.id}`);
    expect(byActor.body.data.length).toBeGreaterThan(0);
    expect(
      byActor.body.data.every((r: { actor: { id: string } }) => r.actor.id === org.admin.user.id),
    ).toBe(true);

    const byTarget = await api.get(`/api/admin/audit-log?targetType=hall&targetId=${hall}`);
    expect(byTarget.body.data.map((r: { action: string }) => r.action)).toEqual(['hall.created']);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await api.get(`/api/admin/audit-log?from=${future}`)).body.page.total).toBe(0);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect((await api.get(`/api/admin/audit-log?to=${past}`)).body.page.total).toBe(0);
    expect(
      (await api.get(`/api/admin/audit-log?from=${past}&to=${future}&action=hall.created`)).body
        .page.total,
    ).toBe(1);
  });

  it('pages through the results', async () => {
    const api = as(t, org.admin);
    const first = await api.get('/api/admin/audit-log?limit=2&offset=0');
    const second = await api.get('/api/admin/audit-log?limit=2&offset=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.total).toBeGreaterThan(2);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(second.body.data.map((r: { id: string }) => r.id)).not.toEqual(
      first.body.data.map((r: { id: string }) => r.id),
    );
  });

  it('lists the known action names', async () => {
    const res = await as(t, org.admin).get('/api/admin/audit-log/actions');
    expect(res.status).toBe(200);
    expect(res.body.data).toContain('booking.requested');
    expect(res.body.data).toContain('job.retried');
  });

  it.each([
    ['unknown parameter', 'foo=1'],
    ['unknown action', 'action=nope'],
    ['bad actor id', 'actorId=abc'],
    ['date without offset', 'from=2030-01-01T00:00:00'],
    ['from after to', 'from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z'],
    ['limit too large', 'limit=101'],
    ['negative offset', 'offset=-1'],
  ])('rejects %s with 400', async (_name, query) => {
    const res = await as(t, org.admin).get(`/api/admin/audit-log?${query}`);
    expect(res.status).toBe(400);
  });

  it('treats search text as data, not SQL', async () => {
    const res = await as(t, org.admin).get(
      `/api/admin/audit-log?targetId=${encodeURIComponent("x' OR '1'='1")}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.page.total).toBe(0);
  });
});

describe('background jobs', () => {
  it('lists jobs with counts per status and filters by status and type', async () => {
    await insertJob('failed', { error: 'SMTP down', attempts: 5 });
    await insertJob('failed', { type: 'report.generate' });
    await insertJob('queued');
    await insertJob('succeeded');
    const api = as(t, org.admin);

    const all = await api.get('/api/admin/jobs');
    expect(all.status).toBe(200);
    expect(all.body.counts).toEqual({ queued: 1, running: 0, succeeded: 1, failed: 2 });
    expect(all.body.page.total).toBe(4);

    const failed = await api.get('/api/admin/jobs?status=failed');
    expect(failed.body.data).toHaveLength(2);
    expect(failed.body.counts.failed).toBe(2);
    const smtp = failed.body.data.find((j: { lastError: string }) => j.lastError === 'SMTP down');
    expect(smtp).toMatchObject({
      type: 'email.send',
      status: 'failed',
      attempts: 5,
      maxAttempts: 5,
    });

    const byType = await api.get('/api/admin/jobs?status=failed&type=report.generate');
    expect(byType.body.data).toHaveLength(1);
  });

  it('never exposes a job payload', async () => {
    await insertJob('failed', {
      payload: { to: 'private.person@college.test', body: 'secret text' },
    });
    const res = await as(t, org.admin).get('/api/admin/jobs');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('private.person');
    expect(text).not.toContain('secret text');
    expect(res.body.data[0]).not.toHaveProperty('payload');
  });

  it.each([
    ['unknown status', 'status=weird'],
    ['unknown parameter', 'foo=1'],
    ['limit zero', 'limit=0'],
  ])('rejects %s with 400', async (_name, query) => {
    expect((await as(t, org.admin).get(`/api/admin/jobs?${query}`)).status).toBe(400);
  });

  it('retries a failed job: back to queued with fresh attempts, and audits it', async () => {
    const id = await insertJob('failed', { attempts: 5, error: 'SMTP down' });
    const res = await as(t, org.admin).post(`/api/admin/jobs/${id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id, status: 'queued' });

    const { rows } = await t.ctx.pool.query(
      'SELECT status, attempts, run_at <= now() AS due, locked_until FROM jobs WHERE id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ status: 'queued', attempts: 0, due: true, locked_until: null });

    const audit = await t.ctx.pool.query(
      "SELECT actor_id, target_id, metadata FROM audit_log WHERE action = 'job.retried'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_id: org.admin.user.id,
      target_id: id,
      metadata: { type: 'email.send' },
    });
  });

  it.each(['queued', 'running', 'succeeded'])('refuses to retry a %s job (409)', async (status) => {
    const id = await insertJob(status);
    const res = await as(t, org.admin).post(`/api/admin/jobs/${id}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('JOB_NOT_FAILED');
    const { rows } = await t.ctx.pool.query('SELECT status FROM jobs WHERE id = $1', [id]);
    expect(rows[0].status).toBe(status);
    expect(
      (await t.ctx.pool.query("SELECT 1 FROM audit_log WHERE action = 'job.retried'")).rows,
    ).toHaveLength(0);
  });

  it('answers 404 for an unknown job and 400 for a malformed id', async () => {
    const api = as(t, org.admin);
    expect(
      (await api.post('/api/admin/jobs/11111111-1111-4111-8111-111111111111/retry')).status,
    ).toBe(404);
    expect((await api.post('/api/admin/jobs/not-a-uuid/retry')).status).toBe(400);
  });

  it('requeues once when two admins retry the same job together', async () => {
    const id = await insertJob('failed', { attempts: 5 });
    const results = await Promise.all([
      as(t, org.admin).post(`/api/admin/jobs/${id}/retry`),
      as(t, org.admin2).post(`/api/admin/jobs/${id}/retry`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await t.ctx.pool.query("SELECT 1 FROM audit_log WHERE action = 'job.retried'")).rows,
    ).toHaveLength(1);
  });
});
