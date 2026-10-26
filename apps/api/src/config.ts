import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .refine(
      (v) => !/^(change[-_ ]?me|secret|password)/i.test(v),
      'JWT_SECRET looks like a placeholder',
    ),
  JWT_ISSUER: z.string().default('college-events'),
  JWT_AUDIENCE: z.string().default('college-events-web'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  // A rotated refresh token presented again within this window is rejected but does not revoke
  // the whole token family (covers two browser tabs refreshing at once). 0 disables the grace.
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(60).default(5),

  // Calendar dates (exam periods, holidays) are interpreted in this IANA time zone (ASM-2).
  APP_TIMEZONE: z
    .string()
    .default('Asia/Kolkata')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'APP_TIMEZONE must be a valid IANA time zone'),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: bool.optional(),
  WEB_BASE_URL: z.string().default('http://localhost:5173'),

  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
  LOGIN_LOCKOUT_THRESHOLD: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

  // Argon2id cost. Defaults follow the OWASP minimum recommendation (19 MiB, t=2, p=1).
  PASSWORD_HASH_MEMORY_KIB: z.coerce.number().int().min(1024).default(19456),
  PASSWORD_HASH_TIME_COST: z.coerce.number().int().min(1).default(2),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('College Events <no-reply@events.local>'),

  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(10 * 1024 * 1024),

  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  JOB_LOCK_SECONDS: z.coerce.number().int().min(5).default(300),
  JOB_BACKOFF_BASE_SECONDS: z.coerce.number().int().min(1).default(30),
});

export type Config = Omit<z.infer<typeof schema>, 'COOKIE_SECURE' | 'TRUST_PROXY'> & {
  COOKIE_SECURE: boolean;
  TRUST_PROXY: boolean;
};

export class ConfigError extends Error {}

/**
 * Validates environment variables. Error messages name the offending variables but never include
 * their values, so a bad secret cannot leak into logs.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const data = parsed.data;
  return {
    ...data,
    COOKIE_SECURE: data.COOKIE_SECURE ?? data.NODE_ENV === 'production',
    TRUST_PROXY: data.TRUST_PROXY ?? false,
  };
}

/** Loads the first `.env` found in the working directory or the repository root (never overrides real env vars). */
export function loadDotEnv(): void {
  for (const candidate of [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
  ]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}
