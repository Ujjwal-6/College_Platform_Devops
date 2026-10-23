import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../src/modules/audit/audit.js';
import { withTx } from '../src/platform/db.js';
import { buildTestApp, createTestUser, resetDb, TEST_PASSWORD } from './helpers.js';

const t = buildTestApp();
beforeEach(() => resetDb(t.ctx));
afterAll(() => t.close());

describe('audit log', () => {
  it('is append-only: UPDATE and DELETE are rejected by the database', async () => {
    await recordAudit(t.ctx.pool, { action: 'auth.login', actorId: null });
    await expect(t.ctx.pool.query("UPDATE audit_log SET action = 'tampered'")).rejects.toThrow(
      /append-only/,
    );
    await expect(t.ctx.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    const { rows } = await t.ctx.pool.query('SELECT action FROM audit_log');
    expect(rows).toEqual([{ action: 'auth.login' }]);
  });

  it('rolls back together with the transaction it belongs to', async () => {
    await expect(
      withTx(t.ctx.pool, async (tx) => {
        await recordAudit(tx, { action: 'user.created' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await t.ctx.pool.query('SELECT 1 FROM audit_log');
    expect(rows).toHaveLength(0);
  });

  it('records exactly one row per login, failed login and logout, with request id and no secrets', async () => {
    const user = await createTestUser(t.ctx);
    await request(t.app)
      .post('/api/auth/login')
      .set('X-Request-Id', 'req-abc-12345')
      .send({ email: user.email, password: 'wrong-password-123' });
    const ok = await request(t.app)
      .post('/api/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });
    const cookie = (ok.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    await request(t.app).post('/api/auth/logout').set('Cookie', cookie);

    const { rows } = await t.ctx.pool.query(
      'SELECT action, actor_id, request_id, metadata FROM audit_log ORDER BY id',
    );
    expect(rows.map((r) => r.action)).toEqual(['auth.login_failed', 'auth.login', 'auth.logout']);
    expect(rows.every((r) => r.actor_id === user.id)).toBe(true);
    expect(rows[0].request_id).toBe('req-abc-12345');
    expect(JSON.stringify(rows)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(rows)).not.toContain('wrong-password-123');
  });

  it('does not store the submitted email for unknown-user login failures', async () => {
    await request(t.app)
      .post('/api/auth/login')
      .send({ email: 'probe@college.test', password: 'whatever-pass-1' });
    const { rows } = await t.ctx.pool.query('SELECT metadata FROM audit_log');
    expect(JSON.stringify(rows)).not.toContain('probe@college.test');
  });
});
