import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../platform/validate.js';
import { requireAuth } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import * as service from './service.js';

const eventParams = z.object({ eventId: z.string().uuid() }).strict();

/** Event-scoped feedback routes, mounted under /api/events. */
export function feedbackRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);

  router.get('/:eventId/feedback/mine', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    res.json({ data: await service.mine(ctx, req.user!, eventId) });
  });

  router.post('/:eventId/feedback', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    const body = parse(service.submitSchema, req.body);
    res.status(201).json({
      data: await service.submit(ctx, req.user!, eventId, body, requestMeta(req)),
    });
  });

  router.get('/:eventId/feedback', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    res.json({ data: await service.results(ctx, req.user!, eventId) });
  });

  return router;
}
