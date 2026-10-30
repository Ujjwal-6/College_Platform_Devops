import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { workerFor } from './aftermath-helpers.js';
import {
  buildTestApp,
  createTestUser,
  loginAs,
  resetDb,
  TEST_PASSWORD,
  type TestUser,
} from './helpers.js';

const t = buildTestApp({ PASSWORD_RESET_COOLDOWN_SECONDS: '0', PASSWORD_RESET_TTL_MINUTES: '30' });
beforeEach(async () => {
  await resetDb(t.ctx);
  t.mailer.sent.length = 0;
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const forgot = (email: string) => request(t.app).post('/api/auth/forgot-password').send({ email });
const reset = (token: string, newPassword: string) =>
  request(t.app).post('/api/auth/reset-password').send({ token, newPassword });
const NEW_PASSWORD = 'a-brand-new-long-passphrase';

/** Asks for a link, runs the email job and returns the token from the email. */
async function linkFor(user: TestUser, app = t): Promise<string> {
  t.mailer.sent.length = 0;
  expect(
    (await request(app.app).post('/api/auth/forgot-password').send({ email: user.email })).status,
  ).toBe(202);
  await workerFor(t).drain();
  const mail = t.mailer.sent.at(-1)!;
  expect(mail.to).toBe(user.email);
  const match = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(mail.text);
  expect(match).not.toBeNull();
  return match![1]!;
}
const signIn = (email: string, password: string) =>
  request(t.app).post('/api/auth/login').send({ email, password });

describe('asking for a link', () => {
  it('emails a link to an active account, and stores only a hash of it', async () => {
    const user = await createTestUser(t.ctx);
    const token = await linkFor(user);
    const mail = t.mailer.sent.at(-1)!;
    expect(mail.subject).toBe('Reset your College Events password');
    expect(mail.text).toContain(`${t.ctx.config.WEB_BASE_URL}/reset-password?token=${token}`);
    expect(mail.text).toContain('within 30 minutes');
    const rows = await q(
      'SELECT token_hash, used_at, expires_at - created_at AS ttl FROM password_reset_tokens',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toContain(token);
    expect(rows[0].used_at).toBeNull();
    expect(JSON.stringify(rows[0].ttl)).toContain('30');
  });

  it('gives the same answer for an unknown address, a deactivated account and a real one', async () => {
    const real = await createTestUser(t.ctx);
    const off = await createTestUser(t.ctx, { active: false });
    const answers = [];
    for (const email of [real.email, off.email, 'nobody@college.test']) {
      const res = await forgot(email);
      answers.push([res.status, res.body]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]![0]).toBe(202);
    await workerFor(t).drain();
    expect(t.mailer.sent.map((m) => m.to)).toEqual([real.email]);
  });

  it('finds the account whatever the letter case of the address', async () => {
    const user = await createTestUser(t.ctx, { email: 'mixed@college.test' });
    await forgot('MIXED@College.test');
    await workerFor(t).drain();
    expect(t.mailer.sent.map((m) => m.to)).toEqual([user.email]);
  });

  it('makes an earlier link useless when a new one is asked for', async () => {
    const user = await createTestUser(t.ctx);
    const first = await linkFor(user);
    const second = await linkFor(user);
    expect((await reset(first, NEW_PASSWORD)).status).toBe(400);
    expect((await reset(second, NEW_PASSWORD)).status).toBe(204);
  });

  it('sends at most one email per cooldown, even for parallel requests', async () => {
    const cool = buildTestApp({ PASSWORD_RESET_COOLDOWN_SECONDS: '600' });
    try {
      const user = await createTestUser(cool.ctx);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(cool.app).post('/api/auth/forgot-password').send({ email: user.email }),
        ),
      );
      expect(results.every((r) => r.status === 202)).toBe(true);
      expect(
        await cool.ctx.pool
          .query("SELECT 1 FROM jobs WHERE type = 'email.send'")
          .then((r) => r.rowCount),
      ).toBe(1);
      expect(
        await cool.ctx.pool.query('SELECT 1 FROM password_reset_tokens').then((r) => r.rowCount),
      ).toBe(1);
    } finally {
      await cool.close();
    }
  });

  it('records the request in the audit log, without the token', async () => {
    const user = await createTestUser(t.ctx);
    const token = await linkFor(user);
    const audit = await q(
      "SELECT actor_id, metadata FROM audit_log WHERE action = 'auth.password_reset_requested'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(user.id);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('refuses bad input (400) and unknown fields', async () => {
    expect((await forgot('not-an-email')).status).toBe(400);
    expect((await request(t.app).post('/api/auth/forgot-password').send({})).status).toBe(400);
    expect(
      (await request(t.app).post('/api/auth/forgot-password').send({ email: 'a@b.test', x: 1 }))
        .status,
    ).toBe(400);
  });

  it('is rate limited', async () => {
    const limited = buildTestApp({ LOGIN_RATE_LIMIT_MAX: '3' });
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) {
        codes.push(
          (
            await request(limited.app)
              .post('/api/auth/forgot-password')
              .send({ email: 'x@college.test' })
          ).status,
        );
      }
      expect(codes).toEqual([202, 202, 202, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('using a link', () => {
  it('sets the new password, which then works, while the old one does not', async () => {
    const user = await createTestUser(t.ctx);
    const token = await linkFor(user);
    const res = await reset(token, NEW_PASSWORD);
    expect(res.status).toBe(204);
    expect((await signIn(user.email, NEW_PASSWORD)).status).toBe(200);
    expect((await signIn(user.email, TEST_PASSWORD)).status).toBe(401);
    const audit = await q("SELECT metadata FROM audit_log WHERE action = 'auth.password_reset'");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it('works only once', async () => {
    const user = await createTestUser(t.ctx);
    const token = await linkFor(user);
    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
    const again = await reset(token, 'another-long-passphrase-xyz');
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_RESET_TOKEN');
    expect((await signIn(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('is used by exactly one of many parallel requests', async () => {
    const user = await createTestUser(t.ctx);
    const token = await linkFor(user);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => reset(token, `parallel-long-passphrase-${i}`)),
    );
    expect(results.filter((r) => r.status === 204)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(7);
  });

  it('refuses an expired link', async () => {
    const user = await createTestUser(t.ctx);
    const token = await linkFor(user);
    await q(
      "UPDATE password_reset_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'",
    );
    const res = await reset(token, NEW_PASSWORD);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
    expect((await signIn(user.email, TEST_PASSWORD)).status).toBe(200);
  });

  it('refuses an invented, malformed or empty token', async () => {
    await createTestUser(t.ctx);
    for (const token of ['A'.repeat(43), 'short', '']) {
      expect((await reset(token, NEW_PASSWORD)).status, token).toBe(400);
    }
    expect(
      (await request(t.app).post('/api/auth/reset-password').send({ newPassword: NEW_PASSWORD }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(t.app)
          .post('/api/auth/reset-password')
          .send({ token: 'A'.repeat(43), newPassword: NEW_PASSWORD, x: 1 })
      ).status,
    ).toBe(400);
  });

  it('applies the password rules and keeps the link usable after a refusal', async () => {
    const user = await createTestUser(t.ctx);
    const token = await linkFor(user);
    const weak = await reset(token, 'short');
    expect(weak.status).toBe(400);
    expect(weak.body.error.details[0].path).toBe('newPassword');
    const sameAsEmail = await reset(token, user.email);
    expect(sameAsEmail.status).toBe(400);
    expect((await reset(token, NEW_PASSWORD)).status).toBe(204);
  });

  it('ends every session of the account', async () => {
    const user = await createTestUser(t.ctx);
    const session = await loginAs(t, user);
    const token = await linkFor(user);
    await reset(token, NEW_PASSWORD);
    const refreshed = await request(t.app)
      .post('/api/auth/refresh')
      .set('Cookie', session.refreshCookie)
      .set('Origin', t.ctx.config.WEB_BASE_URL);
    expect(refreshed.status).toBe(401);
  });

  it('lifts a lockout caused by failed sign-ins', async () => {
    const locking = buildTestApp({ LOGIN_LOCKOUT_THRESHOLD: '2' });
    try {
      const user = await createTestUser(locking.ctx);
      for (let i = 0; i < 2; i++)
        await request(locking.app)
          .post('/api/auth/login')
          .send({ email: user.email, password: 'wrong-password-123' });
      expect(
        (
          await request(locking.app)
            .post('/api/auth/login')
            .send({ email: user.email, password: user.password })
        ).status,
      ).not.toBe(200);
      await request(locking.app).post('/api/auth/forgot-password').send({ email: user.email });
      await workerFor(locking).drain();
      const token = /token=([A-Za-z0-9_-]+)/.exec(locking.mailer.sent.at(-1)!.text)![1]!;
      expect(
        (
          await request(locking.app)
            .post('/api/auth/reset-password')
            .send({ token, newPassword: NEW_PASSWORD })
        ).status,
      ).toBe(204);
      expect(
        (
          await request(locking.app)
            .post('/api/auth/login')
            .send({ email: user.email, password: NEW_PASSWORD })
        ).status,
      ).toBe(200);
    } finally {
      await locking.close();
    }
  });

  it('refuses the link of an account deactivated in the meantime', async () => {
    const user = await createTestUser(t.ctx);
    const token = await linkFor(user);
    await q('UPDATE users SET is_active = false WHERE id = $1', [user.id]);
    expect((await reset(token, NEW_PASSWORD)).status).toBe(400);
  });

  it('is rate limited', async () => {
    const limited = buildTestApp({ LOGIN_RATE_LIMIT_MAX: '3' });
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) {
        codes.push(
          (
            await request(limited.app)
              .post('/api/auth/reset-password')
              .send({ token: 'A'.repeat(43), newPassword: NEW_PASSWORD })
          ).status,
        );
      }
      expect(codes).toEqual([400, 400, 400, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});
