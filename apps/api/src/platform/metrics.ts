import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';

// A small Prometheus text-format registry (no dependency). Label values come only from fixed sets
// (route patterns, status codes, job types), never from request input, so cardinality stays bounded.

type Labels = Record<string, string>;
const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(labels[k]!)}"`)
    .join(',');
const escapeLabel = (v: string) =>
  v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const line = (name: string, labels: string, value: number) =>
  `${name}${labels ? `{${labels}}` : ''} ${Number.isFinite(value) ? value : 0}`;

export class Counter {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) out.push(line(this.name, '', 0));
    for (const [k, v] of this.values) out.push(line(this.name, k, v));
    return out;
  }
}

export class Histogram {
  private series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[],
  ) {}
  observe(labels: Labels, seconds: number): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.bounds.forEach((b, i) => {
      if (seconds <= b) s.buckets[i]! += 1;
    });
    s.sum += seconds;
    s.count += 1;
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : '';
      this.bounds.forEach((b, i) =>
        out.push(line(`${this.name}_bucket`, `${sep}le="${b}"`, s.buckets[i]!)),
      );
      out.push(line(`${this.name}_bucket`, `${sep}le="+Inf"`, s.count));
      out.push(line(`${this.name}_sum`, k, s.sum));
      out.push(line(`${this.name}_count`, k, s.count));
    }
    return out;
  }
}

const SECONDS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120];

export const httpRequests = new Counter(
  'http_requests_total',
  'HTTP requests handled, by method, route and status.',
);
export const httpDuration = new Histogram(
  'http_request_duration_seconds',
  'HTTP request duration in seconds.',
  SECONDS,
);
export const jobRuns = new Counter(
  'job_runs_total',
  'Background job runs finished by this process, by type and outcome.',
);
export const jobDuration = new Histogram(
  'job_duration_seconds',
  'Background job run time in seconds.',
  SECONDS,
);
export const eventsAutoClosed = new Counter(
  'events_auto_closed_total',
  'Events closed automatically after they ended.',
);

const startedAt = Date.now();

const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=.*\d)[\w-]{8,})$/i;

/**
 * A low-cardinality label for the address of a request that reached a route: path segments that look
 * like ids, numbers or codes become ":id", so "/api/events/<uuid>/budget" is "/api/events/:id/budget".
 * Requests that matched no route are all "unmatched", so a scanner cannot create endless labels.
 */
export function routeLabel(req: Request): string {
  if (req.route === undefined) return 'unmatched';
  const path = req.originalUrl.split('?')[0] ?? '';
  const label = path
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/')
    .replace(/(.)\/$/, '$1');
  return label.slice(0, 120) || '/';
}

/** Records every request: method, route label, status and duration. */
export const requestMetrics: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const begin = process.hrtime.bigint();
  res.on('finish', () => {
    const route = routeLabel(req);
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    httpDuration.observe(
      { method: req.method, route },
      Number(process.hrtime.bigint() - begin) / 1e9,
    );
  });
  next();
};

/** Everything that is read from the database or the process at scrape time. */
async function gauges(pool: Pool): Promise<string[]> {
  const out: string[] = [];
  const gauge = (name: string, help: string, rows: [string, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, v] of rows) out.push(line(name, labels, v));
  };
  gauge('db_pool_connections', 'Database pool connections by state.', [
    ['state="total"', pool.totalCount],
    ['state="idle"', pool.idleCount],
    ['state="waiting"', pool.waitingCount],
  ]);
  gauge('process_uptime_seconds', 'Seconds since this process started.', [
    ['', (Date.now() - startedAt) / 1000],
  ]);
  gauge('process_resident_memory_bytes', 'Resident memory of this process.', [
    ['', process.memoryUsage().rss],
  ]);
  try {
    const counts = await pool.query('SELECT status, count(*)::int AS n FROM jobs GROUP BY status');
    const by = new Map(counts.rows.map((r) => [r.status as string, r.n as number]));
    gauge(
      'jobs',
      'Background jobs by status (failed jobs need an administrator).',
      ['queued', 'running', 'succeeded', 'failed'].map((s): [string, number] => [
        `status="${s}"`,
        by.get(s) ?? 0,
      ]),
    );
    const age = await pool.query(
      "SELECT coalesce(extract(epoch FROM now() - min(run_at)), 0)::float AS s FROM jobs WHERE status = 'queued' AND run_at <= now()",
    );
    gauge('jobs_oldest_due_age_seconds', 'Age of the oldest job that is due but not yet started.', [
      ['', age.rows[0].s as number],
    ]);
    gauge('database_up', 'Whether the database answered the metrics queries.', [['', 1]]);
  } catch {
    gauge('database_up', 'Whether the database answered the metrics queries.', [['', 0]]);
  }
  return out;
}

export async function renderMetrics(pool: Pool): Promise<string> {
  const parts = [
    ...httpRequests.render(),
    ...httpDuration.render(),
    ...jobRuns.render(),
    ...jobDuration.render(),
    ...eventsAutoClosed.render(),
    ...(await gauges(pool)),
  ];
  return parts.join('\n') + '\n';
}

/** True when the Authorization header carries exactly the configured token (compared in constant time). */
export function metricsTokenOk(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export interface MetricsReply {
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
}

/** The answer to `GET /metrics`: off (404) unless METRICS_TOKEN is set; then it needs `Authorization: Bearer <token>`. */
export async function metricsReply(
  pool: Pool,
  token: string | undefined,
  authorization: string | undefined,
): Promise<MetricsReply> {
  const json = 'application/json; charset=utf-8';
  if (!token) {
    return {
      status: 404,
      contentType: json,
      headers: {},
      body: '{"error":{"code":"NOT_FOUND","message":"Resource not found"}}',
    };
  }
  if (!metricsTokenOk(authorization, token)) {
    return {
      status: 401,
      contentType: json,
      headers: { 'WWW-Authenticate': 'Bearer' },
      body: '{"error":{"code":"UNAUTHENTICATED","message":"Authentication required"}}',
    };
  }
  return {
    status: 200,
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
    body: await renderMetrics(pool),
  };
}

export function metricsHandler(pool: Pool, token: string | undefined): RequestHandler {
  return async (req, res, next) => {
    try {
      const reply = await metricsReply(pool, token, req.headers.authorization);
      res
        .status(reply.status)
        .set({ ...reply.headers, 'Content-Type': reply.contentType })
        .send(reply.body);
    } catch (err) {
      next(err);
    }
  };
}
