import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../platform/validate.js';
import { requireAuth } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import * as service from './service.js';

const eventParams = z.object({ eventId: z.string().uuid() }).strict();
const volunteerParams = z
  .object({ eventId: z.string().uuid(), userId: z.string().uuid() })
  .strict();
const idParams = z.object({ id: z.string().uuid() }).strict();

/** Event-scoped routes, mounted under /api/events: scanning, manual check-in, live attendance, volunteers. */
export function eventAttendanceRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);

  router.post('/:eventId/check-ins', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    const body = parse(service.scanSchema, req.body);
    const data = await service.checkInByCode(ctx, req.user!, eventId, body.token, requestMeta(req));
    res.status(201).json({ data });
  });

  router.post('/:eventId/check-ins/manual', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    const body = parse(service.manualSchema, req.body);
    const data = await service.checkInManually(ctx, req.user!, eventId, body, requestMeta(req));
    res.status(201).json({ data });
  });

  router.get('/:eventId/attendance', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    res.json(
      await service.overview(
        ctx,
        req.user!,
        eventId,
        parse(service.attendanceQuerySchema, req.query),
      ),
    );
  });

  router.get('/:eventId/volunteers', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    res.json({ data: await service.listVolunteers(ctx, req.user!, eventId) });
  });

  router.post('/:eventId/volunteers', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    const body = parse(service.volunteerSchema, req.body);
    res.json({
      data: await service.addVolunteer(ctx, req.user!, eventId, body, requestMeta(req)),
    });
  });

  router.delete('/:eventId/volunteers/:userId', auth, async (req, res) => {
    const { eventId, userId } = parse(volunteerParams, req.params);
    res.json({
      data: await service.removeVolunteer(ctx, req.user!, eventId, userId, requestMeta(req)),
    });
  });

  return router;
}

/** Events the signed-in person can scan passes for, mounted under /api/check-in. */
export function checkInRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/events', requireAuth(ctx), async (req, res) => {
    parse(z.object({}).strict(), req.query);
    res.json({ data: await service.myCheckInEvents(ctx, req.user!) });
  });
  return router;
}

/** A registrant's own pass, mounted under /api/registrations. */
export function passRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);

  router.get('/:id/qr', auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: await service.myPass(ctx, req.user!, id) });
  });

  router.get('/:id/gate-pass', auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const pdf = await service.myGatePass(ctx, req.user!, id);
    res.setHeader('Cache-Control', 'no-store');
    if (!pdf) {
      // The worker has not produced it yet: not an error, try again shortly.
      res.status(202).json({ data: { status: 'pending' } });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="gate-pass.pdf"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(pdf);
  });

  return router;
}
