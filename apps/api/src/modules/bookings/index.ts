/**
 * Public surface of the bookings module, for features that need to know where an event takes place
 * (gate passes, reports). Import from here, not from the module's internals.
 */
export { confirmedVenue } from './repository.js';
