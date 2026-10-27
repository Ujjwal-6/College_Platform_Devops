-- Up Migration
-- A hall booking reserves one hall for a time range on behalf of one event.
-- Statuses: pending (waiting for approval), confirmed, rejected, cancelled.
-- Pending and confirmed bookings hold the slot; rejected and cancelled ones do not.
CREATE TABLE hall_bookings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES events (id),
  hall_id            uuid NOT NULL REFERENCES halls (id),
  requested_by       uuid NOT NULL REFERENCES users (id),
  -- Copied from the event (and kept in sync by an event hook) so approval queues need no access to event tables.
  event_organizer_id uuid NOT NULL REFERENCES users (id),
  department_id      uuid NOT NULL REFERENCES departments (id),

  start_at           timestamptz NOT NULL,
  end_at             timestamptz NOT NULL,
  required_facilities text[] NOT NULL DEFAULT '{}',
  notes              text NOT NULL DEFAULT '',

  status             text NOT NULL DEFAULT 'pending',
  -- 'faculty' then 'hod_admin' (the HOD of the department or any admin). Set if and only if status = 'pending'.
  approval_level     text,
  -- Increments whenever a change of hall or time sends the booking back to the first approval step.
  approval_round     integer NOT NULL DEFAULT 1,
  -- Warnings the organizer acknowledged (capacity, facilities, calendar, event time), shown to approvers.
  warnings           jsonb NOT NULL DEFAULT '[]'::jsonb,
  closing_comment    text,
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hall_bookings_time_order CHECK (end_at > start_at),
  CONSTRAINT hall_bookings_status_check CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  CONSTRAINT hall_bookings_level_check CHECK (approval_level IS NULL OR approval_level IN ('faculty', 'hod_admin')),
  CONSTRAINT hall_bookings_level_matches_status CHECK ((status = 'pending') = (approval_level IS NOT NULL)),
  CONSTRAINT hall_bookings_notes_check CHECK (char_length(notes) <= 1000),

  -- THE double-booking guarantee. Two active bookings of the same hall can never overlap.
  -- Ranges are half-open [start, end), so a booking may start exactly when the previous one ends.
  CONSTRAINT hall_bookings_no_overlap EXCLUDE USING gist (
    hall_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status IN ('pending', 'confirmed'))
);
CREATE INDEX hall_bookings_event_idx ON hall_bookings (event_id);
CREATE INDEX hall_bookings_requester_idx ON hall_bookings (requested_by, created_at DESC);
CREATE INDEX hall_bookings_queue_idx ON hall_bookings (department_id, approval_level) WHERE status = 'pending';

CREATE TABLE booking_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES hall_bookings (id) ON DELETE CASCADE,
  round       integer NOT NULL,
  level       text NOT NULL,
  decision    text NOT NULL,
  approver_id uuid NOT NULL REFERENCES users (id),
  comment     text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_approvals_level_check CHECK (level IN ('faculty', 'hod_admin')),
  CONSTRAINT booking_approvals_decision_check CHECK (decision IN ('approved', 'rejected')),
  CONSTRAINT booking_approvals_reject_comment_check CHECK (
    decision <> 'rejected' OR (comment IS NOT NULL AND char_length(btrim(comment)) > 0)
  ),
  CONSTRAINT booking_approvals_level_once UNIQUE (booking_id, round, level),
  CONSTRAINT booking_approvals_person_once UNIQUE (booking_id, round, approver_id)
);

CREATE TABLE booking_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES hall_bookings (id) ON DELETE CASCADE,
  action      text NOT NULL,
  actor_id    uuid REFERENCES users (id),
  from_status text,
  to_status   text,
  level       text,
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_history_booking_idx ON booking_history (booking_id, id);

-- Down Migration
DROP TABLE booking_history;
DROP TABLE booking_approvals;
DROP TABLE hall_bookings;
