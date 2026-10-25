-- Up Migration
-- One row per approval decision. Constraints make the workflow rules hold even under concurrency:
--   * one decision per level per submission round
--   * one person cannot decide two levels of the same round
CREATE TABLE event_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  round       integer NOT NULL,
  level       text NOT NULL,
  decision    text NOT NULL,
  approver_id uuid NOT NULL REFERENCES users (id),
  comment     text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_approvals_level_check CHECK (level IN ('faculty', 'hod', 'admin')),
  CONSTRAINT event_approvals_decision_check CHECK (decision IN ('approved', 'rejected')),
  CONSTRAINT event_approvals_reject_comment_check CHECK (decision <> 'rejected' OR (comment IS NOT NULL AND char_length(btrim(comment)) > 0)),
  CONSTRAINT event_approvals_level_once UNIQUE (event_id, round, level),
  CONSTRAINT event_approvals_person_once UNIQUE (event_id, round, approver_id)
);

-- Timeline shown to users: every lifecycle action. (audit_log is the admin-only system record.)
CREATE TABLE event_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  action      text NOT NULL,
  actor_id    uuid REFERENCES users (id),
  from_status text,
  to_status   text,
  level       text,
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_history_event_idx ON event_history (event_id, id);

-- Down Migration
DROP TABLE event_history;
DROP TABLE event_approvals;
