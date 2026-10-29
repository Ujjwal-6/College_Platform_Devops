import type { EventSummary } from './types';

export interface RegistrationView {
  id: string;
  eventId: string;
  status: 'registered' | 'waitlisted' | 'cancelled';
  cancelReason: 'self' | 'event_cancelled' | null;
  registeredAt: string;
  cancelledAt: string | null;
  /** 1 = next in line; null unless the person is waiting. */
  waitlistPosition: number | null;
  team: { id: string; name: string; isLeader: boolean; status: 'active' | 'dissolved' } | null;
}

export interface RegistrationSummary {
  eventId: string;
  registrationMode: 'individual' | 'team';
  capacity: number | null;
  registered: number;
  seatsLeft: number | null;
  open: boolean;
  full: boolean;
  waitlisted: number;
  waitlistOpen: boolean;
  mine: RegistrationView | null;
}

export interface TeamView {
  id: string;
  eventId: string;
  name: string;
  status: 'active' | 'dissolved';
  leader: { id: string; name: string };
  size: number;
  minSize: number | null;
  maxSize: number | null;
  complete: boolean;
  members: { userId: string; name: string; registrationId: string; isLeader: boolean }[];
  invitation?: { active: boolean; expiresAt: string | null };
}

export interface Registrant extends RegistrationView {
  user: { id: string; name: string; email: string };
}

export interface MyRegistration extends RegistrationView {
  event: Pick<EventSummary, 'id' | 'title' | 'startAt' | 'endAt' | 'status'> | null;
}

/** A fresh key per user action: repeating that same request (a retry) is then safe on the server. */
export const newIdempotencyKey = (): string => globalThis.crypto.randomUUID();
