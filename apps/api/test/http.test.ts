import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/platform/db.js';
import { buildTestApp } from './helpers.js';

const t = buildTestApp();
afterAll(() => t.close());

describe('health checks', () => {
  it('liveness answers without touching the database', async () => {
    const res = await request(t.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('readiness reports the database as up', async () => {
    const res = await request(t.app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.database).toBe('up');
  });

  it('readiness returns 503 when the database is unreachable', async () => {
    const broken = createPool('postgres://nobody:nope@127.0.0.1:1/none');
    const app = createApp({ ...t.ctx, pool: broken });
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.database).toBe('down');
    await broken.end();
  });
});

describe('error format and request handling', () => {
  it('uses one error shape with a request id for unknown routes', async () => {
    const res = await request(t.app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
    expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
  });

  it('reuses a well-formed incoming X-Request-Id and ignores malformed ones', async () => {
    const good = await request(t.app).get('/api/health').set('X-Request-Id', 'trace-1234-abcd');
    expect(good.headers['x-request-id']).toBe('trace-1234-abcd');
    const bad = await request(t.app).get('/api/health').set('X-Request-Id', 'x y\tz<script>');
    expect(bad.headers['x-request-id']).not.toContain('script');
  });

  it('answers malformed JSON with 400, not a stack trace', async () => {
    const res = await request(t.app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.(ts|js)/);
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await request(t.app)
      .post('/api/auth/login')
      .send({ email: 'a@b.test', password: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('hides internal error details from clients', async () => {
    // a database failure in the middle of a request must surface as a generic 500
    const failing = createApp({
      ...t.ctx,
      pool: {
        query: async () => {
          throw new Error('secret database detail');
        },
      } as never,
    });
    const res = await request(failing)
      .post('/api/auth/login')
      .send({ email: 'a@b.test', password: 'whatever-pass-1' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
    });
    expect(JSON.stringify(res.body)).not.toContain('secret database detail');
  });
});

describe('security headers and CORS', () => {
  it('sets hardening headers and hides the framework', async () => {
    const res = await request(t.app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('allows credentialed requests only from configured origins', async () => {
    const ok = await request(t.app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(t.app).get('/api/health').set('Origin', 'http://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
