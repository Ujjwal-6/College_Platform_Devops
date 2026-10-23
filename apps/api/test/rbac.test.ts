import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '../src/modules/auth/types.js';
import {
  bearer,
  buildTestApp,
  createTestDepartment,
  createTestUser,
  loginAs,
  resetDb,
  type LoggedIn,
  type TestUser,
} from './helpers.js';

const t = buildTestApp();
afterAll(() => t.close());

const ROLES: Role[] = ['student', 'organizer', 'faculty', 'hod', 'admin'];

interface RouteCase {
  name: string;
  method: 'get' | 'post' | 'put' | 'patch';
  /** Builds the path/body once fixtures exist (ids are only known at runtime). */
  build: (f: Fixtures) => { path: string; body?: object };
  allowed: Role[];
}
interface Fixtures {
  targetId: string;
  departmentId: string;
}

let sessions: Record<Role, LoggedIn>;
let deactivated: LoggedIn;
let fixtures: Fixtures;

beforeAll(async () => {
  await resetDb(t.ctx);
  const dept = await createTestDepartment(t.ctx, 'Computer Science');
  const mk = (role: Role): Promise<TestUser> =>
    createTestUser(t.ctx, {
      roles: [role],
      departmentId: role === 'hod' || role === 'faculty' ? dept : null,
    });
  sessions = {} as Record<Role, LoggedIn>;
  for (const r of ROLES) sessions[r] = await loginAs(t, await mk(r));
  const victim = await createTestUser(t.ctx, { roles: ['student'], departmentId: dept });
  const gone = await createTestUser(t.ctx, { roles: ['admin'] });
  deactivated = await loginAs(t, gone);
  await t.ctx.pool.query('UPDATE users SET is_active = false WHERE id = $1', [gone.id]);
  fixtures = { targetId: victim.id, departmentId: dept };
});

// Every route exposed by the foundation. "allowed" = roles that may reach the handler.
const routes: RouteCase[] = [
  {
    name: 'GET /api/auth/me',
    method: 'get',
    build: () => ({ path: '/api/auth/me' }),
    allowed: ROLES,
  },
  {
    name: 'GET /api/departments',
    method: 'get',
    build: () => ({ path: '/api/departments' }),
    allowed: ROLES,
  },
  {
    name: 'POST /api/departments',
    method: 'post',
    build: () => ({ path: '/api/departments', body: { name: `Dept ${Math.random()}` } }),
    allowed: ['admin'],
  },
  {
    name: 'GET /api/users',
    method: 'get',
    build: () => ({ path: '/api/users' }),
    allowed: ['admin', 'hod'],
  },
  {
    name: 'GET /api/users/:id',
    method: 'get',
    build: (f) => ({ path: `/api/users/${f.targetId}` }),
    allowed: ['admin', 'hod'],
  },
  {
    name: 'POST /api/users',
    method: 'post',
    build: () => ({
      path: '/api/users',
      body: {
        email: `n${Math.random()}@college.test`.replace('0.', ''),
        name: 'New',
        password: 'a-long-enough-passphrase',
        roles: ['student'],
      },
    }),
    allowed: ['admin'],
  },
  {
    name: 'PATCH /api/users/:id',
    method: 'patch',
    build: (f) => ({ path: `/api/users/${f.targetId}`, body: { name: 'Renamed' } }),
    allowed: ['admin'],
  },
  {
    name: 'PUT /api/users/:id/roles',
    method: 'put',
    build: (f) => ({ path: `/api/users/${f.targetId}/roles`, body: { roles: ['student'] } }),
    allowed: ['admin'],
  },
  {
    name: 'POST /api/users/:id/deactivate',
    method: 'post',
    build: (f) => ({ path: `/api/users/${f.targetId}/deactivate` }),
    allowed: ['admin'],
  },
  {
    name: 'POST /api/users/:id/activate',
    method: 'post',
    build: (f) => ({ path: `/api/users/${f.targetId}/activate` }),
    allowed: ['admin'],
  },
  {
    name: 'POST /api/auth/change-password',
    method: 'post',
    build: () => ({
      path: '/api/auth/change-password',
      body: { currentPassword: 'x', newPassword: 'y' },
    }),
    allowed: ROLES,
  },
];

const call = (method: RouteCase['method'], path: string) => request(t.app)[method](path);

describe.each(routes)('$name', (route) => {
  it('returns 401 without a token', async () => {
    const { path, body } = route.build(fixtures);
    const res = await call(route.method, path).send(body);
    expect(res.status).toBe(401);
  });

  it('returns 401 for a deactivated user holding a previously valid token', async () => {
    const { path, body } = route.build(fixtures);
    const res = await call(route.method, path).set(bearer(deactivated.accessToken)).send(body);
    expect(res.status).toBe(401);
  });

  for (const role of ROLES) {
    const allowed = route.allowed.includes(role);
    it(`${allowed ? 'allows' : 'denies (403)'} ${role}`, async () => {
      const { path, body } = route.build(fixtures);
      const res = await call(route.method, path).set(bearer(sessions[role].accessToken)).send(body);
      if (allowed) {
        expect(res.status).not.toBe(403);
        // change-password is sent with deliberately wrong credentials, so its 401 is "bad password", not an auth failure
        if (!route.name.includes('change-password')) expect(res.status).not.toBe(401);
        expect(res.status).toBeLessThan(500);
      } else {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    });
  }
});

describe('department scope for HODs', () => {
  it('lists only users in their own department and cannot read other departments', async () => {
    await resetDb(t.ctx);
    const csc = await createTestDepartment(t.ctx, 'CSE');
    const ece = await createTestDepartment(t.ctx, 'ECE');
    const hod = await loginAs(
      t,
      await createTestUser(t.ctx, { roles: ['hod'], departmentId: csc }),
    );
    const mine = await createTestUser(t.ctx, { roles: ['student'], departmentId: csc });
    const theirs = await createTestUser(t.ctx, { roles: ['student'], departmentId: ece });

    const list = await request(t.app).get('/api/users').set(bearer(hod.accessToken));
    expect(list.status).toBe(200);
    const ids = list.body.data.map((u: { id: string }) => u.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);

    // a HOD cannot widen the scope with a query parameter
    const widened = await request(t.app)
      .get(`/api/users?departmentId=${ece}`)
      .set(bearer(hod.accessToken));
    expect(widened.body.data.map((u: { id: string }) => u.id)).not.toContain(theirs.id);

    expect(
      (await request(t.app).get(`/api/users/${mine.id}`).set(bearer(hod.accessToken))).status,
    ).toBe(200);
    expect(
      (await request(t.app).get(`/api/users/${theirs.id}`).set(bearer(hod.accessToken))).status,
    ).toBe(404);
  });

  it('a user with several roles gets the union of their permissions', async () => {
    const multi = await loginAs(t, await createTestUser(t.ctx, { roles: ['student', 'admin'] }));
    expect((await request(t.app).get('/api/users').set(bearer(multi.accessToken))).status).toBe(
      200,
    );
  });
});
