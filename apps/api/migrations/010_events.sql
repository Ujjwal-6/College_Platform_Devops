-- Up Migration
-- Events: the shared contract for hall booking (Member 2) and registration/attendance (Member 3).
-- See docs/architecture.md "Event contract".
CREATE TABLE events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                 text NOT NULL,
  description           text NOT NULL DEFAULT '',
  category              text NOT NULL,
  department_id         uuid NOT NULL REFERENCES departments (id),
  organizer_id          uuid NOT NULL REFERENCES users (id),
  status                text NOT NULL DEFAULT 'draft',
  -- Level currently waiting for a decision. Set if and only if status = 'pending_approval'.
  approval_level        text,
  -- Increments on every submission. Approval decisions belong to one round.
  submission_round      integer NOT NULL DEFAULT 0,

  start_at              timestamptz NOT NULL,
  end_at                timestamptz NOT NULL,
  expected_attendance   integer NOT NULL,

  -- Registration configuration (consumed by the registration feature).
  capacity              integer,
  registration_mode     text NOT NULL DEFAULT 'individual',
  team_size_min         integer,
  team_size_max         integer,
  registration_deadline timestamptz,

  -- Calendar warnings that applied when the event was submitted (snapshot shown to approvers).
  calendar_warnings     jsonb NOT NULL DEFAULT '[]'::jsonb,

  last_rejection_level   text,
  last_rejection_comment text,
  last_rejected_by       uuid REFERENCES users (id),
  last_rejected_at       timestamptz,

  submitted_at          timestamptz,
  approved_at           timestamptz,
  published_at          timestamptz,
  closed_at             timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT events_status_check CHECK (status IN ('draft', 'pending_approval', 'approved', 'published', 'closed', 'cancelled')),
  CONSTRAINT events_approval_level_check CHECK (approval_level IS NULL OR approval_level IN ('faculty', 'hod', 'admin')),
  CONSTRAINT events_level_matches_status CHECK ((status = 'pending_approval') = (approval_level IS NOT NULL)),
  CONSTRAINT events_title_check CHECK (char_length(btrim(title)) BETWEEN 3 AND 200),
  CONSTRAINT events_category_check CHECK (char_length(btrim(category)) BETWEEN 2 AND 50),
  CONSTRAINT events_time_order_check CHECK (end_at > start_at),
  CONSTRAINT events_attendance_check CHECK (expected_attendance > 0),
  CONSTRAINT events_capacity_check CHECK (capacity IS NULL OR capacity > 0),
  CONSTRAINT events_mode_check CHECK (registration_mode IN ('individual', 'team')),
  CONSTRAINT events_team_size_check CHECK (
    (registration_mode = 'individual' AND team_size_min IS NULL AND team_size_max IS NULL)
    OR (registration_mode = 'team' AND team_size_min >= 2 AND team_size_max >= team_size_min)
  ),
  CONSTRAINT events_deadline_check CHECK (registration_deadline IS NULL OR registration_deadline <= start_at),
  CONSTRAINT events_published_requires_approval CHECK (published_at IS NULL OR approved_at IS NOT NULL)
);
CREATE INDEX events_organizer_idx ON events (organizer_id, created_at DESC);
CREATE INDEX events_department_status_idx ON events (department_id, status);
CREATE INDEX events_status_start_idx ON events (status, start_at);

CREATE TABLE event_speakers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  position     integer NOT NULL,
  name         text NOT NULL,
  designation  text,
  organization text,
  CONSTRAINT event_speakers_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  UNIQUE (event_id, position)
);

-- Down Migration
DROP TABLE event_speakers;
DROP TABLE events;
