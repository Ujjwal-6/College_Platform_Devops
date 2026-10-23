import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearer,
  buildTestApp,
  createTestDepartment,
  createTestUser,
  loginAs,
  resetDb,
  type LoggedIn,
} from './helpers.js';

const t = buildTestApp();
let admin: LoggedIn;
beforeEach(async () => {
  await resetDb(t.ctx);
  admin = await loginAs(t, await createTestUser(t.ctx, { roles: ['admin'] }));
});
afterAll(() => t.close());

const api = () => ({
  create: (body: object) =>
    request(t.app).post('/api/users').set(bearer(admin.accessToken)).send(body),
});
const valid = {
  email: 'new.student@college.test',
  name: 'New Student',
  password: 'a-long-enough-passphrase',
  roles: ['student'],
};

describe('creating users', () => {
  it('creates a user, hides the password, audits it and queues a welcome email', async () => {
    const res = await api().create(valid);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: valid.email, roles: ['student'], isActive: true });
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);

    const audit = await t.ctx.pool.query(
      "SELECT actor_id, target_id FROM audit_log WHERE action = 'user.created'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].target_id).toBe(res.body.data.id);

    const jobs = await t.ctx.pool.query("SELECT type, job_key FROM jobs WHERE type = 'email.send'");
    expect(jobs.rows).toEqual([
      { type: 'email.send', job_key: `account.created:${res.body.data.id}` },
    ]);
  });

  it('lets the new user sign in', async () => {
    await api().create(valid);
    const res = await request(t.app)
      .post('/api/auth/login')
      .send({ email: valid.email, password: valid.password });
    expect(res.status).toBe(200);
  });

  it('rejects a duplicate email (case-insensitive) with 409 and leaves no partial data', async () => {
    await api().create(valid);
    const dup = await api().create({ ...valid, email: 'NEW.STUDENT@college.test' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    const { rows } = await t.ctx.pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.created'",
    );
    expect(rows[0].n).toBe(1);
  });

  it.each([
    ['unknown field', { ...valid, isAdmin: true }],
    ['empty roles', { ...valid, roles: [] }],
    ['invalid role', { ...valid, roles: ['superuser'] }],
    ['duplicate roles', { ...valid, roles: ['student', 'student'] }],
    ['short password', { ...valid, password: 'short' }],
    ['common password', { ...valid, password: 'password12345' }],
    ['password containing the email name', { ...valid, password: 'new.student-2024-pass' }],
    ['bad email', { ...valid, email: 'nope' }],
    ['HOD without department', { ...valid, roles: ['hod'] }],
    ['faculty without department', { ...valid, roles: ['faculty'] }],
    [
      'unknown department',
      { ...valid, roles: ['faculty'], departmentId: '00000000-0000-4000-8000-000000000000' },
    ],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await api().create(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a HOD with a department', async () => {
    const dept = await createTestDepartment(t.ctx);
    const res = await api().create({ ...valid, roles: ['hod'], departmentId: dept });
    expect(res.status).toBe(201);
    expect(res.body.data.departmentId).toBe(dept);
  });
});

describe('listing users', () => {
  it('paginates and filters', async () => {
    for (let i = 0; i < 5; i++) await createTestUser(t.ctx, { roles: ['student'] });
    const page = await request(t.app)
      .get('/api/users?limit=2&offset=2')
      .set(bearer(admin.accessToken));
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.page).toEqual({ limit: 2, offset: 2, total: 6 });
    const admins = await request(t.app).get('/api/users?role=admin').set(bearer(admin.accessToken));
    expect(admins.body.page.total).toBe(1);
  });

  it('rejects unreasonable page sizes and unknown query parameters', async () => {
    expect(
      (await request(t.app).get('/api/users?limit=1000').set(bearer(admin.accessToken))).status,
    ).toBe(400);
    expect(
      (await request(t.app).get('/api/users?sort=password').set(bearer(admin.accessToken))).status,
    ).toBe(400);
  });
});

