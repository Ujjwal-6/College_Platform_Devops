import type { AuthUser } from '../auth/types.js';
import type { Booking, BookingLevel } from './types.js';

export const NEXT_LEVEL: Record<BookingLevel, BookingLevel | null> = {
  faculty: 'hod_admin',
  hod_admin: null,
};
export const LEVEL_LABEL: Record<BookingLevel, string> = {
  faculty: 'Faculty',
  hod_admin: 'HOD or Admin',
};

export type DenyReason = 'wrong_role' | 'wrong_department' | 'own_booking' | 'already_decided';

type Subject = Pick<Booking, 'departmentId' | 'requestedBy' | 'eventOrganizerId'>;

/**
 * May `actor` decide `level` of this booking?
 *  - faculty step: a faculty member of the event's department;
 *  - second step: the HOD of the event's department, or any admin;
 *  - never the person who requested the booking or the event's organizer;
 *  - never someone who already decided the other step of this round.
 */
export function checkBookingApprover(
  actor: AuthUser,
  booking: Subject,
  level: BookingLevel,
  alreadyDecidedInRound: ReadonlySet<string>,
): { ok: true } | { ok: false; reason: DenyReason } {
  const inDepartment = actor.departmentId !== null && actor.departmentId === booking.departmentId;
  if (level === 'faculty') {
    if (!actor.roles.includes('faculty')) return { ok: false, reason: 'wrong_role' };
    if (!inDepartment) return { ok: false, reason: 'wrong_department' };
  } else {
    const isAdmin = actor.roles.includes('admin');
    const isDepartmentHod = actor.roles.includes('hod');
    if (!isAdmin && !isDepartmentHod) return { ok: false, reason: 'wrong_role' };
    if (!isAdmin && !inDepartment) return { ok: false, reason: 'wrong_department' };
  }
  if (actor.id === booking.requestedBy || actor.id === booking.eventOrganizerId) {
    return { ok: false, reason: 'own_booking' };
  }
  if (alreadyDecidedInRound.has(actor.id)) return { ok: false, reason: 'already_decided' };
  return { ok: true };
}

/** Can two different people cover the two steps? Checked before a booking is accepted. */
export function canCompleteBookingApproval(
  faculty: readonly string[],
  hodAdmin: readonly string[],
): boolean {
  return faculty.some((f) => hodAdmin.some((h) => h !== f));
}

/** Booking visibility: admins, the event's organizer, the requester, and faculty/HOD of the event's department. */
export function canSeeBooking(actor: AuthUser, b: Subject): boolean {
  if (actor.roles.includes('admin')) return true;
  if (actor.id === b.eventOrganizerId || actor.id === b.requestedBy) return true;
  return (
    actor.departmentId !== null &&
    actor.departmentId === b.departmentId &&
    actor.roles.some((r) => r === 'faculty' || r === 'hod')
  );
}
