import type { Executor } from '../../platform/db.js';

export interface CertificateRecord {
  id: string;
  eventId: string;
  userId: string;
  code: string;
  holderName: string;
  status: 'pending' | 'ready';
  storageKey: string | null;
  issuedAt: Date;
  generatedAt: Date | null;
  /** Set while the certificate is withdrawn. */
  revokedAt: Date | null;
  revokeReason: string | null;
}

function map(r: Record<string, unknown>): CertificateRecord {
  return {
    id: r.id as string,
    eventId: r.event_id as string,
    userId: r.user_id as string,
    code: r.code as string,
    holderName: r.holder_name as string,
    status: r.status as CertificateRecord['status'],
    storageKey: (r.storage_key as string | null) ?? null,
    issuedAt: r.issued_at as Date,
    generatedAt: (r.generated_at as Date | null) ?? null,
    revokedAt: (r.revoked_at as Date | null) ?? null,
    revokeReason: (r.revoke_reason as string | null) ?? null,
  };
}

/**
 * Creates the certificate of a person for an event, once. The unique (event_id, user_id) constraint
 * makes a second attempt do nothing and return null, so a job that is retried or run again cannot
 * duplicate a certificate. A code that happens to collide raises a unique violation (retry with a new code).
 */
export async function insertCertificate(
  db: Executor,
  v: { eventId: string; userId: string; code: string; holderName: string },
): Promise<CertificateRecord | null> {
  const { rows } = await db.query(
    `INSERT INTO certificates (event_id, user_id, code, holder_name) VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT certificates_event_user_key DO NOTHING RETURNING *`,
    [v.eventId, v.userId, v.code, v.holderName],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function findById(
  db: Executor,
  id: string,
  forUpdate = false,
): Promise<CertificateRecord | null> {
  const { rows } = await db.query(
    `SELECT * FROM certificates WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function findByCode(db: Executor, code: string): Promise<CertificateRecord | null> {
  const { rows } = await db.query('SELECT * FROM certificates WHERE code = $1', [code]);
  return rows[0] ? map(rows[0]) : null;
}

export async function listForUser(db: Executor, userId: string): Promise<CertificateRecord[]> {
  const { rows } = await db.query(
    'SELECT * FROM certificates WHERE user_id = $1 ORDER BY issued_at DESC, id',
    [userId],
  );
  return rows.map(map);
}

export async function listForEvent(db: Executor, eventId: string): Promise<CertificateRecord[]> {
  const { rows } = await db.query(
    'SELECT * FROM certificates WHERE event_id = $1 ORDER BY holder_name, id',
    [eventId],
  );
  return rows.map(map);
}

/** Records the first PDF. Only a pending certificate changes; returns false if another worker finished first. */
export async function markReady(db: Executor, id: string, storageKey: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE certificates SET status = 'ready', storage_key = $2, generated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [id, storageKey],
  );
  return rowCount === 1;
}

/** Replaces the PDF (and the printed name) of an existing certificate; returns the file it replaced. */
export async function replaceFile(
  db: Executor,
  id: string,
  storageKey: string,
  holderName: string,
): Promise<string | null> {
  const old = await findById(db, id, true);
  await db.query(
    `UPDATE certificates SET status = 'ready', storage_key = $2, holder_name = $3, generated_at = now()
      WHERE id = $1`,
    [id, storageKey, holderName],
  );
  return old?.storageKey ?? null;
}

/** Withdraws a certificate. Returns false if it was already withdrawn (so two admins cannot both do it). */
export async function revoke(
  db: Executor,
  id: string,
  by: string,
  reason: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE certificates SET revoked_at = now(), revoked_by = $2, revoke_reason = $3
      WHERE id = $1 AND revoked_at IS NULL`,
    [id, by, reason],
  );
  return rowCount === 1;
}

/** Puts a withdrawn certificate back. Returns false if it was not withdrawn. */
export async function reinstate(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE certificates SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL
      WHERE id = $1 AND revoked_at IS NOT NULL`,
    [id],
  );
  return rowCount === 1;
}

// ---- the design shared by all certificates -----------------------------------------------------

export interface TemplateRecord {
  organizationName: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  logoKey: string | null;
  signatureKey: string | null;
  updatedAt: Date | null;
}

const EMPTY_TEMPLATE: TemplateRecord = {
  organizationName: null,
  signatoryName: null,
  signatoryTitle: null,
  logoKey: null,
  signatureKey: null,
  updatedAt: null,
};

export async function getTemplate(db: Executor): Promise<TemplateRecord> {
  const { rows } = await db.query('SELECT * FROM certificate_template');
  const r = rows[0];
  return r
    ? {
        organizationName: (r.organization_name as string | null) ?? null,
        signatoryName: (r.signatory_name as string | null) ?? null,
        signatoryTitle: (r.signatory_title as string | null) ?? null,
        logoKey: (r.logo_key as string | null) ?? null,
        signatureKey: (r.signature_key as string | null) ?? null,
        updatedAt: r.updated_at as Date,
      }
    : EMPTY_TEMPLATE;
}

/** Saves the template, keeping whatever `patch` leaves out. */
export async function saveTemplate(
  db: Executor,
  patch: Partial<Omit<TemplateRecord, 'updatedAt'>>,
  updatedBy: string,
): Promise<TemplateRecord> {
  const current = await getTemplate(db);
  const next = { ...current, ...patch };
  await db.query(
    `INSERT INTO certificate_template
       (id, organization_name, signatory_name, signatory_title, logo_key, signature_key, updated_by)
     VALUES (true, $1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE
       SET organization_name = $1, signatory_name = $2, signatory_title = $3,
           logo_key = $4, signature_key = $5, updated_by = $6, updated_at = now()`,
    [
      next.organizationName,
      next.signatoryName,
      next.signatoryTitle,
      next.logoKey,
      next.signatureKey,
      updatedBy,
    ],
  );
  return getTemplate(db);
}
