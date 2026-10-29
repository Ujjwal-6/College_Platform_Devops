import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  signCheckInToken,
  verifyCheckInToken,
  type CheckInClaims,
} from '../src/modules/attendance/qr.js';
import { testConfig } from './helpers.js';

const config = testConfig();
const claims = (over: Partial<CheckInClaims> = {}): CheckInClaims => ({
  registrationId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
  expiresAt: new Date(Date.now() + 3_600_000),
  ...over,
});
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('check-in code', () => {
  it('round-trips the registration, the event and the expiry', () => {
    const c = claims();
    const result = verifyCheckInToken(config, signCheckInToken(config, c));
    expect(result).toMatchObject({
      ok: true,
      registrationId: c.registrationId,
      eventId: c.eventId,
    });
    expect(result.ok && Math.abs(result.expiresAt.getTime() - c.expiresAt.getTime())).toBeLessThan(
      1000,
    );
  });

  it('is deterministic, so the same pass always shows the same code', () => {
    const c = claims();
    expect(signCheckInToken(config, c)).toBe(signCheckInToken(config, c));
  });

  it('rejects a changed registration, event or expiry (the signature no longer matches)', () => {
    const token = signCheckInToken(config, claims());
    const [version, , signature] = token.split('.') as [string, string, string];
    const swap = (payload: object) => `${version}.${b64(payload)}.${signature}`;
    const forged = [
      swap({ r: '33333333-3333-4333-8333-333333333333', e: claims().eventId, x: 4102444800 }),
      swap({
        r: claims().registrationId,
        e: '33333333-3333-4333-8333-333333333333',
        x: 4102444800,
      }),
      swap({ r: claims().registrationId, e: claims().eventId, x: 4102444800 }),
    ];
    for (const t of forged)
      expect(verifyCheckInToken(config, t)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a changed signature, a different version and obvious junk', () => {
    const token = signCheckInToken(config, claims());
    const [version, payload, signature] = token.split('.') as [string, string, string];
    const flipped = signature.slice(0, -2) + (signature.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyCheckInToken(config, `${version}.${payload}.${flipped}`)).toMatchObject({
      ok: false,
    });
    expect(verifyCheckInToken(config, `EQ2.${payload}.${signature}`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    for (const junk of [
      '',
      'abc',
      'a.b',
      'EQ1..',
      `${version}.${payload}`,
      'x'.repeat(601),
      '{"r":1}',
    ]) {
      expect(verifyCheckInToken(config, junk).ok).toBe(false);
    }
  });

  it('rejects an expired code even though the signature is valid', () => {
    const token = signCheckInToken(config, claims({ expiresAt: new Date(Date.now() - 1000) }));
    expect(verifyCheckInToken(config, token)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyCheckInToken(config, token, new Date(Date.now() - 3_600_000)).ok).toBe(true);
  });

  it('rejects a signed payload that is not a registration claim', () => {
    const signed = `EQ1.${b64({ r: 'not-a-uuid', e: 'x', x: 1 })}`;
    const signature = createHmac('sha256', Buffer.from('does not matter'))
      .update(signed)
      .digest('base64url');
    expect(verifyCheckInToken(config, `${signed}.${signature}`).ok).toBe(false);
  });

  it('does not verify under another secret, and uses a key derived from (not equal to) the JWT secret', () => {
    const token = signCheckInToken(config, claims());
    const other = testConfig({ JWT_SECRET: 'a-completely-different-signing-key-0123456789' });
    expect(verifyCheckInToken(other, token)).toEqual({ ok: false, reason: 'bad_signature' });

    // A signature made directly with the JWT secret is not accepted: the QR key is separate.
    const [version, payload] = token.split('.') as [string, string];
    const direct = createHmac('sha256', config.JWT_SECRET)
      .update(`${version}.${payload}`)
      .digest('base64url');
    expect(verifyCheckInToken(config, `${version}.${payload}.${direct}`)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('uses QR_SIGNING_SECRET when it is set', () => {
    const dedicated = testConfig({ QR_SIGNING_SECRET: 'a-dedicated-qr-key-0123456789abcdefghij' });
    const token = signCheckInToken(dedicated, claims());
    expect(verifyCheckInToken(dedicated, token).ok).toBe(true);
    expect(verifyCheckInToken(config, token)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
