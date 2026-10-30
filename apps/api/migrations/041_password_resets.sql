-- Up Migration
-- Password reset by emailed link (FR-1.4). Only a hash of the token is stored; a token works once and expires.
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_hash_key UNIQUE (token_hash),
  CONSTRAINT password_reset_tokens_expiry_check CHECK (expires_at > created_at)
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id, created_at DESC);

-- Down Migration
DROP TABLE password_reset_tokens;
