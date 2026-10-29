/**
 * Public surface of the registrations module, for features that build on it (attendance and
 * check-in, certificates, reports). Import from here, not from the module's internals.
 * See docs/registration-design.md.
 */
export {
  countRegistered,
  findById as getRegistrationById,
  findByEventUser as getRegistrationForUser,
  registeredUserIds,
} from './repository.js';
export type { CancelReason, RegistrationRecord, RegistrationStatus, TeamRecord } from './types.js';
