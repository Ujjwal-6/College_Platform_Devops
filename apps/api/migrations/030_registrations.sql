-- Up Migration
-- Registrations and teams. One registration row per person per event; cancelling keeps the row (status
-- 'cancelled') so history is not lost, and registering again reactivates it. The unique constraint on
-- (event_id, user_id) is what stops a person registering twice, whatever the application does.
CREATE TABLE teams (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              uuid NOT NULL REFERENCES events (id),
  name                  text NOT NULL,
  leader_id             uuid NOT NULL REFERENCES users (id),
  status                text NOT NULL DEFAULT 'active',
  -- Only a hash of the invitation code is stored (like refresh tokens). The code is shown once.
  invitation_hash       text,
  invitation_expires_at timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_status_check CHECK (status IN ('active', 'dissolved')),
  CONSTRAINT teams_name_check CHECK (char_length(name) BETWEEN 2 AND 60 AND name = btrim(name)),
  CONSTRAINT teams_invitation_check CHECK ((invitation_hash IS NULL) = (invitation_expires_at IS NULL))
);
CREATE UNIQUE INDEX teams_invitation_hash_key ON teams (invitation_hash) WHERE invitation_hash IS NOT NULL;
CREATE UNIQUE INDEX teams_event_name_key ON teams (event_id, lower(name)) WHERE status = 'active';
CREATE INDEX teams_event_idx ON teams (event_id);

CREATE TABLE registrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events (id),
  user_id       uuid NOT NULL REFERENCES users (id),
  team_id       uuid REFERENCES teams (id),
  status        text NOT NULL DEFAULT 'registered',
  cancel_reason text,
  registered_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registrations_status_check CHECK (status IN ('registered', 'cancelled')),
  CONSTRAINT registrations_cancel_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT registrations_reason_check CHECK (cancel_reason IS NULL OR status = 'cancelled'),
  CONSTRAINT registrations_event_user_key UNIQUE (event_id, user_id)
);
CREATE INDEX registrations_event_idx ON registrations (event_id) WHERE status = 'registered';
CREATE INDEX registrations_user_idx ON registrations (user_id);
CREATE INDEX registrations_team_idx ON registrations (team_id) WHERE team_id IS NOT NULL;

-- Down Migration
DROP TABLE registrations;
DROP TABLE teams;
