-- Up Migration
-- Academic calendar guard. Dates are inclusive calendar dates in APP_TIMEZONE.
CREATE TABLE calendar_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  title         text NOT NULL,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  severity      text NOT NULL,
  -- NULL = applies to every department. (Hall scope is added with the booking feature.)
  department_id uuid REFERENCES departments (id),
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_type_check CHECK (type IN ('exam_period', 'holiday', 'major_fest', 'academic_date', 'other')),
  CONSTRAINT calendar_severity_check CHECK (severity IN ('block', 'warn')),
  CONSTRAINT calendar_title_check CHECK (char_length(btrim(title)) BETWEEN 2 AND 150),
  CONSTRAINT calendar_dates_check CHECK (end_date >= start_date)
);
CREATE INDEX calendar_entries_dates_idx ON calendar_entries (start_date, end_date) WHERE is_active;

-- Down Migration
DROP TABLE calendar_entries;
