export const REGISTRATION_STATUSES = ['registered', 'waitlisted', 'cancelled'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** Why a registration ended: the person left, or the event was cancelled under them. */
export type CancelReason = 'self' | 'event_cancelled';

export interface RegistrationRecord {
  id: string;
  eventId: string;
  userId: string;
  teamId: string | null;
  status: RegistrationStatus;
  cancelReason: CancelReason | null;
  registeredAt: Date;
  /** Set while (and after) the person was on the waiting list; the queue is ordered by it. */
  waitlistedAt: Date | null;
  cancelledAt: Date | null;
}

export interface TeamRecord {
  id: string;
  eventId: string;
  name: string;
  leaderId: string;
  status: 'active' | 'dissolved';
  /** Only the hash is stored; the code itself is shown once. */
  invitationHash: string | null;
  invitationExpiresAt: Date | null;
}
