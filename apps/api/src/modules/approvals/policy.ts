import type { AuthUser, Role } from '../auth/types.js';
import { APPROVAL_LEVELS, type ApprovalLevel, type EventRecord } from '../events/types.js';

/** The workflow is strictly Faculty → HOD → Admin. */
export const LEVEL_ORDER = APPROVAL_LEVELS;
export const NEXT_LEVEL: Record<ApprovalLevel, ApprovalLevel | null> = {
  faculty: 'hod',
  hod: 'admin',
  admin: null,
};
export const ROLE_FOR_LEVEL: Record<ApprovalLevel, Role> = {
  faculty: 'faculty',
  hod: 'hod',
  admin: 'admin',
};
/** Faculty and HOD decisions are limited to the event's department; the admin level is institution-wide. */
export const LEVEL_IS_DEPARTMENT_SCOPED: Record<ApprovalLevel, boolean> = {
  faculty: true,
  hod: true,
  admin: false,
};

export type DenyReason = 'wrong_role' | 'wrong_department' | 'own_event' | 'already_decided';

/**
 * May `actor` decide `level` for this event? Every rule must hold at the same time:
 *  - the actor holds the role of that level (a department match alone is not enough),
 *  - for faculty/HOD, the actor belongs to the event's department,
 *  - the actor is not the event's organizer,
 *  - the actor has not already decided another level in this submission round.
 */
export function checkApprover(
  actor: AuthUser,
  event: Pick<EventRecord, 'organizerId' | 'departmentId'>,
  level: ApprovalLevel,
  alreadyDecidedInRound: ReadonlySet<string>,
): { ok: true } | { ok: false; reason: DenyReason } {
  if (!actor.roles.includes(ROLE_FOR_LEVEL[level])) return { ok: false, reason: 'wrong_role' };
  if (LEVEL_IS_DEPARTMENT_SCOPED[level] && actor.departmentId !== event.departmentId)
    return { ok: false, reason: 'wrong_department' };
  if (actor.id === event.organizerId) return { ok: false, reason: 'own_event' };
  if (alreadyDecidedInRound.has(actor.id)) return { ok: false, reason: 'already_decided' };
  return { ok: true };
}

/**
 * Can three different people cover the three levels? (One person may not decide two levels, and a
 * user holding several roles may appear in several lists.) Used before submission so an event is
 * never sent into a workflow that can no longer be completed.
 */
export function canCompleteWorkflow(
  faculty: readonly string[],
  hod: readonly string[],
  admin: readonly string[],
): boolean {
  for (const f of faculty) {
    for (const h of hod) {
      if (h === f) continue;
      if (admin.some((a) => a !== f && a !== h)) return true;
    }
  }
  return false;
}
