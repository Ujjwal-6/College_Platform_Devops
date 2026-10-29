import { errors } from '../../platform/errors.js';
import { registerCancelGuard } from '../registrations/index.js';
import * as repo from './repository.js';

let registered = false;

/**
 * A person who has been checked in keeps their registration: cancelling it would free a seat (and pass
 * it to someone on the waitlist) while they are at the event. Called from createApp; installed once.
 */
export function registerAttendanceGuards(): void {
  if (registered) return;
  registered = true;
  registerCancelGuard(async (db, registration) => {
    if (await repo.findByRegistration(db, registration.id)) {
      throw errors.conflict(
        'ALREADY_CHECKED_IN',
        'You are already checked in, so the registration can no longer be cancelled',
      );
    }
  });
}
