import type { AppContext } from '../../context.js';
import { withTx } from '../../platform/db.js';
import { AppError, errors } from '../../platform/errors.js';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import {
  burnPasswordCheck,
  hashPassword,
  passwordPolicyViolation,
  verifyPassword,
} from './password.js';
import * as repo from './repository.js';
import { generateRefreshToken, hashToken, signAccessToken } from './tokens.js';
import type { AuthUser } from './types.js';

/** A refresh attempt that failed. `keepCookie` is true for harmless races (grace window), so the browser keeps its newer token. */
export class RefreshRejectedError extends AppError {
  constructor(readonly keepCookie: boolean) {
    super(401, 'INVALID_REFRESH_TOKEN', 'Session expired, please sign in again');
  }
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: AuthUser;
}

function toAuthUser(u: repo.UserRow): AuthUser {
  return { id: u.id, email: u.email, name: u.name, roles: u.roles, departmentId: u.departmentId };
}

async function issueSession(
  ctx: AppContext,
  db: Parameters<typeof repo.insertRefreshToken>[0],
  user: repo.UserRow,
  familyId?: string,
): Promise<Session & { refreshTokenId: string }> {
  const refresh = generateRefreshToken();
  const refreshTokenId = await repo.insertRefreshToken(db, {
    userId: user.id,
    familyId,
    tokenHash: refresh.hash,
    ttlDays: ctx.config.REFRESH_TOKEN_TTL_DAYS,
  });
  return {
    accessToken: signAccessToken(ctx.config, user.id),
    expiresIn: ctx.config.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: refresh.token,
    refreshTokenId,
    user: toAuthUser(user),
  };
}

export async function login(
  ctx: AppContext,
  email: string,
  password: string,
  meta: RequestMeta,
): Promise<Session> {
  const { config, pool } = ctx;
  const user = await repo.findUserByEmail(pool, email);

  // Every failure path returns the same error so callers cannot tell which accounts exist.
  if (!user) {
    await burnPasswordCheck(password, config);
    await recordAudit(pool, {
      action: 'auth.login_failed',
      metadata: { reason: 'unknown_user' },
      ...meta,
    });
    throw errors.invalidCredentials();
  }
  const locked = user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
  if (!user.isActive || locked) {
    await burnPasswordCheck(password, config);
    await recordAudit(pool, {
      actorId: user.id,
      action: 'auth.login_failed',
      targetType: 'user',
      targetId: user.id,
      metadata: { reason: user.isActive ? 'locked' : 'inactive' },
      ...meta,
    });
    throw errors.invalidCredentials();
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    const { locked: nowLocked } = await repo.recordFailedLogin(
      pool,
      user.id,
      config.LOGIN_LOCKOUT_THRESHOLD,
      config.LOGIN_LOCKOUT_MINUTES,
    );
    await recordAudit(pool, {
      actorId: user.id,
      action: 'auth.login_failed',
      targetType: 'user',
      targetId: user.id,
      metadata: { reason: 'bad_password', lockedNow: nowLocked },
      ...meta,
    });
    throw errors.invalidCredentials();
  }

  return withTx(pool, async (tx) => {
    await repo.resetFailedLogins(tx, user.id);
    const session = await issueSession(ctx, tx, user);
    await recordAudit(tx, {
      actorId: user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      ...meta,
    });
    return session;
  });
}

type RefreshOutcome = { ok: true; session: Session } | { ok: false; keepCookie?: boolean };

/**
 * Rotates a refresh token. Each token works once: using it returns a new token in the same family.
 * Presenting an already-rotated token after the grace window is treated as theft and revokes the
 * whole family.
 */
export async function refresh(
  ctx: AppContext,
  presented: string,
  meta: RequestMeta,
): Promise<Session> {
  const { config, pool } = ctx;
  const outcome = await withTx(pool, async (tx): Promise<RefreshOutcome> => {
    const token = await repo.lockRefreshTokenByHash(tx, hashToken(presented));
    if (!token || token.revokedAt) return { ok: false };

    if (token.rotatedAt) {
      const age = await repo.secondsSinceRotation(tx, token.id);
      if (age > config.REFRESH_REUSE_GRACE_SECONDS) {
        await repo.revokeFamily(tx, token.familyId);
        await recordAudit(tx, {
          actorId: token.userId,
          action: 'auth.refresh_reuse_detected',
          targetType: 'user',
          targetId: token.userId,
          ...meta,
        });
        return { ok: false };
      }
      return { ok: false, keepCookie: true };
    }
    if (token.expiresAt.getTime() <= Date.now()) return { ok: false };

    const user = await repo.findUserById(tx, token.userId);
    if (!user || !user.isActive) {
      await repo.revokeFamily(tx, token.familyId);
      return { ok: false };
    }
    const session = await issueSession(ctx, tx, user, token.familyId);
    await repo.markRotated(tx, token.id, session.refreshTokenId);
    return { ok: true, session };
  });
  if (!outcome.ok) throw new RefreshRejectedError(outcome.keepCookie ?? false);
  return outcome.session;
}

export async function logout(
  ctx: AppContext,
  presented: string | undefined,
  meta: RequestMeta,
): Promise<void> {
  if (!presented) return;
  await withTx(ctx.pool, async (tx) => {
    const token = await repo.lockRefreshTokenByHash(tx, hashToken(presented));
    if (!token) return;
    await repo.revokeFamily(tx, token.familyId);
    await recordAudit(tx, {
      actorId: token.userId,
      action: 'auth.logout',
      targetType: 'user',
      targetId: token.userId,
      ...meta,
    });
  });
}

export async function changePassword(
  ctx: AppContext,
  userId: string,
  currentPassword: string,
  newPassword: string,
  meta: RequestMeta,
): Promise<void> {
  const user = await repo.findUserById(ctx.pool, userId);
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw errors.invalidCredentials();
  }
  const violation = passwordPolicyViolation(newPassword, user.email);
  if (violation) throw errors.validation([{ path: 'newPassword', message: violation }]);

  const hash = await hashPassword(newPassword, ctx.config);
  await withTx(ctx.pool, async (tx) => {
    await repo.updatePasswordHash(tx, userId, hash);
    await repo.revokeAllForUser(tx, userId); // every session must sign in again
    await recordAudit(tx, {
      actorId: userId,
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: userId,
      ...meta,
    });
  });
}
