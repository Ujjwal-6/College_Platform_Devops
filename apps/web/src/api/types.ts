export const ROLES = ['student', 'organizer', 'faculty', 'hod', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  departmentId: string | null;
}

export interface ManagedUser extends User {
  isActive: boolean;
  createdAt: string;
}

export interface Department {
  id: string;
  name: string;
}

export type EventStatus =
  'draft' | 'pending_approval' | 'approved' | 'published' | 'closed' | 'cancelled';
export type ApprovalLevel = 'faculty' | 'hod' | 'admin';

export interface EventSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  departmentId: string;
  organizerId: string;
  organizerName: string | null;
  status: EventStatus;
  approvalLevel: ApprovalLevel | null;
  submissionRound: number;
  startAt: string;
  endAt: string;
  expectedAttendance: number;
  capacity: number | null;
  registrationMode: 'individual' | 'team';
  teamSizeMin: number | null;
  teamSizeMax: number | null;
  registrationDeadline: string | null;
  lastRejection: { level: ApprovalLevel; comment: string; by: string; at: string } | null;
  cancelReason: string | null;
  registrationEligible: boolean;
}

export interface CalendarEntry {
  id: string;
  type: 'exam_period' | 'holiday' | 'major_fest' | 'academic_date' | 'other';
  title: string;
  startDate: string;
  endDate: string;
  severity: 'block' | 'warn';
  departmentId: string | null;
  isActive: boolean;
}

export interface EventActions {
  canEdit: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canRevise: boolean;
  canPublish: boolean;
  canUnpublish: boolean;
  canCancel: boolean;
  canClose: boolean;
  canApprove: boolean;
}

export interface EventDetail extends EventSummary {
  speakers: { name: string; designation: string | null; organization: string | null }[];
  calendarWarnings: {
    id: string;
    title: string;
    type: string;
    startDate: string;
    endDate: string;
  }[];
  calendar: { blocks: CalendarEntry[]; warnings: CalendarEntry[] } | null;
  workflow: {
    approvals: {
      id: string;
      round: number;
      level: ApprovalLevel;
      decision: 'approved' | 'rejected';
      approverName: string | null;
      comment: string | null;
      decidedAt: string;
    }[];
    history: {
      id: number;
      action: string;
      actorName: string | null;
      fromStatus: EventStatus | null;
      toStatus: EventStatus | null;
      level: ApprovalLevel | null;
      comment: string | null;
      createdAt: string;
    }[];
  } | null;
  actions: EventActions;
  materialFields: string[];
}