describe('changing roles', () => {
  it('replaces roles and records before/after in the audit log', async () => {
    const dept = await createTestDepartment(t.ctx);
    const u = await createTestUser(t.ctx, { roles: ['student'], departmentId: dept });
    const res = await request(t.app)
      .put(`/api/users/${u.id}/roles`)
      .set(bearer(admin.accessToken))
      .send({ roles: ['organizer', 'faculty'] });
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual(['faculty', 'organizer']);
    const { rows } = await t.ctx.pool.query(
      "SELECT metadata FROM audit_log WHERE action = 'user.roles_changed'",
    );
    expect(rows[0].metadata).toEqual({ from: ['student'], to: ['organizer', 'faculty'] });
  });

  it('refuses to give faculty/HOD roles to a user without a department', async () => {
    const u = await createTestUser(t.ctx, { roles: ['student'] });
    const res = await request(t.app)
      .put(`/api/users/${u.id}/roles`)
      .set(bearer(admin.accessToken))
      .send({ roles: ['hod'] });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown user and 400 for a malformed id', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      (
        await request(t.app)
          .put(`/api/users/${missing}/roles`)
          .set(bearer(admin.accessToken))
          .send({ roles: ['student'] })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(t.app)
          .put('/api/users/not-a-uuid/roles')
          .set(bearer(admin.accessToken))
          .send({ roles: ['student'] })
      ).status,
    ).toBe(400);
  });

  it('protects the last active administrator', async () => {
    const res = await request(t.app)
      .put(`/api/users/${admin.user.id}/roles`)
      .set(bearer(admin.accessToken))
      .send({ roles: ['student'] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');
  });

  it('allows removing admin once another active admin exists', async () => {
    await createTestUser(t.ctx, { roles: ['admin'] });
    const res = await request(t.app)
      .put(`/api/users/${admin.user.id}/roles`)
      .set(bearer(admin.accessToken))
      .send({ roles: ['student'] });
    expect(res.status).toBe(200);
  });
});

describe('updating profile', () => {
  it('updates name and department', async () => {
    const dept = await createTestDepartment(t.ctx);
    const u = await createTestUser(t.ctx);
    const res = await request(t.app)
      .patch(`/api/users/${u.id}`)
      .set(bearer(admin.accessToken))
      .send({ name: 'Renamed', departmentId: dept });
    expect(res.body.data).toMatchObject({ name: 'Renamed', departmentId: dept });
  });

  it('rejects an empty patch and fields that are not editable', async () => {
    const u = await createTestUser(t.ctx);
    expect(
      (await request(t.app).patch(`/api/users/${u.id}`).set(bearer(admin.accessToken)).send({}))
        .status,
    ).toBe(400);
    expect(
      (
        await request(t.app)
          .patch(`/api/users/${u.id}`)
          .set(bearer(admin.accessToken))
          .send({ email: 'x@y.test' })
      ).status,
    ).toBe(400);
  });
});

describe('deactivation', () => {
  it('deactivates, ends every session immediately, and can be reversed', async () => {
    const u = await createTestUser(t.ctx);
    const s = await loginAs(t, u);
    const res = await request(t.app)
      .post(`/api/users/${u.id}/deactivate`)
      .set(bearer(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
    expect((await request(t.app).get('/api/auth/me').set(bearer(s.accessToken))).status).toBe(401);
    expect(
      (await request(t.app).post('/api/auth/refresh').set('Cookie', s.refreshCookie)).status,
    ).toBe(401);
    expect(
      (await request(t.app).post('/api/auth/login').send({ email: u.email, password: u.password }))
        .status,
    ).toBe(401);

    await request(t.app).post(`/api/users/${u.id}/activate`).set(bearer(admin.accessToken));
    expect(
      (await request(t.app).post('/api/auth/login').send({ email: u.email, password: u.password }))
        .status,
    ).toBe(200);
  });

  it('protects the last active administrator', async () => {
    const res = await request(t.app)
      .post(`/api/users/${admin.user.id}/deactivate`)
      .set(bearer(admin.accessToken));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');
  });

  it('two admins deactivating each other at the same time cannot remove all admins', async () => {
    const second = await loginAs(t, await createTestUser(t.ctx, { roles: ['admin'] }));
    const results = await Promise.all([
      request(t.app).post(`/api/users/${second.user.id}/deactivate`).set(bearer(admin.accessToken)),
      request(t.app).post(`/api/users/${admin.user.id}/deactivate`).set(bearer(second.accessToken)),
    ]);
    const { rows } = await t.ctx.pool.query(
      "SELECT count(*)::int AS n FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'admin' AND u.is_active",
    );
    expect(rows[0].n).toBe(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
});

describe('departments', () => {
  it('creates departments with unique names', async () => {
    const a = await request(t.app)
      .post('/api/departments')
      .set(bearer(admin.accessToken))
      .send({ name: 'Mechanical' });
    expect(a.status).toBe(201);
    const dup = await request(t.app)
      .post('/api/departments')
      .set(bearer(admin.accessToken))
      .send({ name: 'mechanical' });
    expect(dup.status).toBe(409);
    const list = await request(t.app).get('/api/departments').set(bearer(admin.accessToken));
    expect(list.body.data).toHaveLength(1);
  });
});
