import type { Executor } from '../../platform/db.js';
import type { RegistrationRecord } from './types.js';

/**
 * Lets another feature stop a registration from being cancelled (for example attendance: a person
 * who has been checked in keeps their place). A guard runs inside the cancel transaction, after the
 * event is locked, and throws an AppError to refuse. Register guards once at start-up.
 */
export type CancelGuard = (db: Executor, registration: RegistrationRecord) => Promise<void>;

const guards = new Set<CancelGuard>();

/** Returns a function that removes the guard again (used by tests). */
export function registerCancelGuard(guard: CancelGuard): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

export async function runCancelGuards(db: Executor, registration: RegistrationRecord) {
  for (const guard of guards) await guard(db, registration);
}
