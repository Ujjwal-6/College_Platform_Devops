-- Up Migration
-- A full individual event can keep a waiting list. A waiting person has a registration row with
-- status 'waitlisted' and no seat (seats are counted from 'registered' rows only). Their place in the
-- queue is the order of waitlisted_at, with the id as a tie-break.
ALTER TABLE registrations DROP CONSTRAINT registrations_status_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_status_check
  CHECK (status IN ('registered', 'waitlisted', 'cancelled'));
ALTER TABLE registrations ADD COLUMN waitlisted_at timestamptz;
ALTER TABLE registrations ADD CONSTRAINT registrations_waitlist_check
  CHECK (status <> 'waitlisted' OR (waitlisted_at IS NOT NULL AND team_id IS NULL));
CREATE INDEX registrations_waitlist_idx ON registrations (event_id, waitlisted_at, id)
  WHERE status = 'waitlisted';

-- Down Migration
-- People still waiting have no seat to fall back to, so their rows are removed.
DELETE FROM registrations WHERE status = 'waitlisted';
DROP INDEX registrations_waitlist_idx;
ALTER TABLE registrations DROP CONSTRAINT registrations_waitlist_check;
ALTER TABLE registrations DROP COLUMN waitlisted_at;
ALTER TABLE registrations DROP CONSTRAINT registrations_status_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_status_check
  CHECK (status IN ('registered', 'cancelled'));
