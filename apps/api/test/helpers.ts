import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { loadConfig, loadDotEnv, type Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { hashPassword } from '../src/modules/auth/password.js';
import * as authRepo from '../src/modules/auth/repository.js';
import type { Role } from '../src/modules/auth/types.js';
import * as usersRepo from '../src/modules/users/repository.js';
import { createPool, withTx } from '../src/platform/db.js';
import { createLogger } from '../src/platform/logger.js';
import { MemoryMailer } from '../src/platform/mailer.js';
import { LocalFileStorage } from '../src/platform/storage/index.js';

loadDotEnv();

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export interface TestApp {
  app: Express;
  ctx: AppContext;
  mailer: MemoryMailer;
  close: () => Promise<void>;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'events-storage-'));
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    JWT_SECRET: 'vitest-only-signing-key-0123456789abcdefghij',
    PASSWORD_HASH_MEMORY_KIB: '1024', // cheap hashing keeps tests fast; production default is 19456
    PASSWORD_HASH_TIME_COST: '1',
    LOGIN_RATE_LIMIT_MAX: '1000',
    REGISTRATION_RATE_LIMIT_MAX: '1000',
    INVITATION_CODE_RATE_LIMIT_MAX: '1000',
    STORAGE_DIR: storageDir,
    ...overrides,
  });
}

export function buildTestApp(overrides: Record<string, string> = {}): TestApp {
  const config = testConfig(overrides);
  const mailer = new MemoryMailer();
  const ctx: AppContext = {
    config,
    pool: createPool(config.DATABASE_URL),
    logger: createLogger(config),
    mailer,
    storage: new LocalFileStorage(config.STORAGE_DIR),
  };
  return {
    app: createApp(ctx),
    ctx,
    mailer,
    close: async () => {
      await ctx.pool.end();
      rmSync(config.STORAGE_DIR, { recursive: true, force: true });
    },
  };
}

export async function resetDb(ctx: AppContext): Promise<void> {
  await ctx.pool.query(
    'TRUNCATE jobs, audit_log, refresh_tokens, resource_reservations, booking_history, booking_approvals, hall_bookings, resources, halls, event_history, event_approvals, event_speakers, events, calendar_entries, user_roles, users, departments RESTART IDENTITY CASCADE',
  );
}

let counter = 0;
export async function createTestDepartment(
  ctx: AppContext,
  name = `Dept ${++counter}`,
): Promise<string> {
  const { rows } = await ctx.pool.query('INSERT INTO departments (name) VALUES ($1) RETURNING id', [
    name,
  ]);
  return rows[0].id as string;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  roles: Role[];
  departmentId: string | null;
}

export async function createTestUser(
  ctx: AppContext,
  opts: {
    roles?: Role[];
    departmentId?: string | null;
    email?: string;
    active?: boolean;
    password?: string;
  } = {},
): Promise<TestUser> {
  const roles = opts.roles ?? ['student'];
  const password = opts.password ?? TEST_PASSWORD;
  const email = opts.email ?? `user${++counter}@college.test`;
  const departmentId = opts.departmentId ?? null;
  const passwordHash = await hashPassword(password, ctx.config);
  const id = await withTx(ctx.pool, async (tx) => {
    const userId = await usersRepo.insert(tx, {
      email,
      name: `Test ${roles.join('+')}`,
      passwordHash,
      departmentId,
    });
    await usersRepo.setRoles(tx, userId, roles);
    if (opts.active === false) await usersRepo.setActive(tx, userId, false);
    return userId;
  });
  return { id, email, password, roles, departmentId };
}

export interface LoggedIn {
  accessToken: string;
  refreshCookie: string; // "refresh_token=..." ready for a Cookie header
  user: TestUser;
}

export function extractRefreshCookie(setCookie: string[] | string | undefined): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const entry = list.find((c) => c.startsWith('refresh_token='));
  return entry?.split(';')[0];
}

