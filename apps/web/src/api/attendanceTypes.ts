export interface MyPass {
  token: string;
  expiresAt: string;
  /** The QR code as a PNG data URL. */
  qrImage: string;
  gatePassReady: boolean;
  checkedInAt: string | null;
}

export interface CheckInResult {
  attendanceId: string;
  registrationId: string;
  attendee: { id: string; name: string };
  team: string | null;
  method: 'qr' | 'manual';
  checkedInAt: string;
  counts: { registered: number; checkedIn: number };
}

export interface AttendanceSummary {
  registered: number;
  checkedIn: number;
  remaining: number;
  open: boolean;
  opensAt: string;
  closesAt: string;
}

export interface AttendanceRow {
  id: string;
  registrationId: string;
  attendee: { id: string; name: string };
  checkedInBy: string;
  method: 'qr' | 'manual';
  reason: string | null;
  checkedInAt: string;
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
