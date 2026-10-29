-- Up Migration
-- Check-out (leaving the event), walk-ins, and per-event attendance settings.
--
-- A person can be checked in by scan ('qr'), by hand with a reason ('manual'), or as a walk-in who
-- had no registration ('walk_in'). Leaving is recorded on the same row, once.
ALTER TABLE attendance DROP CONSTRAINT attendance_method_check;
ALTER TABLE attendance DROP CONSTRAINT attendance_reason_check;
ALTER TABLE attendance ADD CONSTRAINT attendance_method_check
  CHECK (method IN ('qr', 'manual', 'walk_in'));
ALTER TABLE attendance ADD CONSTRAINT attendance_reason_check CHECK (
  (method = 'manual' AND reason IS NOT NULL AND char_length(btrim(reason)) >= 3)
  OR (method IN ('qr', 'walk_in') AND reason IS NULL)
);

ALTER TABLE attendance
  ADD COLUMN checked_out_at   timestamptz,
  ADD COLUMN checked_out_by   uuid REFERENCES users (id),
  ADD COLUMN check_out_method text,
  ADD COLUMN check_out_reason text;
ALTER TABLE attendance ADD CONSTRAINT attendance_checkout_check CHECK (
  (checked_out_at IS NULL AND checked_out_by IS NULL
     AND check_out_method IS NULL AND check_out_reason IS NULL)
  OR (checked_out_at IS NOT NULL AND checked_out_by IS NOT NULL AND checked_out_at >= checked_in_at
     AND (
       (check_out_method = 'manual' AND check_out_reason IS NOT NULL
          AND char_length(btrim(check_out_reason)) >= 3)
       OR (check_out_method = 'qr' AND check_out_reason IS NULL)
     ))
);

-- Choices the organizer makes for one event. No row means the defaults: no walk-ins, check-out required.
CREATE TABLE event_attendance_settings (
  event_id          uuid PRIMARY KEY REFERENCES events (id),
  allow_walk_ins    boolean NOT NULL DEFAULT false,
  require_check_out boolean NOT NULL DEFAULT true,
  updated_by        uuid NOT NULL REFERENCES users (id),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
-- Walk-ins have no older equivalent: they become by-hand check-ins with an explanatory reason.
DROP TABLE event_attendance_settings;
ALTER TABLE attendance DROP CONSTRAINT attendance_checkout_check;
ALTER TABLE attendance
  DROP COLUMN check_out_reason,
  DROP COLUMN check_out_method,
  DROP COLUMN checked_out_by,
  DROP COLUMN checked_out_at;
ALTER TABLE attendance DROP CONSTRAINT attendance_reason_check;
ALTER TABLE attendance DROP CONSTRAINT attendance_method_check;
UPDATE attendance SET method = 'manual', reason = 'Walk-in (converted by a migration)' WHERE method = 'walk_in';
ALTER TABLE attendance ADD CONSTRAINT attendance_method_check CHECK (method IN ('qr', 'manual'));
ALTER TABLE attendance ADD CONSTRAINT attendance_reason_check CHECK (
  (method = 'manual' AND reason IS NOT NULL AND char_length(btrim(reason)) >= 3)
  OR (method = 'qr' AND reason IS NULL)
);