export async function loginAs(t: TestApp, user: TestUser): Promise<LoggedIn> {
  const res = await request(t.app)
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });
  if (res.status !== 200)
    throw new Error(`login failed in test helper: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    accessToken: res.body.accessToken as string,
    refreshCookie: extractRefreshCookie(res.headers['set-cookie'])!,
    user,
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export { authRepo };

// ---- event feature helpers -------------------------------------------------------------------------

/** Request helper bound to one signed-in user: `as(t, session).post('/api/events', body)`. */
export function as(t: TestApp, session: { accessToken: string }) {
  const auth = bearer(session.accessToken);
  return {
    get: (path: string) => request(t.app).get(path).set(auth),
    post: (path: string, body?: object) =>
      request(t.app)
        .post(path)
        .set(auth)
        .send(body ?? {}),
    patch: (path: string, body: object) => request(t.app).patch(path).set(auth).send(body),
    put: (path: string, body: object) => request(t.app).put(path).set(auth).send(body),
    delete: (path: string) => request(t.app).delete(path).set(auth),
  };
}

/** ISO start/end (IST, +05:30) a number of days from now, 10:00 to 12:00 local time. */
export function futureRange(daysAhead = 60, hours = 2): { startAt: string; endAt: string } {
  const day = new Date(Date.now() + daysAhead * 86_400_000);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(day);
  const start = new Date(`${ymd}T10:00:00+05:30`);
  return {
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + hours * 3_600_000).toISOString(),
  };
}

/** The local calendar date (YYYY-MM-DD, IST) of an ISO instant. */
export const istDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));

export function eventBody(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Annual Tech Symposium',
    description: 'Talks and workshops',
    category: 'technical',
    expectedAttendance: 120,
    ...futureRange(),
    ...overrides,
  };
}

export interface Org {
  cse: string;
  ece: string;
  organizer: LoggedIn; // student head, CSE
  faculty: LoggedIn; // CSE
  faculty2: LoggedIn; // CSE
  hod: LoggedIn; // CSE
  hod2: LoggedIn; // CSE
  admin: LoggedIn;
  admin2: LoggedIn;
  otherFaculty: LoggedIn; // ECE
  otherHod: LoggedIn; // ECE
  otherOrganizer: LoggedIn; // ECE
  student: LoggedIn; // plain student, CSE
}

/** Two departments with a full set of people, all signed in. */
export async function buildOrg(t: TestApp): Promise<Org> {
  const cse = await createTestDepartment(t.ctx, 'Computer Science');
  const ece = await createTestDepartment(t.ctx, 'Electronics');
  const mk = async (roles: Role[], departmentId: string | null) =>
    loginAs(t, await createTestUser(t.ctx, { roles, departmentId }));
  return {
    cse,
    ece,
    organizer: await mk(['organizer'], cse),
    faculty: await mk(['faculty'], cse),
    faculty2: await mk(['faculty'], cse),
    hod: await mk(['hod'], cse),
    hod2: await mk(['hod'], cse),
    admin: await mk(['admin'], null),
    admin2: await mk(['admin'], null),
    otherFaculty: await mk(['faculty'], ece),
    otherHod: await mk(['hod'], ece),
    otherOrganizer: await mk(['organizer'], ece),
    student: await mk(['student'], cse),
  };
}

/** Creates a draft through the API and returns its id. */
export async function createDraft(
  t: TestApp,
  who: LoggedIn,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await as(t, who).post('/api/events', eventBody(overrides));
  if (res.status !== 201)
    throw new Error(`createDraft failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

/** Walks an event through all three approval levels with the given people. */
export async function approveFully(
  t: TestApp,
  id: string,
  by: { faculty: LoggedIn; hod: LoggedIn; admin: LoggedIn },
): Promise<void> {
  for (const [level, who] of [
    ['faculty', by.faculty],
    ['hod', by.hod],
    ['admin', by.admin],
  ] as const) {
    const res = await as(t, who).post(`/api/events/${id}/approve`, { level });
    if (res.status !== 200)
      throw new Error(`approve ${level} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

// ---- hall booking & resource helpers ---------------------------------------------------------------

export async function createHall(
  t: TestApp,
  admin: LoggedIn,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await as(t, admin).post('/api/halls', {
    name: `Hall ${Math.random().toString(36).slice(2, 8)}`,
    capacity: 200,
    facilities: ['projector', 'ac'],
    ...overrides,
  });
  if (res.status !== 201)
    throw new Error(`createHall failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

export async function createResource(
  t: TestApp,
  admin: LoggedIn,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await as(t, admin).post('/api/resources', {
    name: `Resource ${Math.random().toString(36).slice(2, 8)}`,
    category: 'av',
    quantity: 5,
    ...overrides,
  });
  if (res.status !== 201)
    throw new Error(`createResource failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

/** A booking request body for an event and hall, defaulting to the event's own time range. */
export function bookingBody(
  eventId: string,
  hallId: string,
  overrides: Record<string, unknown> = {},
) {
  return { eventId, hallId, ...futureRange(), ...overrides };
}

/** An event that went through all three approval levels (status "approved"). */
export async function createApprovedEvent(
  t: TestApp,
  org: Org,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = await createDraft(t, org.organizer, overrides);
  const sub = await as(t, org.organizer).post(`/api/events/${id}/submit`);
  if (sub.status !== 200)
    throw new Error(`submit failed: ${sub.status} ${JSON.stringify(sub.body)}`);
  await approveFully(t, id, { faculty: org.faculty, hod: org.hod, admin: org.admin });
  return id;
}

/** Books a hall for an event and walks the booking through both approval steps. Returns the booking id. */
export async function createConfirmedBooking(
  t: TestApp,
  org: Org,
  eventId: string,
  hallId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await as(t, org.organizer).post(
    '/api/bookings',
    bookingBody(eventId, hallId, { acknowledgeWarnings: true, ...overrides }),
  );
  if (res.status !== 201)
    throw new Error(`booking failed: ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.data.id as string;
  await as(t, org.faculty).post(`/api/bookings/${id}/approve`, { level: 'faculty' });
  await as(t, org.hod).post(`/api/bookings/${id}/approve`, { level: 'hod_admin' });
  return id;
}
