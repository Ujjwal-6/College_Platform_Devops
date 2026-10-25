import type { AuthUser } from '../auth/types.js';
import type { EventAction, EventRecord, EventStatus } from './types.js';

/**
 * The event lifecycle. This table is the single source of truth for which action may run in which
 * state. Approval and rejection are not listed here: they stay inside `pending_approval`
 * (approve moves to the next level, or to `approved` after the final level) and are governed by
 * the approvals module.
 *
 *   draft ──submit──▶ pending_approval ──(faculty → hod → admin)──▶ approved ──publish──▶ published ──close──▶ closed
 *     ▲                    │  │                                         │  ▲                  │
 *     └──withdraw/reject───┘  └──────────────cancel──────▶ cancelled ◀──┘  └──unpublish──────┘
 *     └──────────────revise (from approved or published)─────────────────────────────────────
 */
export const TRANSITIONS = {
  submit: { from: ['draft'], to: 'pending_approval' },
  withdraw: { from: ['pending_approval'], to: 'draft' },
  reject: { from: ['pending_approval'], to: 'draft' },
  publish: { from: ['approved'], to: 'published' },
  unpublish: { from: ['published'], to: 'approved' },
  revise: { from: ['approved', 'published'], to: 'draft' },
  cancel: { from: ['draft', 'pending_approval', 'approved', 'published'], to: 'cancelled' },
  close: { from: ['published'], to: 'closed' },
} as const satisfies Partial<
  Record<EventAction, { from: readonly EventStatus[]; to: EventStatus }>
>;

/**
 * Changing these on an approved or published event changes what was approved, so it requires an
 * explicit "revise" (back to draft, then re-approval). Everything else (title, description,
 * speakers, registration deadline) can be corrected in place and is audited.
 */
export const MATERIAL_FIELDS = [
  'startAt',
  'endAt',
  'departmentId',
  'category',
  'capacity',
  'expectedAttendance',
  'registrationMode',
  'teamSizeMin',
  'teamSizeMax',
] as const;
export type MaterialField = (typeof MATERIAL_FIELDS)[number];

const hasRole = (u: AuthUser, ...roles: AuthUser['roles']) =>
  u.roles.some((r) => roles.includes(r));

export const isAdmin = (u: AuthUser) => hasRole(u, 'admin');
export const isOwner = (u: AuthUser, e: Pick<EventRecord, 'organizerId'>) => e.organizerId === u.id;

/** Who may create events: student heads (organizer role), faculty, HODs and admins. */
export const canCreateEvents = (u: AuthUser) => hasRole(u, 'organizer', 'faculty', 'hod', 'admin');

/** Faculty and HODs of the event's department. (A department match alone never grants approval rights.) */
export const isDepartmentStaff = (u: AuthUser, e: Pick<EventRecord, 'departmentId'>) =>
  hasRole(u, 'faculty', 'hod') && u.departmentId !== null && u.departmentId === e.departmentId;

/**
 * Visibility rules. Drafts are private to the owner and admins. Published and closed events are
 * visible to every signed-in user. Everything else is visible to the owner, admins, and the
 * faculty/HODs of the event's department.
 */
export function canView(u: AuthUser, e: EventRecord): boolean {
  if (isAdmin(u) || isOwner(u, e)) return true;
  if (e.status === 'published' || e.status === 'closed') return true;
  return e.status !== 'draft' && isDepartmentStaff(u, e);
}

/** Approval history and comments are internal: owner, admins and department staff only. */
export const canViewWorkflow = (u: AuthUser, e: EventRecord) =>
  isAdmin(u) || isOwner(u, e) || isDepartmentStaff(u, e);

/**
 * Contract for the registration feature: an event accepts registrations only while it is
 * published and the registration deadline (default: the start time) has not passed.
 * Capacity and duplicate checks are the registration feature's own job.
 */
export function isEligibleForRegistration(
  e: Pick<EventRecord, 'status' | 'startAt' | 'registrationDeadline'>,
  now = new Date(),
): boolean {
  if (e.status !== 'published') return false;
  return now < (e.registrationDeadline ?? e.startAt);
}
