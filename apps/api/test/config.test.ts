import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRET: 'a-long-random-signing-key-that-is-at-least-32-chars',
};

describe('loadConfig', () => {
  it('accepts a valid environment and applies safe defaults', () => {
    const c = loadConfig(valid);
    expect(c.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(c.COOKIE_SECURE).toBe(false);
    expect(c.CORS_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('enables secure cookies by default in production', () => {
    expect(loadConfig({ ...valid, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
  });

  it('fails fast when the JWT secret is missing, short, or a placeholder', () => {
    expect(() => loadConfig({ DATABASE_URL: valid.DATABASE_URL })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
    expect(() =>
      loadConfig({ ...valid, JWT_SECRET: 'change-me-change-me-change-me-change-me' }),
    ).toThrow(/placeholder/);
  });

  it('fails when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ JWT_SECRET: valid.JWT_SECRET })).toThrow(/DATABASE_URL/);
  });

  it('never includes secret values in error messages', () => {
    const secret = 'short-secret-value';
    try {
      loadConfig({ ...valid, JWT_SECRET: secret });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('splits multiple CORS origins', () => {
    expect(
      loadConfig({ ...valid, CORS_ORIGINS: 'http://a.test, http://b.test' }).CORS_ORIGINS,
    ).toEqual(['http://a.test', 'http://b.test']);
  });

  it('treats an empty METRICS_TOKEN as "metrics off" and refuses a short one', () => {
    expect(loadConfig({ ...valid, METRICS_TOKEN: '' }).METRICS_TOKEN).toBeUndefined();
    expect(loadConfig(valid).METRICS_TOKEN).toBeUndefined();
    expect(loadConfig({ ...valid, METRICS_TOKEN: 'a-token-of-16-chars' }).METRICS_TOKEN).toBe(
      'a-token-of-16-chars',
    );
    expect(() => loadConfig({ ...valid, METRICS_TOKEN: 'short' })).toThrow(ConfigError);
  });

  it('has sensible defaults for automatic closing and password reset', () => {
    const c = loadConfig(valid);
    expect(c.EVENT_AUTO_CLOSE_HOURS).toBe(24);
    expect(c.PASSWORD_RESET_TTL_MINUTES).toBe(60);
    expect(c.WORKER_METRICS_PORT).toBe(0);
    expect(() => loadConfig({ ...valid, EVENT_AUTO_CLOSE_HOURS: '-1' })).toThrow(ConfigError);
  });
});
