import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { workerFor } from './aftermath-helpers.js';
import { buildTestApp, createTestUser, loginAs, resetDb } from './helpers.js';
import { enqueue } from '../src/platform/jobs/queue.js';
import { Counter, Histogram, metricsTokenOk, routeLabel } from '../src/platform/metrics.js';

const TOKEN = 'metrics-test-token-0123456789';
const t = buildTestApp({ METRICS_TOKEN: TOKEN });
const off = buildTestApp();
beforeEach(() => resetDb(t.ctx));
afterAll(async () => {
  await t.close();
  await off.close();
});

const scrape = (app = t.app, token: string | null = TOKEN) => {
  const r = request(app).get('/metrics');
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
/** The value of one sample, e.g. value(text, 'jobs', 'status="failed"'). */
function value(text: string, name: string, labels = ''): number | undefined {
  const re = new RegExp(
    `^${name}${labels ? `\\{[^}]*${labels.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*\\}` : '(?:\\{\\})?'} ([0-9.e+-]+)$`,
    'm',
  );
  const m = re.exec(text);
  return m ? Number(m[1]) : undefined;
}

describe('access', () => {
  it('is off (404) when no token is configured', async () => {
    expect((await scrape(off.app)).status).toBe(404);
    expect((await scrape(off.app, null)).status).toBe(404);
  });
  it('needs the bearer token (401 without it, with a wrong one or of another kind)', async () => {
    expect((await scrape(t.app, null)).status).toBe(401);
    expect((await scrape(t.app, 'wrong-token-0123456789')).status).toBe(401);
    expect((await scrape(t.app, TOKEN + 'x')).status).toBe(401);
    expect(
      (await request(t.app).get('/metrics').set('Authorization', `Basic ${TOKEN}`)).status,
    ).toBe(401);
    const user = await loginAs(t, await createTestUser(t.ctx, { roles: ['admin'] }));
    expect(
      (await request(t.app).get('/metrics').set('Authorization', `Bearer ${user.accessToken}`))
        .status,
    ).toBe(401);
  });
  it('compares tokens exactly', () => {
    expect(metricsTokenOk(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(metricsTokenOk(undefined, TOKEN)).toBe(false);
    expect(metricsTokenOk('Bearer ', TOKEN)).toBe(false);
  });
  it('is plain text in the Prometheus format and never cached', async () => {
    const res = await scrape();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('# TYPE http_requests_total counter');
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.text.endsWith('\n')).toBe(true);
  });
});

describe('requests', () => {
  it('counts requests by method, route pattern and status, and records their duration', async () => {
    const before = value((await scrape()).text, 'http_requests_total', 'route="/api/health"') ?? 0;
    await request(t.app).get('/api/health');
    await request(t.app).get('/api/health');
    await request(t.app)
      .post('/api/auth/login')
      .send({ email: 'nobody@college.test', password: 'x' });
    const text = (await scrape()).text;
    expect(value(text, 'http_requests_total', 'route="/api/health"')).toBe(before + 2);
    expect(text).toMatch(
      /http_requests_total\{method="POST",route="\/api\/auth\/login",status="401"\} \d+/,
    );
    expect(text).toMatch(
      /http_request_duration_seconds_count\{method="GET",route="\/api\/health"\} \d+/,
    );
    expect(text).toMatch(/http_request_duration_seconds_bucket\{[^}]*le="\+Inf"[^}]*\} \d+/);
  });

  it('uses the route pattern, not the address, so ids never become labels', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const admin = await loginAs(t, await createTestUser(t.ctx, { roles: ['admin'] }));
    await request(t.app)
      .get(`/api/events/${id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    const text = (await scrape()).text;
    expect(text).not.toContain(id);
    expect(text).toContain('route="/api/events/:id"');
  });

  it('files unknown addresses under one label', async () => {
    await request(t.app).get('/api/no/such/thing/1');
    await request(t.app).get('/api/no/such/thing/2');
    const text = (await scrape()).text;
    expect(text).not.toContain('no/such');
    expect(text).toContain('route="unmatched"');
  });
});

describe('route labels', () => {
  const label = (url: string, matched = true) =>
    routeLabel({ originalUrl: url, route: matched ? {} : undefined } as never);
  it.each([
    ['/api/events/11111111-1111-4111-8111-111111111111/budget?x=1', '/api/events/:id/budget'],
    ['/api/bookings/42', '/api/bookings/:id'],
    ['/api/certificates/verify/ABCD2345EFGH6789', '/api/certificates/verify/:id'],
    ['/api/events/', '/api/events'],
    ['/api/check-in', '/api/check-in'],
    ['/api/analytics/events.csv', '/api/analytics/events.csv'],
    ['/api/auth/forgot-password', '/api/auth/forgot-password'],
  ])('turns %s into %s', (url, expected) => {
    expect(label(url)).toBe(expected);
  });
  it('files a request that matched no route as "unmatched"', () => {
    expect(label('/api/anything/at/all', false)).toBe('unmatched');
  });
});

describe('jobs and the database', () => {
  it('reports the number of jobs by status and the age of the oldest waiting one', async () => {
    await enqueue(t.ctx.pool, {
      type: 'email.send',
      payload: { notification: 'x', to: 'a@b.test', data: {} },
      key: 'a',
    });
    await enqueue(t.ctx.pool, { type: 'email.send', payload: {}, key: 'b' });
    await t.ctx.pool.query(
      "UPDATE jobs SET status = 'failed', last_error = 'boom' WHERE payload = '{}'::jsonb",
    );
    await t.ctx.pool.query(
      "UPDATE jobs SET run_at = now() - interval '90 seconds' WHERE status = 'queued'",
    );
    const text = (await scrape()).text;
    expect(value(text, 'jobs', 'status="queued"')).toBe(1);
    expect(value(text, 'jobs', 'status="failed"')).toBe(1);
    expect(value(text, 'jobs', 'status="running"')).toBe(0);
    expect(value(text, 'jobs_oldest_due_age_seconds')).toBeGreaterThanOrEqual(90);
    expect(value(text, 'database_up')).toBe(1);
  });

  it('counts runs and failures by job type when the worker runs them', async () => {
    const run = async (type: string) =>
      value((await scrape()).text, 'job_runs_total', `type="${type}"`);
    await enqueue(t.ctx.pool, {
      type: 'email.send',
      payload: {
        notification: 'account.created',
        to: 'a@college.test',
        data: { name: 'A', loginUrl: 'http://x' },
      },
      key: 'm1',
    });
    await enqueue(t.ctx.pool, {
      type: 'email.send',
      payload: { notification: 'nope', to: 'a@college.test', data: {} },
      key: 'm2',
    });
    await workerFor(t).drain();
    const text = (await scrape()).text;
    expect(text).toMatch(/job_runs_total\{outcome="succeeded",type="email.send"\} \d+/);
    expect(text).toMatch(/job_runs_total\{outcome="failed",type="email.send"\} \d+/);
    expect(await run('email.send')).toBeGreaterThanOrEqual(1);
    expect(text).toMatch(/job_duration_seconds_count\{type="email.send"\} \d+/);
    expect(value(text, 'jobs', 'status="failed"')).toBe(1);
  });

  it('shows database_up 0 instead of failing when the database cannot be read', async () => {
    const broken = buildTestApp({ METRICS_TOKEN: TOKEN });
    await broken.ctx.pool.end();
    const res = await scrape(broken.app);
    expect(res.status).toBe(200);
    expect(value(res.text, 'database_up')).toBe(0);
  });
});

describe('the registry', () => {
  it('escapes label values and renders histograms cumulatively', () => {
    const c = new Counter('things_total', 'Things.');
    c.inc({ name: 'a"b\\c\nd' });
    expect(c.render().join('\n')).toContain('things_total{name="a\\"b\\\\c\\nd"} 1');
    const h = new Histogram('wait_seconds', 'Waiting.', [1, 5]);
    h.observe({}, 0.5);
    h.observe({}, 3);
    h.observe({}, 9);
    const text = h.render().join('\n');
    expect(text).toContain('wait_seconds_bucket{le="1"} 1');
    expect(text).toContain('wait_seconds_bucket{le="5"} 2');
    expect(text).toContain('wait_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('wait_seconds_sum 12.5');
    expect(text).toContain('wait_seconds_count 3');
  });
  it('shows a counter nobody has used yet as zero', () => {
    expect(new Counter('unused_total', 'Unused.').render().at(-1)).toBe('unused_total 0');
  });
});
