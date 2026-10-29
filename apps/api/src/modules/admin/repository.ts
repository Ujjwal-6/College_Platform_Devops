import type { Executor } from '../../platform/db.js';

export interface AuditFilters {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
}

export interface AuditRecord {
  id: string;
  createdAt: string;
  action: string;
  actor: { id: string; name: string; email: string } | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  ip: string | null;
}

function auditWhere(f: AuditFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    clauses.push(clause.replace('?', `$${params.length}`));
  };
  if (f.actorId) add('a.actor_id = ?', f.actorId);
  if (f.action) add('a.action = ?', f.action);
  if (f.targetType) add('a.target_type = ?', f.targetType);
  if (f.targetId) add('a.target_id = ?', f.targetId);
  if (f.from) add('a.created_at >= ?', f.from);
  if (f.to) add('a.created_at < ?', f.to);
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export async function searchAudit(
  db: Executor,
  filters: AuditFilters,
  limit: number,
  offset: number,
): Promise<{ rows: AuditRecord[]; total: number }> {
  const { sql, params } = auditWhere(filters);
  const total = await db.query(`SELECT count(*)::int AS n FROM audit_log a ${sql}`, params);
  const { rows } = await db.query(
    `SELECT a.id::text, a.created_at, a.action, a.target_type, a.target_id, a.metadata,
            a.request_id, a.ip, u.id AS actor_id, u.name AS actor_name, u.email AS actor_email
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ${sql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return {
    total: total.rows[0].n as number,
    rows: rows.map((r) => ({
      id: r.id as string,
      createdAt: (r.created_at as Date).toISOString(),
      action: r.action as string,
      actor: r.actor_id
        ? { id: r.actor_id as string, name: r.actor_name as string, email: r.actor_email as string }
        : null,
      targetType: (r.target_type as string | null) ?? null,
      targetId: (r.target_id as string | null) ?? null,
      metadata: r.metadata as Record<string, unknown>,
      requestId: (r.request_id as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
    })),
  };
}

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Job fields safe to show an admin. The payload is left out on purpose: it can hold recipient addresses and message text. */
export interface JobSummary {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  jobKey: string | null;
  runAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const iso = (v: unknown) => (v as Date).toISOString();

function mapJobSummary(r: Record<string, unknown>): JobSummary {
  return {
    id: r.id as string,
    type: r.type as string,
    status: r.status as JobStatus,
    attempts: r.attempts as number,
    maxAttempts: r.max_attempts as number,
    lastError: (r.last_error as string | null) ?? null,
    jobKey: (r.job_key as string | null) ?? null,
    runAt: iso(r.run_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    completedAt: r.completed_at ? iso(r.completed_at) : null,
  };
}

export async function listJobs(
  db: Executor,
  filters: { status?: JobStatus; type?: string },
  limit: number,
  offset: number,
): Promise<{ rows: JobSummary[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filters.type) {
    params.push(filters.type);
    clauses.push(`type = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = await db.query(`SELECT count(*)::int AS n FROM jobs ${where}`, params);
  const { rows } = await db.query(
    `SELECT id, type, status, attempts, max_attempts, last_error, job_key, run_at, created_at,
            updated_at, completed_at
       FROM jobs ${where}
      ORDER BY updated_at DESC, id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { total: total.rows[0].n as number, rows: rows.map(mapJobSummary) };
}

export async function jobCounts(db: Executor): Promise<Record<JobStatus, number>> {
  const { rows } = await db.query('SELECT status, count(*)::int AS n FROM jobs GROUP BY status');
  const counts: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0 };
  for (const r of rows) counts[r.status as JobStatus] = r.n as number;
  return counts;
}

/**
 * Puts a failed job back in the queue with a fresh set of attempts. The status check is part of
 * the UPDATE, so two admins pressing retry together requeue it once. Returns null if the job is
 * not in the failed state (or does not exist).
 */
export async function requeueFailedJob(db: Executor, id: string): Promise<{ type: string } | null> {
  const { rows } = await db.query(
    `UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), locked_until = NULL,
                     updated_at = now()
      WHERE id = $1 AND status = 'failed'
      RETURNING type`,
    [id],
  );
  return rows[0] ? { type: rows[0].type as string } : null;
}

export async function jobExists(db: Executor, id: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM jobs WHERE id = $1', [id]);
  return rows.length > 0;
}
