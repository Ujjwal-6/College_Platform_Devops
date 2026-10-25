import type { PoolClient } from 'pg';
import { recordAudit, type AuditAction, type RequestMeta } from '../audit/audit.js';
import type { AuthUser } from '../auth/types.js';
import { runEventHooks } from './hooks.js';
import * as repo from './repository.js';
import type { ApprovalLevel, EventAction, EventRecord, EventStatus } from './types.js';

export interface TransitionInput {
  event: EventRecord;
  action: EventAction;
  to: EventStatus;
  actor: AuthUser;
  meta: RequestMeta;
  audit: AuditAction;
  /** Extra columns to write together with the status change. */
  set?: Partial<repo.EventColumns>;
  level?: ApprovalLevel;
  comment?: string | null;
  auditMetadata?: Record<string, unknown>;
}

/**
 * Applies one lifecycle change inside the caller's transaction: writes the new state, the timeline
 * entry, the audit record, and then runs integration hooks. The caller must already hold the event
 * row lock (getById(..., true)) and have checked permissions and preconditions.
 */
export async function applyTransition(tx: PoolClient, t: TransitionInput): Promise<EventRecord> {
  await repo.patch(tx, t.event.id, {
    ...t.set,
    status: t.to,
    // The level is meaningful only while waiting for approval (a database constraint enforces this).
    approvalLevel:
      t.to === 'pending_approval' ? (t.set?.approvalLevel ?? t.event.approvalLevel) : null,
  });
  await repo.addHistory(tx, {
    eventId: t.event.id,
    action: t.action,
    actorId: t.actor.id,
    fromStatus: t.event.status,
    toStatus: t.to,
    level: t.level,
    comment: t.comment,
  });
  await recordAudit(tx, {
    actorId: t.actor.id,
    action: t.audit,
    targetType: 'event',
    targetId: t.event.id,
    metadata: {
      from: t.event.status,
      to: t.to,
      ...(t.level ? { level: t.level } : {}),
      ...t.auditMetadata,
    },
    ...t.meta,
  });
  const updated = (await repo.getById(tx, t.event.id))!;
  await runEventHooks(tx, {
    event: updated,
    previousStatus: t.event.status,
    action: t.action,
    actorId: t.actor.id,
  });
  return updated;
}
