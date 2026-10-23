import { Router, type CookieOptions, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { errors } from '../../platform/errors.js';
import { parse } from '../../platform/validate.js';
import type { RequestMeta } from '../audit/audit.js';
import { requireAuth, requireTrustedOrigin } from './middleware.js';
import { PASSWORD_MAX_LENGTH } from './password.js';
import * as service from './service.js';

const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/auth';

const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export function requestMeta(req: { id?: unknown; ip?: string }): RequestMeta {
  return { requestId: typeof req.id === 'string' ? req.id : undefined, ip: req.ip };
}

export function authRoutes(ctx: AppContext): Router {
  const { config } = ctx;
  const router = Router();
  const auth = requireAuth(ctx);
  const trustedOrigin = requireTrustedOrigin(ctx);

  const cookieOptions = (): CookieOptions => ({
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: COOKIE_PATH,
  });
  const setRefreshCookie = (res: Response, token: string) =>
    res.cookie(REFRESH_COOKIE, token, {
      ...cookieOptions(),
      maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    });

  const loginLimiter = rateLimit({
    windowMs: config.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.LOGIN_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(errors.tooManyRequests('Too many login attempts, try again later')),
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const body = parse(loginSchema, req.body);
    const session = await service.login(ctx, body.email, body.password, requestMeta(req));
    setRefreshCookie(res, session.refreshToken);
    res.json({
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    });
  });

  router.post('/refresh', trustedOrigin, async (req, res) => {
    const presented: unknown = req.cookies?.[REFRESH_COOKIE];
    if (typeof presented !== 'string' || presented.length === 0) throw errors.invalidRefreshToken();
    try {
      const session = await service.refresh(ctx, presented, requestMeta(req));
      setRefreshCookie(res, session.refreshToken);
      res.json({
        accessToken: session.accessToken,
        expiresIn: session.expiresIn,
        user: session.user,
      });
    } catch (err) {
      // Keep the cookie when the rejection was only a race with another tab that already rotated it.
      if (!(err instanceof service.RefreshRejectedError && err.keepCookie)) {
        res.clearCookie(REFRESH_COOKIE, cookieOptions());
      }
      throw err;
    }
  });

  router.post('/logout', trustedOrigin, async (req, res) => {
    const presented: unknown = req.cookies?.[REFRESH_COOKIE];
    await service.logout(
      ctx,
      typeof presented === 'string' ? presented : undefined,
      requestMeta(req),
    );
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    res.status(204).end();
  });

  router.get('/me', auth, (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/change-password', auth, async (req, res) => {
    const body = parse(changePasswordSchema, req.body);
    await service.changePassword(
      ctx,
      req.user!.id,
      body.currentPassword,
      body.newPassword,
      requestMeta(req),
    );
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    res.status(204).end();
  });

  return router;
}
