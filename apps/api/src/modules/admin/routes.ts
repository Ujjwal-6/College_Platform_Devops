import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { withTx } from '../../platform/db.js';
import { errors } from '../../platform/errors.js';
import { parse } from '../../platform/validate.js';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import * as repo from './repository.js';

const instant = z.string().datetime({ offset: true });
const page = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
const auditQuery = z
  .object({
    actorId: z.string().uuid().optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    targetType: z.string().trim().min(1).max(50).optional(),
    targetId: z.string().trim().min(1).max(100).optional(),
    from: instant.optional(),
    to: instant.optional(),
    ...page,
  })
  .strict()
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), {
    message: 'from must be before to',
    path: ['from'],
  });
const jobsQuery = z
  .object({
    status: z.enum(repo.JOB_STATUSES).optional(),
    type: z.string().trim().min(1).max(100).optional(),
    ...page,
  })
  .strict();
const idParams = z.object({ id: z.string().uuid() }).strict();

/** Admin-only views of the audit trail and the background-job queue. */
export function adminRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin'));

  router.get('/audit-log', async (req, res) => {
    const { limit, offset, ...filters } = parse(auditQuery, req.query);
    const { rows, total } = await repo.searchAudit(ctx.pool, filters, limit, offset);
    res.json({ data: rows, page: { total, limit, offset } });
  });

  router.get('/audit-log/actions', (_req, res) => {
    res.json({ data: AUDIT_ACTIONS });
  });

  router.get('/jobs', async (req, res) => {
    const { limit, offset, ...filters } = parse(jobsQuery, req.query);
    const [{ rows, total }, counts] = await Promise.all([
      repo.listJobs(ctx.pool, filters, limit, offset),
      repo.jobCounts(ctx.pool),
    ]);
    res.json({ data: rows, counts, page: { total, limit, offset } });
  });

  router.post('/jobs/:id/retry', async (req, res) => {
    const { id } = parse(idParams, req.params);
    await withTx(ctx.pool, async (tx) => {
      const job = await repo.requeueFailedJob(tx, id);
      if (!job) {
        if (!(await repo.jobExists(tx, id))) throw errors.notFound('Job');
        throw errors.conflict('JOB_NOT_FAILED', 'Only failed jobs can be retried');
      }
      await recordAudit(tx, {
        actorId: req.user!.id,
        action: 'job.retried',
        targetType: 'job',
        targetId: id,
        metadata: { type: job.type },
        ...requestMeta(req),
      });
    });
    res.json({ data: { id, status: 'queued' } });
  });

  return router;
}
