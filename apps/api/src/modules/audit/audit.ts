import type { Executor } from '../../platform/db.js';

export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.refresh_reuse_detected',
  'auth.password_changed',
  'user.created',
  'user.updated',
  'user.roles_changed',
  'user.deactivated',
  'user.activated',
  'department.created',
  'calendar.entry_created',
  'calendar.entry_updated',
  'calendar.entry_deleted',
  'event.created',
  'event.updated',
  'event.submitted',
  'event.withdrawn',
  'event.approval_granted',
  'event.approval_rejected',
  'event.published',
  'event.unpublished',
  'event.revised',
  'event.cancelled',
  'event.closed',
  'hall.created',
  'hall.updated',
  'resource.created',
  'resource.updated',
  'resource.reserved',
  'resource.reservation_updated',
  'resource.released',
  'booking.requested',
  'booking.updated',
  'booking.approval_granted',
  'booking.approval_rejected',
  'booking.cancelled',
  'job.retried',
  'registration.created',
  'attendance.checked_in',
  'certificate.issued',
  'certificate.issue_requested',
  'certificate.regenerated',
  'certificate.revoked',
  'certificate.reinstated',
  'certificate.template_changed',
  'report.requested',
  'report.generated',
  'report.failed',
  'report.photo_added',
  'report.photo_removed',
  'report.outcomes_saved',
  'feedback.submitted',
  'attendance.manual_check_in',
  'attendance.walk_in',
  'attendance.checked_out',
  'attendance.manual_check_out',
  'attendance.settings_changed',
  'volunteer.assigned',
  'volunteer.removed',
  'registration.waitlisted',
  'registration.promoted',
  'registration.cancelled',
  'team.created',
  'team.leader_changed',
  'team.dissolved',
  'team.invitation_regenerated',
  'team.invitation_revoked',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  actorId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  /** Small, non-sensitive facts (ids, old/new roles). Never put passwords, tokens or secrets here. */
  metadata?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
}

/**
 * Appends one audit record. Pass the active transaction client so the record commits (or rolls
 * back) together with the change it describes.
 */
export async function recordAudit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, metadata, request_id, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.actorId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.requestId ?? null,
      entry.ip ?? null,
    ],
  );
}

/** Request details every audited action should carry. */
export interface RequestMeta {
  requestId?: string;
  ip?: string;
}
