import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { errors } from '../../platform/errors.js';
import { idempotencyKey, requestFingerprint } from '../../platform/idempotency.js';
import { parse } from '../../platform/validate.js';
import { requireAuth } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import * as service from './service.js';

const eventParams = z.object({ eventId: z.string().uuid() }).strict();
const idParams = z.object({ id: z.string().uuid() }).strict();
const emptyBody = z.object({}).strict();

function limiter(ctx: AppContext, max: number, message: string) {
  return rateLimit({
    windowMs: ctx.config.REGISTRATION_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Counted per signed-in person, not per address: a college network shares one address.
    keyGenerator: (req) => req.user!.id,
    handler: (_req, _res, next) => next(errors.tooManyRequests(message)),
  });
}

/**
 * Event-scoped routes, mounted under /api/events:
 *   register, create a team, see the seat summary, and (for staff) the list of registrants.
 */
export function eventRegistrationRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const writeLimit = limiter(
    ctx,
    ctx.config.REGISTRATION_RATE_LIMIT_MAX,
    'Too many registration attempts, try again later',
  );

  router.get('/:eventId/registration-summary', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    res.json({ data: await service.summary(ctx, req.user!, eventId) });
  });

  router.get('/:eventId/registrations', auth, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    res.json(
      await service.listForEvent(
        ctx,
        req.user!,
        eventId,
        parse(service.listQuerySchema, req.query),
      ),
    );
  });

  router.post('/:eventId/registrations', auth, writeLimit, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    const body = parse(service.registerSchema, req.body ?? {});
    const out = await service.registerIndividual(
      ctx,
      req.user!,
      eventId,
      body,
      { key: idempotencyKey(req), fingerprint: requestFingerprint(req) },
      requestMeta(req),
    );
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(out.status).json(out.body);
  });

  router.post('/:eventId/teams', auth, writeLimit, async (req, res) => {
    const { eventId } = parse(eventParams, req.params);
    const body = parse(service.createTeamSchema, req.body);
    const out = await service.createTeam(
      ctx,
      req.user!,
      eventId,
      body,
      { key: idempotencyKey(req), fingerprint: requestFingerprint(req) },
      requestMeta(req),
    );
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(out.status).json(out.body);
  });

  return router;
}

/** Team routes, mounted under /api/teams. Joining with a code has its own, stricter rate limit. */
export function teamRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const codeLimit = limiter(
    ctx,
    ctx.config.INVITATION_CODE_RATE_LIMIT_MAX,
    'Too many invitation code attempts, try again later',
  );

  router.post('/join', auth, codeLimit, async (req, res) => {
    const body = parse(service.joinSchema, req.body);
    const out = await service.joinTeam(
      ctx,
      req.user!,
      body.code,
      { key: idempotencyKey(req), fingerprint: requestFingerprint(req) },
      requestMeta(req),
    );
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(out.status).json(out.body);
  });

  router.get('/:id', auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json({ data: await service.getTeam(ctx, req.user!, id) });
  });

  router.post('/:id/invitation', auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    parse(emptyBody, req.body ?? {});
    res.json({ data: await service.regenerateInvitation(ctx, req.user!, id, requestMeta(req)) });
  });

  router.post('/:id/invitation/revoke', auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    parse(emptyBody, req.body ?? {});
    res.json({ data: await service.revokeInvitation(ctx, req.user!, id, requestMeta(req)) });
  });

  return router;
}

/** The signed-in person's own registrations, mounted under /api/registrations. */
export function myRegistrationRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);

  router.get('/', auth, async (req, res) => {
    parse(z.object({}).strict(), req.query);
    res.json({ data: await service.listMine(ctx, req.user!) });
  });

  router.post('/:id/cancel', auth, async (req, res) => {
    const { id } = parse(idParams, req.params);
    parse(emptyBody, req.body ?? {});
    res.json({ data: await service.cancelRegistration(ctx, req.user!, id, requestMeta(req)) });
  });

  return router;
}
