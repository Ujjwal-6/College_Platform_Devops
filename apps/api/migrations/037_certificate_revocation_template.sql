-- Up Migration
-- Withdrawing a certificate, and the look of certificates (logo, signature, names) which the college
-- supplies later and an admin can change without a release.
--
-- A withdrawn certificate keeps its row, its code and its file (so it can be reinstated and so its
-- code answers "withdrawn" rather than "not found"); revoked_at says it no longer counts.
ALTER TABLE certificates
  ADD COLUMN revoked_at    timestamptz,
  ADD COLUMN revoked_by    uuid REFERENCES users (id),
  ADD COLUMN revoke_reason text;
ALTER TABLE certificates ADD CONSTRAINT certificates_revoked_check CHECK (
  (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
  OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
      AND revoke_reason IS NOT NULL AND char_length(btrim(revoke_reason)) >= 3)
);

-- One row only (the boolean primary key can only be true): the design shared by all certificates.
CREATE TABLE certificate_template (
  id                boolean PRIMARY KEY DEFAULT true,
  organization_name text,
  signatory_name    text,
  signatory_title   text,
  logo_key          text,
  signature_key     text,
  updated_by        uuid REFERENCES users (id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT certificate_template_single_row CHECK (id),
  CONSTRAINT certificate_template_lengths CHECK (
    char_length(organization_name) <= 120 AND char_length(signatory_name) <= 120
    AND char_length(signatory_title) <= 120
  )
);

-- Down Migration
DROP TABLE certificate_template;
ALTER TABLE certificates DROP CONSTRAINT certificates_revoked_check;
ALTER TABLE certificates
  DROP COLUMN revoke_reason,
  DROP COLUMN revoked_by,
  DROP COLUMN revoked_at;
