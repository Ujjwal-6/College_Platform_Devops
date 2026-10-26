export const BOOKING_STATUSES = ['pending', 'confirmed', 'rejected', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Two approval steps: the event department's faculty, then its HOD or any admin. */
export const BOOKING_LEVELS = ['faculty', 'hod_admin'] as const;
export type BookingLevel = (typeof BOOKING_LEVELS)[number];

/** A booking that holds its slot (and so participates in the no-overlap constraint). */
export const ACTIVE_STATUSES: readonly BookingStatus[] = ['pending', 'confirmed'];

/**
 * Something the organizer should know before booking. Warnings never refuse a booking: the
 * organizer acknowledges them ("Book anyway") and they are recorded for the approvers.
 */
export interface BookingWarning {
  code: 'CAPACITY' | 'FACILITIES' | 'CALENDAR' | 'EVENT_TIME';
  message: string;
  details?: Record<string, unknown>;
}

export interface Booking {
  id: string;
  eventId: string;
  hallId: string;
  requestedBy: string;
  eventOrganizerId: string;
  departmentId: string;
  startAt: Date;
  endAt: Date;
  requiredFacilities: string[];
  notes: string;
  status: BookingStatus;
  approvalLevel: BookingLevel | null;
  approvalRound: number;
  warnings: BookingWarning[];
  closingComment: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
