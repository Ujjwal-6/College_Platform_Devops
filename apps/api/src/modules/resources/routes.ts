import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { errors } from '../../platform/errors.js';
import { parse } from '../../platform/validate.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import * as repo from './repository.js';
import { RESOURCE_STATUSES } from './repository.js';
import * as service from './service.js';

const isoInstant = z
  .string()
  .datetime({ offset: true, message: 'Use an ISO-8601 date-time with a UTC offset' });
const idParams = z.object({ id: z.string().uuid() }).strict();

const resourceFields = {
  name: z.string().trim().min(2).max(100),
  category: z.string().trim().min(2).max(50),
  quantity: z.number().int().min(1).max(100_000),
  description: z.string().trim().max(2000),
  status: z.enum(RESOURCE_STATUSES),
};
const createResourceSchema = z
  .object({
    name: resourceFields.name,
    category: resourceFields.category,
    quantity: resourceFields.quantity,
    description: resourceFields.description.default(''),
    status: resourceFields.status.default('available'),
  })
  .strict();
const patchResourceSchema = z
  .object(resourceFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const availabilityQuery = z.object({ startAt: isoInstant, endAt: isoInstant }).strict();

/** Resource catalogue: everyone signed in can read it, only admins change it. */
export function resourceRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (req, res) => {
    res.json({
      data: await repo.listResources(ctx.pool, {
        includeRetired: req.user!.roles.includes('admin'),
      }),
    });
  });

  // How many units of each resource are free for a time window (informational; reservation re-checks atomically).
  router.get('/availability', async (req, res) => {
    const q = parse(availabilityQuery, req.query);
    const startAt = new Date(q.startAt);
    const endAt = new Date(q.endAt);
    if (endAt <= startAt)
      throw errors.validation([{ path: 'endAt', message: 'End must be after start' }]);
    res.json(await service.availability(ctx, req.user!, { startAt, endAt }));
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    const body = parse(createResourceSchema, req.body);
    res
      .status(201)
      .json({ data: await service.createResource(ctx, req.user!, body, requestMeta(req)) });
  });

  router.patch('/:id', requireRole('admin'), async (req, res) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(patchResourceSchema, req.body);
    res.json({ data: await service.updateResource(ctx, req.user!, id, patch, requestMeta(req)) });
  });

  return router;
}

const reserveSchema = z
  .object({
    eventId: z.string().uuid(),
    resourceId: z.string().uuid(),
    quantity: z.number().int().min(1).max(100_000),
    startAt: isoInstant.optional(),
    endAt: isoInstant.optional(),
    notes: z.string().trim().max(1000).default(''),
  })
  .strict()
  .refine(
    (v) => (v.startAt === undefined) === (v.endAt === undefined),
    'Give both startAt and endAt, or neither',
  );
const reservationPatchSchema = z
  .object({
    quantity: z.number().int().min(1).max(100_000),
    startAt: isoInstant,
    endAt: isoInstant,
    notes: z.string().trim().max(1000),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const releaseSchema = z.object({ comment: z.string().trim().max(500).optional() }).strict();
const listQuery = z.object({ eventId: z.string().uuid() }).strict();

/** Reservations of resources for events. Only the event's organizer or an admin reserves, changes or releases. */
export function reservationRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (req, res) => {
    const q = parse(listQuery, req.query);
    res.json(await service.listForEvent(ctx, req.user!, q.eventId));
  });

  router.post('/', async (req, res) => {
    const body = parse(reserveSchema, req.body);
    const { reservation, created } = await service.reserve(ctx, req.user!, body, requestMeta(req));
    res.status(created ? 201 : 200).json({ data: reservation });
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(reservationPatchSchema, req.body);
    res.json({
      data: await service.updateReservation(ctx, req.user!, id, patch, requestMeta(req)),
    });
  });

  router.post('/:id/release', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(releaseSchema, req.body ?? {});
    res.json({
      data: await service.releaseOne(ctx, req.user!, id, body.comment ?? '', requestMeta(req)),
    });
  });

  return router;
}
