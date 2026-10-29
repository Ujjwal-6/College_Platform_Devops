export interface MyPass {
  token: string;
  expiresAt: string;
  /** The QR code as a PNG data URL. */
  qrImage: string;
  gatePassReady: boolean;
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

export interface CheckInResult {
  attendanceId: string;
  registrationId: string;
  attendee: { id: string; name: string };
  team: string | null;
  method: 'qr' | 'manual' | 'walk_in';
  checkedInAt: string;
  counts: { registered: number; checkedIn: number; inside: number };
}

export interface CheckOutResult {
  attendanceId: string;
  registrationId: string;
  attendee: { id: string; name: string };
  team: string | null;
  method: 'qr' | 'manual';
  checkedInAt: string;
  checkedOutAt: string;
  stayedMinutes: number;
  /** Left more than 15 minutes before the end. */
  leftEarly: boolean;
  counts: { registered: number; checkedIn: number; inside: number };
}

export interface AttendanceSettings {
  allowWalkIns: boolean;
  requireCheckOut: boolean;
  /** Walk-ins may take seats beyond the seat limit. */
  walkInsOverCapacity: boolean;
}

export interface AttendanceSummary {
  registered: number;
  checkedIn: number;
  remaining: number;
  inside: number;
  checkedOut: number;
  completed: number;
  open: boolean;
  checkOutOpen: boolean;
  opensAt: string;
  closesAt: string;
  checkOutClosesAt: string;
  settings: AttendanceSettings;
}

export interface AttendanceRow {
  id: string;
  registrationId: string;
  attendee: { id: string; name: string };
  checkedInBy: string;
  method: 'qr' | 'manual' | 'walk_in';
  reason: string | null;
  checkedInAt: string;
  checkedOutAt: string | null;
  checkedOutBy: string | null;
  checkOutMethod: 'qr' | 'manual' | null;
  checkOutReason: string | null;
  /** null while the person is still inside. */
  leftEarly: boolean | null;
}

export interface Volunteer {
  userId: string;
  name: string;
  email: string;
  assignedAt: string;
}

export interface CheckInEvent {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  role: 'admin' | 'organizer' | 'volunteer';
}
