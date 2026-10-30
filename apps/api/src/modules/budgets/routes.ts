import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../platform/validate.js';
import { requireAuth } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import * as service from './service.js';

const eventParams = z.object({ eventId: z.string().uuid() }).strict();
const itemParams = z.object({ eventId: z.string().uuid(), itemId: z.string().uuid() }).strict();

/** Event-scoped budget routes, mounted under /api/events. */
export function budgetRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);

  router.get('/:eventId/budget', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    res.json({ data: await service.getBudget(ctx, req.user!, eventId) });
  });

  router.post('/:eventId/budget/items', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    const body = parse(service.createSchema, req.body);
    res
      .status(201)
      .json({ data: await service.addItem(ctx, req.user!, eventId, body, requestMeta(req)) });
  });

  router.patch('/:eventId/budget/items/:itemId', auth, async (req, res) => {
    const { eventId, itemId } = parse(itemParams, req.params);
    const body = parse(service.patchSchema, req.body);
    res.json({
      data: await service.updateItem(ctx, req.user!, eventId, itemId, body, requestMeta(req)),
    });
  });

  router.delete('/:eventId/budget/items/:itemId', auth, async (req, res) => {
    const { eventId, itemId } = parse(itemParams, req.params);
    res.json({ data: await service.removeItem(ctx, req.user!, eventId, itemId, requestMeta(req)) });
  });

  return router;
}
