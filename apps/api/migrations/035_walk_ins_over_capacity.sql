-- Up Migration
-- Lets an organizer decide that walk-ins may exceed the seat limit of an event. Off by default: a full
-- event refuses walk-ins unless the organizer turns this on.
ALTER TABLE event_attendance_settings
  ADD COLUMN walk_ins_over_capacity boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE event_attendance_settings DROP COLUMN walk_ins_over_capacity;
