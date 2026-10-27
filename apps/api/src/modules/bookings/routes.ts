import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { errors } from '../../platform/errors.js';
import { parse } from '../../platform/validate.js';
import { requireAuth } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import { facilitiesSchema } from '../halls/routes.js';
import * as service from './service.js';
import { BOOKING_LEVELS, BOOKING_STATUSES } from './types.js';

const isoInstant = z.string().datetime({
  offset: true,
  message: 'Use an ISO-8601 date-time with a UTC offset, e.g. 2031-03-01T10:00:00+05:30',
});
const idParams = z.object({ id: z.string().uuid() }).strict();

const createSchema = z
  .object({
    eventId: z.string().uuid(),
    hallId: z.string().uuid(),
    startAt: isoInstant,
    endAt: isoInstant,
    requiredFacilities: facilitiesSchema.default([]),
    notes: z.string().trim().max(1000).default(''),
    acknowledgeWarnings: z.boolean().default(false),
  })
  .strict();
const patchSchema = z
  .object({
    hallId: z.string().uuid(),
    startAt: isoInstant,
    endAt: isoInstant,
    requiredFacilities: facilitiesSchema,
    notes: z.string().trim().max(1000),
    acknowledgeWarnings: z.boolean().default(false),
  })
  .partial({ hallId: true, startAt: true, endAt: true, requiredFacilities: true, notes: true })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'acknowledgeWarnings'), 'Nothing to update');
const cancelSchema = z.object({ comment: z.string().trim().max(1000).optional() }).strict();
const approveSchema = z
  .object({ level: z.enum(BOOKING_LEVELS), comment: z.string().trim().max(1000).optional() })
  .strict();
const rejectSchema = z
  .object({
    level: z.enum(BOOKING_LEVELS),
    comment: z.string().trim().min(1, 'A comment is required when rejecting').max(1000),
  })
  .strict();
const listQuery = z
  .object({
    scope: z.enum(['mine', 'event', 'department', 'approvals']).default('mine'),
    eventId: z.string().uuid().optional(),
    status: z.enum(BOOKING_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
const availabilityQuery = z
  .object({
    startAt: isoInstant,
    endAt: isoInstant,
    attendance: z.coerce.number().int().min(1).max(100_000).optional(),
    facilities: z.string().max(500).optional(),
    onlyAvailable: z.enum(['true', 'false']).optional(),
  })
  .strict();

/**
 * Hall bookings. Every route needs a signed-in user; ownership, department and approval rules live
 * in the service so they apply however an action is reached.
 */
export function bookingRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  // Which halls are free for a time range. Everyone signed in may look; event names follow event visibility.
  router.get('/availability', async (req, res) => {
    const q = parse(availabilityQuery, req.query);
    const startAt = new Date(q.startAt);
    const endAt = new Date(q.endAt);
    if (endAt <= startAt)
      throw errors.validation([{ path: 'endAt', message: 'End must be after start' }]);
    const facilities = parse(
      facilitiesSchema,
      (q.facilities ?? '').split(',').filter((f) => f.trim()),
    );
    res.json(
      await service.availability(ctx, req.user!, {
        startAt,
        endAt,
        attendance: q.attendance,
        facilities,
        onlyAvailable: q.onlyAvailable === 'true',
      }),
    );
  });

  router.get('/', async (req, res) => {
    res.json(await service.listBookings(ctx, req.user!, parse(listQuery, req.query)));
  });

  router.post('/', async (req, res) => {
    const body = parse(createSchema, req.body);
    const { detail, created } = await service.createBooking(ctx, req.user!, body, requestMeta(req));
    res.status(created ? 201 : 200).json({ data: detail });
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json({ data: await service.getBookingDetail(ctx, req.user!, id) });
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json({
      data: await service.updateBooking(
        ctx,
        req.user!,
        id,
        parse(patchSchema, req.body),
        requestMeta(req),
      ),
    });
  });

  router.post('/:id/cancel', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(cancelSchema, req.body ?? {});
    res.json({
      data: await service.cancelBooking(ctx, req.user!, id, body.comment, requestMeta(req)),
    });
  });

  router.post('/:id/approve', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(approveSchema, req.body);
    res.json({
      data: await service.decideBooking(
        ctx,
        req.user!,
        id,
        { decision: 'approved', ...body },
        requestMeta(req),
      ),
    });
  });

  router.post('/:id/reject', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(rejectSchema, req.body);
    res.json({
      data: await service.decideBooking(
        ctx,
        req.user!,
        id,
        { decision: 'rejected', ...body },
        requestMeta(req),
      ),
    });
  });

  return router;
}
