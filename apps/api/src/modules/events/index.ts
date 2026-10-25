/**
 * Public surface of the events module: the contract other features (hall booking, registration,
 * attendance, reports) build against. Import from here, not from the module's internals.
 * See docs/event-contract.md.
 */
export { registerEventHook, type EventHook, type EventTransition } from './hooks.js';
export {
  canView,
  canViewWorkflow,
  isEligibleForRegistration,
  MATERIAL_FIELDS,
  TRANSITIONS,
} from './lifecycle.js';
export { getById as getEventById, getSpeakers as getEventSpeakers } from './repository.js';
export { APPROVAL_LEVELS, EVENT_STATUSES } from './types.js';
export type {
  ApprovalLevel,
  EventAction,
  EventRecord,
  EventStatus,
  RegistrationMode,
  Speaker,
} from './types.js';
export { checkRange, type CalendarCheck } from '../calendar/service.js';
