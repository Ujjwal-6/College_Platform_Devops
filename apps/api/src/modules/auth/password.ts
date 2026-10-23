import argon2 from 'argon2';
import type { Config } from '../../config.js';

const COMMON_PASSWORDS = new Set([
  'password1234',
  'password12345',
  '123456789012',
  'qwertyuiop12',
  'iloveyou1234',
  'administrator',
  'welcome12345',
  'letmein12345',
  'changeme1234',
  'passw0rd1234',
  'collegeevents',
  'college12345',
  'student12345',
  '111111111111',
  '000000000000',
]);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Returns a reason string if the password is unacceptable, otherwise null. */
export function passwordPolicyViolation(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH)
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'Password is too common';
  if (email && lower.includes(email.toLowerCase().split('@')[0] ?? '\u0000')) {
    return 'Password must not contain your email name';
  }
  if (new Set(lower).size < 5) return 'Password is too repetitive';
  return null;
}

type HashConfig = Pick<Config, 'PASSWORD_HASH_MEMORY_KIB' | 'PASSWORD_HASH_TIME_COST'>;

export function hashPassword(password: string, config: HashConfig): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: config.PASSWORD_HASH_MEMORY_KIB,
    timeCost: config.PASSWORD_HASH_TIME_COST,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against a throw-away hash so login takes similar time whether or not the email exists
 * (prevents account enumeration by timing).
 */
export async function burnPasswordCheck(password: string, config: HashConfig): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-account-password', config);
  await verifyPassword(await dummyHash, password);
}
