import request from 'supertest';
import { signAccessToken } from '../src/modules/auth/tokens.js';
import {
  as,
  bearer,
  createApprovedEvent,
  createTestUser,
  type LoggedIn,
  type Org,
  type TestApp,
} from './helpers.js';

/** A signed-in session without a password round trip (hundreds of users are needed in some tests). */
export async function sessionFor(
  t: TestApp,
  opts: {
    roles?: ('student' | 'faculty' | 'hod' | 'admin' | 'organizer')[];
    departmentId?: string | null;
  } = {},
): Promise<LoggedIn> {
  const user = await createTestUser(t.ctx, {
    roles: opts.roles ?? ['student'],
    departmentId: opts.departmentId ?? null,
  });
  return { accessToken: signAccessToken(t.ctx.config, user.id), refreshCookie: '', user };
}

export async function students(t: TestApp, n: number, departmentId: string | null = null) {
  const out: LoggedIn[] = [];
  for (let i = 0; i < n; i++) out.push(await sessionFor(t, { departmentId }));
  return out;
}

/** An approved and published event owned by `org.organizer`. */
export async function createPublishedEvent(
  t: TestApp,
  org: Org,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = await createApprovedEvent(t, org, overrides);
  const res = await as(t, org.organizer).post(`/api/events/${id}/publish`);
  if (res.status !== 200)
    throw new Error(`publish failed: ${res.status} ${JSON.stringify(res.body)}`);
  return id;
}

export const teamEvent = (over: Record<string, unknown> = {}) => ({
  registrationMode: 'team',
  teamSizeMin: 2,
  teamSizeMax: 4,
  ...over,
});

/** POST with an optional Idempotency-Key header (the shared `as()` helper has no header support). */
export function post(t: TestApp, who: LoggedIn, path: string, body: object = {}, key?: string) {
  const req = request(t.app).post(path).set(bearer(who.accessToken));
  return (key ? req.set('Idempotency-Key', key) : req).send(body);
}

export const register = (t: TestApp, who: LoggedIn, eventId: string, key?: string) =>
  post(t, who, `/api/events/${eventId}/registrations`, {}, key);

export const createTeam = (
  t: TestApp,
  who: LoggedIn,
  eventId: string,
  name: string,
  key?: string,
) => post(t, who, `/api/events/${eventId}/teams`, { name }, key);

export const joinTeam = (t: TestApp, who: LoggedIn, code: string, key?: string) =>
  post(t, who, '/api/teams/join', { code }, key);
