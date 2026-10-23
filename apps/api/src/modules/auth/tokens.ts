import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Config } from '../../config.js';

type JwtConfig = Pick<
  Config,
  'JWT_SECRET' | 'JWT_ISSUER' | 'JWT_AUDIENCE' | 'ACCESS_TOKEN_TTL_SECONDS'
>;

/**
 * Access tokens are short-lived and carry only the user id. Roles and active status are read from
 * the database on each request, so role changes and deactivation take effect immediately.
 */
export function signAccessToken(config: JwtConfig, userId: string): string {
  return jwt.sign({}, config.JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
  });
}

/** Returns the user id, or null if the token is invalid, expired, or signed with another algorithm. */
export function verifyAccessToken(config: JwtConfig, token: string): string | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });
    return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
