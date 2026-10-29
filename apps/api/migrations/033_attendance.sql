-- Up Migration
-- Attendance (check-in) and its helpers. One attendance row per registration, enforced by a unique
-- constraint, so scanning the same pass twice (or two scanners at once) can only ever record one.
CREATE TABLE attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL REFERENCES registrations (id),
  event_id        uuid NOT NULL REFERENCES events (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  checked_in_by   uuid NOT NULL REFERENCES users (id),
  method          text NOT NULL,
  reason          text,
  checked_in_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_registration_key UNIQUE (registration_id),
  CONSTRAINT attendance_method_check CHECK (method IN ('qr', 'manual')),
  -- a manual check-in must say why (the fallback is logged, FR-7.4); a scan has no reason
  CONSTRAINT attendance_reason_check CHECK (
    (method = 'manual' AND reason IS NOT NULL AND char_length(btrim(reason)) >= 3)
    OR (method = 'qr' AND reason IS NULL)
  )
);
CREATE INDEX attendance_event_idx ON attendance (event_id, checked_in_at DESC);

-- People the organizer lets scan passes at the gate, for one event.
CREATE TABLE event_volunteers (
  event_id    uuid NOT NULL REFERENCES events (id),
  user_id     uuid NOT NULL REFERENCES users (id),
  assigned_by uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_volunteers_user_idx ON event_volunteers (user_id);

-- The generated gate-pass PDF of a registration (the file itself lives in file storage).
CREATE TABLE gate_passes (
  registration_id uuid PRIMARY KEY REFERENCES registrations (id),
  storage_key     text NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE gate_passes;
DROP TABLE event_volunteers;
DROP TABLE attendance;
