import { createHmac, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Config } from '../../config.js';

/**
 * The check-in code on a gate pass: `EQ1.<payload>.<signature>`. The payload names the registration
 * and the event and says when the pass stops being valid; the signature is an HMAC-SHA256 over
 * `EQ1.<payload>`, so a changed registration, event or expiry is detected. The code proves who the
 * pass was issued to, not that the person holding it is that person: single use (a database
 * constraint on attendance) limits what a shared screenshot can do.
 */
const VERSION = 'EQ1';
const MAX_LENGTH = 600;
const payloadSchema = z
  .object({ r: z.string().uuid(), e: z.string().uuid(), x: z.number().int() })
  .strict();

export interface CheckInClaims {
  registrationId: string;
  eventId: string;
  expiresAt: Date;
}

export type TokenResult =
  ({ ok: true } & CheckInClaims) | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

type KeyConfig = Pick<Config, 'JWT_SECRET' | 'QR_SIGNING_SECRET'>;

function signingKey(config: KeyConfig): Buffer {
  if (config.QR_SIGNING_SECRET) return Buffer.from(config.QR_SIGNING_SECRET, 'utf8');
  // A purpose-specific key derived from the JWT secret (HMAC as a key-derivation function).
  return createHmac('sha256', config.JWT_SECRET).update('college-events:qr-signing:v1').digest();
}

const sign = (config: KeyConfig, signed: string) =>
  createHmac('sha256', signingKey(config)).update(signed).digest();

export function signCheckInToken(config: KeyConfig, claims: CheckInClaims): string {
  const payload = Buffer.from(
    JSON.stringify({
      r: claims.registrationId,
      e: claims.eventId,
      x: Math.floor(claims.expiresAt.getTime() / 1000),
    }),
  ).toString('base64url');
  const signed = `${VERSION}.${payload}`;
  return `${signed}.${sign(config, signed).toString('base64url')}`;
}

export function verifyCheckInToken(
  config: KeyConfig,
  token: string,
  now: Date = new Date(),
): TokenResult {
  if (token.length > MAX_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [, payload, signature] = parts as [string, string, string];

  // The signature is checked before the payload is read at all.
  const given = Buffer.from(signature, 'base64url');
  const expected = sign(config, `${VERSION}.${payload}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let parsed;
  try {
    parsed = payloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  const expiresAt = new Date(parsed.data.x * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, registrationId: parsed.data.r, eventId: parsed.data.e, expiresAt };
}

/** The code as a PNG image (for the screen and for the gate-pass PDF). */
export const qrPng = (text: string): Promise<Buffer> =>
  QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
export const qrDataUrl = (text: string): Promise<string> =>
  QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
