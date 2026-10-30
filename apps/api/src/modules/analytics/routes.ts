import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../platform/validate.js';
import { requireAuth } from '../auth/middleware.js';
import * as service from './service.js';

const eventParams = z.object({ eventId: z.string().uuid() }).strict();

/** Summaries across events (admins, and HODs for their department), mounted under /api/analytics. */
export function analyticsRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const sendCsv = (res: Response, file: { filename: string; body: string }) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(file.body);
  };

  router.get('/summary', auth, async (req, res) => {
    res.json({
      data: await service.summary(ctx, req.user!, parse(service.periodQuery, req.query)),
    });
  });
  router.get('/events.csv', auth, async (req, res) => {
    sendCsv(res, await service.eventsCsv(ctx, req.user!, parse(service.periodQuery, req.query)));
  });
  router.get('/halls.csv', auth, async (req, res) => {
    sendCsv(res, await service.hallsCsv(ctx, req.user!, parse(service.periodQuery, req.query)));
  });
  return router;
}

/** One event's analytics, mounted under /api/events. */
export function eventAnalyticsRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/:eventId/analytics', requireAuth(ctx), async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    res.json({ data: await service.eventAnalytics(ctx, req.user!, eventId) });
  });
  return router;
}
