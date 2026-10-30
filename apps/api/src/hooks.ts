import type { AppContext } from './context.js';
import { registerAttendanceGuards } from './modules/attendance/hooks.js';
import { registerBookingHooks } from './modules/bookings/hooks.js';
import { registerRegistrationHooks } from './modules/registrations/hooks.js';
import { registerReportHooks } from './modules/reports/hooks.js';

/**
 * Connects the features to the event lifecycle (see docs/event-contract.md). Every process that
 * changes an event's state must call this once at start-up: the API, and the worker (which closes
 * finished events and must queue their reports and release their bookings like the API does).
 */
export function registerEventHooks(ctx: AppContext): void {
  registerBookingHooks(ctx);
  registerRegistrationHooks(ctx);
  registerAttendanceGuards();
  registerReportHooks();
}
