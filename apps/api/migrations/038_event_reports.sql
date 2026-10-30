-- Up Migration
-- Post-event reports. An event's report is made when it is closed, and again on request; every version
-- is kept. The organizer adds an "outcomes" text and photographs, before or after the event closes, and
-- the report uses what is there when it is drawn.
CREATE TABLE event_report_inputs (
  event_id   uuid PRIMARY KEY REFERENCES events (id),
  outcomes   text,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_report_outcomes_length CHECK (outcomes IS NULL OR char_length(outcomes) BETWEEN 1 AND 3000)
);

CREATE TABLE event_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events (id),
  storage_key text NOT NULL,
  caption     text,
  uploaded_by uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_photos_caption_length CHECK (caption IS NULL OR char_length(caption) BETWEEN 1 AND 200)
);
CREATE INDEX event_photos_event_idx ON event_photos (event_id, created_at, id);

CREATE TABLE event_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events (id),
  version      integer NOT NULL,
  -- 'close' is made automatically when the event closes; 'manual' is asked for later (for example after late photos)
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  storage_key  text,
  requested_by uuid REFERENCES users (id),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  generated_at timestamptz,
  CONSTRAINT event_reports_version_key UNIQUE (event_id, version),
  CONSTRAINT event_reports_reason_check CHECK (reason IN ('close', 'manual')),
  CONSTRAINT event_reports_status_check CHECK (status IN ('pending', 'ready', 'failed')),
  CONSTRAINT event_reports_ready_check CHECK (
    (status = 'ready') = (storage_key IS NOT NULL AND generated_at IS NOT NULL)
  ),
  CONSTRAINT event_reports_failed_check CHECK (status <> 'failed' OR error IS NOT NULL)
);
-- Closing an event twice, or a hook delivered twice, still makes only one automatic report.
CREATE UNIQUE INDEX event_reports_one_close_key ON event_reports (event_id) WHERE reason = 'close';
-- One report is drawn at a time per event: asking again while one is pending is refused.
CREATE UNIQUE INDEX event_reports_one_pending_key ON event_reports (event_id) WHERE status = 'pending';

-- Down Migration
DROP TABLE event_reports;
DROP TABLE event_photos;
DROP TABLE event_report_inputs;
