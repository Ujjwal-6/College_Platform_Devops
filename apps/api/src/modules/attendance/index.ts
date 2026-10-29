/**
 * Public surface of the attendance module, for features that build on who actually came
 * (certificates, feedback, reports). Import from here, not from the module's internals.
 * See docs/attendance-design.md.
 */
export {
  attendedUserIds,
  countForEvent as countAttendance,
  findByRegistration as getAttendanceForRegistration,
} from './repository.js';
export { attendanceReport, type AttendanceReportRow } from './service.js';
export type { AttendanceRecord, CheckInMethod, CheckOutMethod } from './repository.js';
