-- Up Migration
-- Remembers the result of a request that carried an Idempotency-Key, so a client that repeats the
-- request (a double click, a retry after a timeout) gets the original answer instead of a second
-- effect. The claim row is written in the same transaction as the work, so both commit together.
CREATE TABLE idempotency_keys (
  user_id     uuid NOT NULL REFERENCES users (id),
  key         text NOT NULL,
  fingerprint text NOT NULL,
  status_code integer,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key),
  CONSTRAINT idempotency_key_length CHECK (char_length(key) BETWEEN 8 AND 64)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- Down Migration
DROP TABLE idempotency_keys;
