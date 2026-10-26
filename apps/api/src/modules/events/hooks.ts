import type { Executor } from '../../platform/db.js';
import type { EventAction, EventRecord, EventStatus } from './types.js';

/**
 * Integration point for other features (hall booking, registration, reports).
 *
 * A hook runs inside the same database transaction as the lifecycle change, after the event row was
 * updated. If a hook throws, the whole change is rolled back, so a hook can veto a transition
 * (e.g. registration refusing to unpublish an event that has registrants) or keep its own data
 * consistent (e.g. booking releasing a hall when the event is cancelled).
 *
 * Register hooks once at start-up (see `registerEventHook` usage in app wiring). Hooks must not
 * assume the transition succeeded until the surrounding request returns.
 */
export interface EventTransition {
  /** The event after the change. */
  event: EventRecord;
  previousStatus: EventStatus;
  action: EventAction;
  actorId: string;
}
export type EventHook = (tx: Executor, transition: EventTransition) => Promise<void>;

const hooks = new Set<EventHook>();

/** Returns a function that removes the hook again (used by tests). */
export function registerEventHook(hook: EventHook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

export async function runEventHooks(tx: Executor, transition: EventTransition): Promise<void> {
  for (const hook of hooks) await hook(tx, transition);
}
