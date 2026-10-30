export interface Budgetish {
  estimateMinor: number;
  actualMinor: number;
}
export interface EventRow {
  id: string;
  title: string;
  status: 'published' | 'closed';
  startAt: string;
  department: { id: string; name: string };
  organizer: string;
  registered: number;
  checkedIn: number;
  ratePercent: number | null;
  noShows: number | null;
  feedbackCount: number;
  feedbackAverage: number | null;
  certificates: number;
  budget: (Budgetish & { overBudget: boolean }) | null;
}
export interface Totals {
  events: number;
  registered: number;
  checkedIn: number;
  ratePercent: number | null;
  feedbackCount: number;
  feedbackAverage: number | null;
  certificates: number;
  budget: Budgetish & { overBudgetEvents: number };
}
export interface HallUsage {
  id: string;
  name: string;
  capacity: number;
  bookings: number;
  bookedHours: number;
  availableHours: number;
  utilizationPercent: number;
}
export interface Summary {
  period: { from: string; to: string; days: number };
  scope: { departmentId: string | null };
  truncated: boolean;
  totals: Totals;
  events: EventRow[];
  departments: ({ id: string; name: string } & Totals)[];
  registrationsPerDay: { date: string; count: number }[];
  halls: HallUsage[] | null;
}
export interface EventAnalyticsData {
  registrations: {
    registered: number;
    perDay: { date: string; count: number; cumulative: number }[];
  };
  attendance: {
    checkedIn: number;
    ratePercent: number | null;
    noShows: number | null;
    completed: number;
  };
  feedback: { count: number; average: number | null; distribution: number[] };
  certificates: { issued: number };
  budget: { estimateMinor: number; actualMinor: number; overBudget: boolean } | null;
}
