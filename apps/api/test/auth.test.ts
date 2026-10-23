import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearer,
  buildTestApp,
  createTestUser,
  extractRefreshCookie,
  loginAs,
  resetDb,
  TEST_PASSWORD,
} from './helpers.js';

const t = buildTestApp({ REFRESH_REUSE_GRACE_SECONDS: '0', LOGIN_LOCKOUT_THRESHOLD: '3' });
beforeEach(() => resetDb(t.ctx));
afterAll(() => t.close());

const post = (path: string) => request(t.app).post(path);

describe('login', () => {
  it('returns an access token and sets a hardened refresh cookie', async () => {
    const user = await createTestUser(t.ctx, { roles: ['student'] });
    const res = await post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ id: user.id, email: user.email, roles: ['student'] });
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('refresh_token='),
    )!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);
  });

  it('never returns password material', async () => {
    const user = await createTestUser(t.ctx);
    const res = await post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password/i);
  });

  it('is case-insensitive on email', async () => {
    const user = await createTestUser(t.ctx, { email: 'mixed@college.test' });
    const res = await post('/api/auth/login').send({
      email: 'MIXED@College.Test',
      password: user.password,
    });
    expect(res.status).toBe(200);
  });

  it('gives the same response for a wrong password and an unknown email', async () => {
    const user = await createTestUser(t.ctx);
    const wrong = await post('/api/auth/login').send({
      email: user.email,
      password: 'wrong-password-123',
    });
    const unknown = await post('/api/auth/login').send({
      email: 'nobody@college.test',
      password: 'wrong-password-123',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('rejects deactivated users with the same generic error', async () => {
    const user = await createTestUser(t.ctx, { active: false });
    const res = await post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const user = await createTestUser(t.ctx);
    for (let i = 0; i < 3; i++) {
      await post('/api/auth/login').send({ email: user.email, password: 'wrong-password-123' });
    }
    const res = await post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(res.status).toBe(401);
  });

  it('rejects unknown fields and malformed input with 400 and no echoed values', async () => {
    const res = await post('/api/auth/login').send({
      email: 'x@college.test',
      password: 'secret-value-123',
      admin: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secret-value-123');
    expect(
      (await post('/api/auth/login').send({ email: 'not-an-email', password: 'x' })).status,
    ).toBe(400);
  });
});

describe('login rate limiting', () => {
  it('returns 429 after too many attempts from one client', async () => {
    const limited = buildTestApp({ LOGIN_RATE_LIMIT_MAX: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push(
          (
            await request(limited.app)
              .post('/api/auth/login')
              .send({ email: 'a@college.test', password: 'whatever-pass-1' })
          ).status,
        );
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('access tokens', () => {
  it('GET /me returns the caller for a valid token', async () => {
    const user = await createTestUser(t.ctx, { roles: ['faculty', 'organizer'] });
    const s = await loginAs(t, user);
    const res = await request(t.app).get('/api/auth/me').set(bearer(s.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.user.roles).toEqual(['faculty', 'organizer']);
  });

  it('rejects missing, malformed, tampered, expired, wrong-audience and alg=none tokens with 401', async () => {
    const user = await createTestUser(t.ctx);
    const s = await loginAs(t, user);
    const { JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE } = t.ctx.config;
    const base = {
      algorithm: 'HS256' as const,
      subject: user.id,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    };
    const expired = jwt.sign({}, JWT_SECRET, { ...base, expiresIn: -10 });
    const wrongAudience = jwt.sign({}, JWT_SECRET, {
      ...base,
      audience: 'someone-else',
      expiresIn: 60,
    });
    const wrongKey = jwt.sign({}, 'another-signing-key-another-signing-key', {
      ...base,
      expiresIn: 60,
    });
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const algNone = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: user.id, iss: JWT_ISSUER, aud: JWT_AUDIENCE })}.`;
    const tampered =
      s.accessToken.slice(0, -4) + (s.accessToken.endsWith('AAAA') ? 'BBBB' : 'AAAA');

    for (const token of [expired, wrongAudience, wrongKey, algNone, tampered, 'garbage']) {
      const res = await request(t.app).get('/api/auth/me').set(bearer(token));
      expect(res.status, token.slice(0, 20)).toBe(401);
    }
    expect((await request(t.app).get('/api/auth/me')).status).toBe(401);
    expect(
      (await request(t.app).get('/api/auth/me').set('Authorization', 'Basic abc')).status,
    ).toBe(401);
  });

  it('stops working immediately when the user is deactivated', async () => {
    const user = await createTestUser(t.ctx);
    const s = await loginAs(t, user);
    await t.ctx.pool.query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);
    expect((await request(t.app).get('/api/auth/me').set(bearer(s.accessToken))).status).toBe(401);
  });

  it('reflects role changes immediately', async () => {
    const user = await createTestUser(t.ctx, { roles: ['student'] });
    const s = await loginAs(t, user);
    await t.ctx.pool.query("UPDATE user_roles SET role = 'organizer' WHERE user_id = $1", [
      user.id,
    ]);
    const res = await request(t.app).get('/api/auth/me').set(bearer(s.accessToken));
    expect(res.body.user.roles).toEqual(['organizer']);
  });
});

describe('refresh token rotation', () => {
  it('issues a new token pair and invalidates the old refresh token', async () => {
    const s = await loginAs(t, await createTestUser(t.ctx));
    const res = await post('/api/auth/refresh').set('Cookie', s.refreshCookie);
    expect(res.status).toBe(200);
    const next = extractRefreshCookie(res.headers['set-cookie'])!;
    expect(next).not.toBe(s.refreshCookie);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect((await post('/api/auth/refresh').set('Cookie', s.refreshCookie)).status).toBe(401);
  });

  it('stores only a hash of the refresh token', async () => {
    const s = await loginAs(t, await createTestUser(t.ctx));
    const raw = s.refreshCookie.split('=')[1]!;
    const { rows } = await t.ctx.pool.query('SELECT token_hash FROM refresh_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(raw);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats reuse of a rotated token as theft and revokes the whole family (AC-1.2)', async () => {
    const s = await loginAs(t, await createTestUser(t.ctx));
    const rotated = await post('/api/auth/refresh').set('Cookie', s.refreshCookie);
    const newest = extractRefreshCookie(rotated.headers['set-cookie'])!;
    expect((await post('/api/auth/refresh').set('Cookie', s.refreshCookie)).status).toBe(401); // replay
    expect((await post('/api/auth/refresh').set('Cookie', newest)).status).toBe(401); // family revoked
    const { rows } = await t.ctx.pool.query(
      "SELECT 1 FROM audit_log WHERE action = 'auth.refresh_reuse_detected'",
    );
    expect(rows).toHaveLength(1);
  });

  it('with two simultaneous refreshes using one token, exactly one succeeds', async () => {
    const s = await loginAs(t, await createTestUser(t.ctx));
    const results = await Promise.all([
      post('/api/auth/refresh').set('Cookie', s.refreshCookie),
      post('/api/auth/refresh').set('Cookie', s.refreshCookie),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('within the grace window a replay is rejected but the family survives', async () => {
    const graceful = buildTestApp({ REFRESH_REUSE_GRACE_SECONDS: '30' });
    try {
      const user = await createTestUser(graceful.ctx);
      const s = await loginAs(graceful, user);
      const first = await request(graceful.app)
        .post('/api/auth/refresh')
        .set('Cookie', s.refreshCookie);
      const newest = extractRefreshCookie(first.headers['set-cookie'])!;
      const replay = await request(graceful.app)
        .post('/api/auth/refresh')
        .set('Cookie', s.refreshCookie);
      expect(replay.status).toBe(401);
      expect(replay.headers['set-cookie']).toBeUndefined(); // must not clear the newer cookie another tab just received
      expect(
        (await request(graceful.app).post('/api/auth/refresh').set('Cookie', newest)).status,
      ).toBe(200);
    } finally {
      await graceful.close();
    }
  });

  it('rejects missing, unknown and expired refresh tokens', async () => {
    const s = await loginAs(t, await createTestUser(t.ctx));
    expect((await post('/api/auth/refresh')).status).toBe(401);
    expect((await post('/api/auth/refresh').set('Cookie', 'refresh_token=nonsense')).status).toBe(
      401,
    );
    await t.ctx.pool.query("UPDATE refresh_tokens SET expires_at = now() - interval '1 minute'");
    expect((await post('/api/auth/refresh').set('Cookie', s.refreshCookie)).status).toBe(401);
  });

  it('refuses cookie-based calls from an untrusted Origin (CSRF defence)', async () => {
    const s = await loginAs(t, await createTestUser(t.ctx));
    const res = await post('/api/auth/refresh')
      .set('Cookie', s.refreshCookie)
      .set('Origin', 'http://evil.example');
    expect(res.status).toBe(403);
    const ok = await post('/api/auth/refresh')
      .set('Cookie', s.refreshCookie)
      .set('Origin', 'http://localhost:5173');
    expect(ok.status).toBe(200);
  });

  it('does not refresh for a user deactivated after login', async () => {
    const user = await createTestUser(t.ctx);
    const s = await loginAs(t, user);
    await t.ctx.pool.query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);
    expect((await post('/api/auth/refresh').set('Cookie', s.refreshCookie)).status).toBe(401);
  });
});

describe('logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const s = await loginAs(t, await createTestUser(t.ctx));
    const res = await post('/api/auth/logout').set('Cookie', s.refreshCookie);
    expect(res.status).toBe(204);
    expect(String((res.headers['set-cookie'] as unknown as string[])[0])).toMatch(
      /refresh_token=;/,
    );
    expect((await post('/api/auth/refresh').set('Cookie', s.refreshCookie)).status).toBe(401);
  });

  it('is harmless without a session', async () => {
    expect((await post('/api/auth/logout')).status).toBe(204);
  });
});

describe('change password', () => {
  it('changes the password, revokes all sessions and enforces the policy', async () => {
    const user = await createTestUser(t.ctx);
    const s = await loginAs(t, user);
    const other = await loginAs(t, user);

    const weak = await post('/api/auth/change-password')
      .set(bearer(s.accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);
    const wrong = await post('/api/auth/change-password')
      .set(bearer(s.accessToken))
      .send({ currentPassword: 'not-the-password', newPassword: 'a-brand-new-passphrase' });
    expect(wrong.status).toBe(401);

    const ok = await post('/api/auth/change-password')
      .set(bearer(s.accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-passphrase' });
    expect(ok.status).toBe(204);
    expect((await post('/api/auth/refresh').set('Cookie', other.refreshCookie)).status).toBe(401);
    expect(
      (await post('/api/auth/login').send({ email: user.email, password: TEST_PASSWORD })).status,
    ).toBe(401);
    expect(
      (
        await post('/api/auth/login').send({
          email: user.email,
          password: 'a-brand-new-passphrase',
        })
      ).status,
    ).toBe(200);
  });

  it('requires authentication', async () => {
    expect(
      (await post('/api/auth/change-password').send({ currentPassword: 'a', newPassword: 'b' }))
        .status,
    ).toBe(401);
  });
});

describe('password storage', () => {
  it('stores argon2id hashes, never the plain password', async () => {
    const user = await createTestUser(t.ctx);
    const { rows } = await t.ctx.pool.query('SELECT password_hash FROM users WHERE id = $1', [
      user.id,
    ]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(TEST_PASSWORD);
  });
});
