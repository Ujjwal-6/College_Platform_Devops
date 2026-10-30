import express, { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../platform/validate.js';
import { requireAuth } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import * as service from './service.js';

const eventParams = z.object({ eventId: z.string().uuid() }).strict();
const photoParams = z.object({ eventId: z.string().uuid(), photoId: z.string().uuid() }).strict();
const idParams = z.object({ id: z.string().uuid() }).strict();
const emptyBody = z.object({}).strict();

/** Event-scoped routes, mounted under /api/events: the report's inputs, its versions, asking for a new one. */
export function eventReportRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const rawImage = express.raw({
    type: ['image/png', 'image/jpeg'],
    limit: service.PHOTO_MAX_BYTES,
  });

  router.get('/:eventId/report', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    res.json({ data: await service.overview(ctx, req.user!, eventId) });
  });

  router.put('/:eventId/report/outcomes', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    const body = parse(service.outcomesSchema, req.body);
    res.json({ data: await service.saveOutcomes(ctx, req.user!, eventId, body, requestMeta(req)) });
  });

  router.post('/:eventId/report/photos', auth, rawImage, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    const query = parse(service.photoQuerySchema, req.query);
    res.status(201).json({
      data: await service.addPhoto(ctx, req.user!, eventId, req.body, query, requestMeta(req)),
    });
  });

  router.get('/:eventId/report/photos/:photoId', auth, async (req, res) => {
    const { eventId, photoId } = parse(photoParams, req.params);
    const file = await service.photoImage(ctx, req.user!, eventId, photoId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(file.data);
  });

  router.delete('/:eventId/report/photos/:photoId', auth, async (req, res) => {
    const { eventId, photoId } = parse(photoParams, req.params);
    res.json({
      data: await service.removePhoto(ctx, req.user!, eventId, photoId, requestMeta(req)),
    });
  });

  router.post('/:eventId/reports', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    parse(emptyBody, req.body ?? {});
    res
      .status(202)
      .json({ data: await service.requestReport(ctx, req.user!, eventId, requestMeta(req)) });
  });

  return router;
}

/** Downloading a version, mounted under /api/event-reports. */
export function reportRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/:id/download', requireAuth(ctx), async (req, res) => {
    const { id } = parse(idParams, req.params);
    const file = await service.downloadReport(ctx, req.user!, id);
    res.setHeader('Cache-Control', 'no-store');
    if (!file) {
      res.status(202).json({ data: { status: 'pending' } });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="event-report-v${file.version}.pdf"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(file.data);
  });
  return router;
}
