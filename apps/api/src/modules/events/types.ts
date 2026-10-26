export const EVENT_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'published',
  'closed',
  'cancelled',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const APPROVAL_LEVELS = ['faculty', 'hod', 'admin'] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export type RegistrationMode = 'individual' | 'team';

export type EventAction =
  | 'create'
  | 'update'
  | 'submit'
  | 'withdraw'
  | 'approve'
  | 'reject'
  | 'publish'
  | 'unpublish'
  | 'revise'
  | 'cancel'
  | 'close';

export interface Speaker {
  name: string;
  designation: string | null;
  organization: string | null;
}

export interface CalendarWarningSnapshot {
  id: string;
  type: string;
  title: string;
  startDate: string;
  endDate: string;
}

export interface EventRecord {
  id: string;
  title: string;
  description: string;
  category: string;
  departmentId: string;
  organizerId: string;
  status: EventStatus;
  approvalLevel: ApprovalLevel | null;
  submissionRound: number;
  startAt: Date;
  endAt: Date;
  expectedAttendance: number;
  capacity: number | null;
  registrationMode: RegistrationMode;
  teamSizeMin: number | null;
  teamSizeMax: number | null;
  registrationDeadline: Date | null;
  calendarWarnings: CalendarWarningSnapshot[];
  lastRejection: { level: ApprovalLevel; comment: string; by: string; at: Date } | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  publishedAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
