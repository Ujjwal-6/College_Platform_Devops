-- Up Migration
-- Database-backed job queue. Jobs are inserted in the same transaction as the business change
-- that needs them (so a rolled-back change never leaves a job behind), and job_key makes
-- enqueueing idempotent.
CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  job_key      text,
  status       text NOT NULL DEFAULT 'queued',
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT jobs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT jobs_max_attempts_check CHECK (max_attempts > 0)
);
CREATE UNIQUE INDEX jobs_job_key_key ON jobs (job_key) WHERE job_key IS NOT NULL;
CREATE INDEX jobs_claim_idx ON jobs (run_at) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_failed_idx ON jobs (updated_at DESC) WHERE status = 'failed';

-- Down Migration
DROP TABLE jobs;
