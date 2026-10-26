import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../platform/validate.js';
import { requireAuth } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import {
  commentSchema,
  createEventSchema,
  listQuerySchema,
  optionalNoteSchema,
  updateEventSchema,
} from './schemas.js';
import * as service from './service.js';

const idParams = z.object({ id: z.string().uuid() }).strict();

/**
 * Event endpoints. Every route requires a signed-in user; ownership, department and role checks
 * happen in the service so the same rules apply however an action is reached.
 * Approval decisions (POST /:id/approve and /:id/reject) live in modules/approvals/routes.ts.
 */
export function eventRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (req, res) => {
    res.json(await service.listEvents(ctx, req.user!, parse(listQuerySchema, req.query)));
  });

  router.post('/', async (req, res) => {
    const body = parse(createEventSchema, req.body);
    res
      .status(201)
      .json({ data: await service.createEvent(ctx, req.user!, body, requestMeta(req)) });
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json({ data: await service.getEventDetail(ctx, req.user!, id) });
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(updateEventSchema, req.body);
    res.json({ data: await service.updateEvent(ctx, req.user!, id, body, requestMeta(req)) });
  });

  router.post('/:id/submit', async (req, res) => {
    const { id } = parse(idParams, req.params);
    parse(z.object({}).strict(), req.body ?? {});
    res.json({ data: await service.submitEvent(ctx, req.user!, id, requestMeta(req)) });
  });

  for (const name of ['withdraw', 'revise', 'publish', 'unpublish', 'close'] as const) {
    router.post(`/:id/${name}`, async (req, res) => {
      const { id } = parse(idParams, req.params);
      const body = parse(optionalNoteSchema, req.body ?? {});
      res.json({ data: await service.runAction(ctx, req.user!, id, name, body, requestMeta(req)) });
    });
  }

  router.post('/:id/cancel', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(commentSchema, req.body ?? {});
    res.json({
      data: await service.runAction(ctx, req.user!, id, 'cancel', body, requestMeta(req)),
    });
  });

  return router;
}
