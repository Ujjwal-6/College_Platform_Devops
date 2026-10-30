-- Up Migration
-- Certificates of participation and post-event feedback.
--
-- One certificate per person per event (unique constraint), so re-running the job that issues them can
-- never make a second one. The holder's name is stored as printed; correcting a name regenerates the PDF
-- and updates it. The verification code is public (it is printed on the certificate) and unguessable.
CREATE TABLE certificates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events (id),
  user_id      uuid NOT NULL REFERENCES users (id),
  code         text NOT NULL,
  holder_name  text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  storage_key  text,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  generated_at timestamptz,
  CONSTRAINT certificates_event_user_key UNIQUE (event_id, user_id),
  CONSTRAINT certificates_code_key UNIQUE (code),
  CONSTRAINT certificates_status_check CHECK (status IN ('pending', 'ready')),
  CONSTRAINT certificates_ready_check CHECK (
    (status = 'ready') = (storage_key IS NOT NULL AND generated_at IS NOT NULL)
  )
);
CREATE INDEX certificates_user_idx ON certificates (user_id, issued_at DESC);

-- One feedback per person per event. It is tied to the person only to enforce that; nothing that reads
-- feedback for organizers returns who wrote it.
CREATE TABLE feedback (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  rating     smallint NOT NULL,
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_event_user_key UNIQUE (event_id, user_id),
  CONSTRAINT feedback_rating_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT feedback_comment_check CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 1000)
);
CREATE INDEX feedback_event_idx ON feedback (event_id);

-- Down Migration
DROP TABLE feedback;
DROP TABLE certificates;
