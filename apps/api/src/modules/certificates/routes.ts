import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { errors } from '../../platform/errors.js';
import { parse } from '../../platform/validate.js';
import { requireAuth } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import * as service from './service.js';

const eventParams = z.object({ eventId: z.string().uuid() }).strict();
const idParams = z.object({ id: z.string().uuid() }).strict();
const emptyBody = z.object({}).strict();

/** Event-scoped routes, mounted under /api/events: who has a certificate, and asking for them to be issued. */
export function eventCertificateRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);

  router.get('/:eventId/certificates', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    res.json(await service.eventCertificates(ctx, req.user!, eventId));
  });

  router.post('/:eventId/certificates/redraw', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    parse(emptyBody, req.body ?? {});
    res.status(202).json({
      data: await service.redrawAll(ctx, req.user!, eventId, requestMeta(req)),
    });
  });

  router.post('/:eventId/certificates/issue', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    parse(emptyBody, req.body ?? {});
    res.status(202).json({
      data: await service.requestIssue(ctx, req.user!, eventId, requestMeta(req)),
    });
  });

  return router;
}

/** Certificate routes, mounted under /api/certificates. Verification is public and rate limited. */
export function certificateRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const verifyLimit = rateLimit({
    windowMs: ctx.config.REGISTRATION_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: ctx.config.VERIFY_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(errors.tooManyRequests('Too many checks, try again later')),
  });

  router.get('/verify/:code', verifyLimit, async (req, res) => {
    const { code } = parse(service.verifyParams, req.params);
    res.json({ data: await service.verify(ctx, code) });
  });

  router.get('/', auth, async (req, res) => {
    parse(z.object({}).strict(), req.query);
    res.json({ data: await service.myCertificates(ctx, req.user!) });
  });

  router.get('/:id/download', auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const pdf = await service.downloadCertificate(ctx, req.user!, id);
    res.setHeader('Cache-Control', 'no-store');
    if (!pdf) {
      res.status(202).json({ data: { status: 'pending' } });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="certificate.pdf"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(pdf);
  });

  router.post('/:id/revoke', auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(service.revokeSchema, req.body);
    res.json({ data: await service.revokeCertificate(ctx, req.user!, id, body, requestMeta(req)) });
  });

  router.post('/:id/reinstate', auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    parse(emptyBody, req.body ?? {});
    res.json({ data: await service.reinstateCertificate(ctx, req.user!, id, requestMeta(req)) });
  });

  router.post('/:id/regenerate', auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    parse(emptyBody, req.body ?? {});
    res.status(202).json({ data: await service.regenerate(ctx, req.user!, id, requestMeta(req)) });
  });

  return router;
}

const imageParams = z.object({ kind: z.enum(['logo', 'signature']) }).strict();

/**
 * The design shared by all certificates, mounted under /api/certificate-template. Admins only. The
 * logo and signature are sent as the raw image (Content-Type image/png or image/jpeg), at most 1 MB.
 */
export function certificateTemplateRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const rawImage = express.raw({ type: ['image/png', 'image/jpeg'], limit: '1mb' });

  router.get('/', auth, async (req, res) => {
    res.json({ data: await service.getTemplate(ctx, req.user!) });
  });

  router.put('/', auth, async (req, res) => {
    const body = parse(service.templateSchema, req.body);
    res.json({ data: await service.updateTemplateText(ctx, req.user!, body, requestMeta(req)) });
  });

  router.put('/:kind', auth, rawImage, async (req, res) => {
    const { kind } = parse(imageParams, req.params);
    res.json({
      data: await service.setTemplateImage(ctx, req.user!, kind, req.body, requestMeta(req)),
    });
  });

  router.delete('/:kind', auth, async (req, res) => {
    const { kind } = parse(imageParams, req.params);
    res.json({ data: await service.removeTemplateImage(ctx, req.user!, kind, requestMeta(req)) });
  });

  return router;
}
