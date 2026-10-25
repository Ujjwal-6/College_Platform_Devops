import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../platform/validate.js';
import { requireAuth } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import { canView } from '../events/lifecycle.js';
import { decisionSchema, rejectionSchema } from '../events/schemas.js';
import { getEventDetail } from '../events/service.js';
import type { AuthUser } from '../auth/types.js';
import type { EventRecord } from '../events/types.js';
import * as service from './service.js';

const idParams = z.object({ id: z.string().uuid() }).strict();

/**
 * After a rejection the event is a private draft again, so the approver who rejected it may no
 * longer open it. Return the full detail when they still can, otherwise just the outcome.
 */
async function respond(ctx: AppContext, actor: AuthUser, event: EventRecord) {
  if (canView(actor, event)) return getEventDetail(ctx, actor, event.id);
  return { id: event.id, status: event.status, approvalLevel: event.approvalLevel };
}

/** Mounted under /api/events so the URLs read POST /api/events/:id/approve. */
export function approvalRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.post('/:id/approve', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(decisionSchema, req.body);
    const updated = await service.decide(
      ctx,
      req.user!,
      id,
      { decision: 'approved', level: body.level, comment: body.comment },
      requestMeta(req),
    );
    res.json({ data: await respond(ctx, req.user!, updated) });
  });

  router.post('/:id/reject', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(rejectionSchema, req.body);
    const updated = await service.decide(
      ctx,
      req.user!,
      id,
      { decision: 'rejected', level: body.level, comment: body.comment },
      requestMeta(req),
    );
    res.json({ data: await respond(ctx, req.user!, updated) });
  });

  return router;
}
