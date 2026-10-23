import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppContext } from '../../context.js';
import { errors } from '../../platform/errors.js';
import * as repo from './repository.js';
import { verifyAccessToken } from './tokens.js';
import type { AuthUser, Role } from './types.js';

/** Authenticates the Bearer access token and loads the current user (roles, active flag) from the database. */
export function requireAuth(ctx: AppContext): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw errors.unauthenticated();

    const userId = verifyAccessToken(ctx.config, token);
    if (!userId) throw errors.unauthenticated('Invalid or expired token');

    const user = await repo.findUserById(ctx.pool, userId);
    if (!user || !user.isActive) throw errors.unauthenticated('Invalid or expired token');

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: user.roles,
      departmentId: user.departmentId,
    };
    next();
  };
}

/** Allows the request only if the caller holds at least one of `roles`. Use after requireAuth. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw errors.unauthenticated();
    if (!req.user.roles.some((r) => roles.includes(r))) throw errors.forbidden();
    next();
  };
}

export function hasRole(user: AuthUser, ...roles: Role[]): boolean {
  return user.roles.some((r) => roles.includes(r));
}

/**
 * Scope check for department-bound roles: admins may act on any department; HODs and faculty only
 * on their own. Throws 403 otherwise. Combine with requireRole for "role AND scope" authorization.
 */
export function assertDepartmentScope(user: AuthUser, departmentId: string | null): void {
  if (hasRole(user, 'admin')) return;
  if (
    hasRole(user, 'hod', 'faculty') &&
    departmentId !== null &&
    user.departmentId === departmentId
  )
    return;
  throw errors.forbidden();
}

/** Browsers always send Origin on cross-site POSTs; reject cookie-bearing requests from unknown origins. */
export function requireTrustedOrigin(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (origin && !ctx.config.CORS_ORIGINS.includes(origin))
      throw errors.forbidden('Origin not allowed');
    next();
  };
}
