import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { loadConfig, loadDotEnv, type Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { hashPassword } from '../src/modules/auth/password.js';
import * as authRepo from '../src/modules/auth/repository.js';
import type { Role } from '../src/modules/auth/types.js';
import * as usersRepo from '../src/modules/users/repository.js';
import { createPool, withTx } from '../src/platform/db.js';
import { createLogger } from '../src/platform/logger.js';
import { MemoryMailer } from '../src/platform/mailer.js';
import { LocalFileStorage } from '../src/platform/storage/index.js';

loadDotEnv();

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export interface TestApp {
  app: Express;
  ctx: AppContext;
  mailer: MemoryMailer;
  close: () => Promise<void>;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'events-storage-'));
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    JWT_SECRET: 'vitest-only-signing-key-0123456789abcdefghij',
    PASSWORD_HASH_MEMORY_KIB: '1024', // cheap hashing keeps tests fast; production default is 19456
    PASSWORD_HASH_TIME_COST: '1',
    LOGIN_RATE_LIMIT_MAX: '1000',
    STORAGE_DIR: storageDir,
    ...overrides,
  });
}

export function buildTestApp(overrides: Record<string, string> = {}): TestApp {
  const config = testConfig(overrides);
  const mailer = new MemoryMailer();
  const ctx: AppContext = {
    config,
    pool: createPool(config.DATABASE_URL),
    logger: createLogger(config),
    mailer,
    storage: new LocalFileStorage(config.STORAGE_DIR),
  };
  return {
    app: createApp(ctx),
    ctx,
    mailer,
    close: async () => {
      await ctx.pool.end();
      rmSync(config.STORAGE_DIR, { recursive: true, force: true });
    },
  };
}

export async function resetDb(ctx: AppContext): Promise<void> {
  await ctx.pool.query(
    'TRUNCATE jobs, audit_log, refresh_tokens, user_roles, users, departments RESTART IDENTITY CASCADE',
  );
}

let counter = 0;
export async function createTestDepartment(
  ctx: AppContext,
  name = `Dept ${++counter}`,
): Promise<string> {
  const { rows } = await ctx.pool.query('INSERT INTO departments (name) VALUES ($1) RETURNING id', [
    name,
  ]);
  return rows[0].id as string;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  roles: Role[];
  departmentId: string | null;
}

export async function createTestUser(
  ctx: AppContext,
  opts: {
    roles?: Role[];
    departmentId?: string | null;
    email?: string;
    active?: boolean;
    password?: string;
  } = {},
): Promise<TestUser> {
  const roles = opts.roles ?? ['student'];
  const password = opts.password ?? TEST_PASSWORD;
  const email = opts.email ?? `user${++counter}@college.test`;
  const departmentId = opts.departmentId ?? null;
  const passwordHash = await hashPassword(password, ctx.config);
  const id = await withTx(ctx.pool, async (tx) => {
    const userId = await usersRepo.insert(tx, {
      email,
      name: `Test ${roles.join('+')}`,
      passwordHash,
      departmentId,
    });
    await usersRepo.setRoles(tx, userId, roles);
    if (opts.active === false) await usersRepo.setActive(tx, userId, false);
    return userId;
  });
  return { id, email, password, roles, departmentId };
}

export interface LoggedIn {
  accessToken: string;
  refreshCookie: string; // "refresh_token=..." ready for a Cookie header
  user: TestUser;
}

export function extractRefreshCookie(setCookie: string[] | string | undefined): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const entry = list.find((c) => c.startsWith('refresh_token='));
  return entry?.split(';')[0];
}

export async function loginAs(t: TestApp, user: TestUser): Promise<LoggedIn> {
  const res = await request(t.app)
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });
  if (res.status !== 200)
    throw new Error(`login failed in test helper: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    accessToken: res.body.accessToken as string,
    refreshCookie: extractRefreshCookie(res.headers['set-cookie'])!,
    user,
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export { authRepo };
