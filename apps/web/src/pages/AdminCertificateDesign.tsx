import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { api, ApiError, fieldIssues, uploadFile } from '../api/client';
import type { CertificateTemplate } from '../api/aftermathTypes';
import { formatDateTime } from '../lib/datetime';

type Kind = 'logo' | 'signature';

/** Admin page: the college's name, logo and signature on certificates. */
export function AdminCertificateDesign() {
  const [design, setDesign] = useState<CertificateTemplate | null>(null);
  const [form, setForm] = useState({ organizationName: '', signatoryName: '', signatoryTitle: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (d: CertificateTemplate) => {
    setDesign(d);
    setForm({
      organizationName: d.organizationName ?? '',
      signatoryName: d.signatoryName ?? '',
      signatoryTitle: d.signatoryTitle ?? '',
    });
  };

  const load = useCallback(async () => {
    try {
      apply((await api<{ data: CertificateTemplate }>('/certificate-template')).data);
    } catch {
      setError('Could not load the certificate design.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const fail = (err: unknown) => {
    const issues = fieldIssues(err);
    setError(
      issues.length
        ? issues.map((i) => i.message).join(' ')
        : err instanceof ApiError
          ? err.message
          : 'Something went wrong.',
    );
  };

  async function saveText(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      apply(
        (
          await api<{ data: CertificateTemplate }>('/certificate-template', {
            method: 'PUT',
            body: form,
          })
        ).data,
      );
      setMessage('Saved. Certificates already made keep their old look until they are redrawn.');
    } catch (err) {
      fail(err);
    }
  }

  async function upload(kind: Kind, e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setMessage(null);
    try {
      apply(
        (await uploadFile<{ data: CertificateTemplate }>(`/certificate-template/${kind}`, file))
          .data,
      );
      setMessage(
        `The ${kind} was uploaded. Certificates already made keep their old look until they are redrawn.`,
      );
    } catch (err) {
      fail(err);
    }
  }

  async function remove(kind: Kind) {
    setError(null);
    setMessage(null);
    try {
      apply(
        (
          await api<{ data: CertificateTemplate }>(`/certificate-template/${kind}`, {
            method: 'DELETE',
          })
        ).data,
      );
      setMessage(`The ${kind} was removed.`);
    } catch (err) {
      fail(err);
    }
  }

  const imageRow = (kind: Kind, label: string, present: boolean) => (
    <p className="row">
      <strong>{label}:</strong> {present ? 'uploaded' : 'not uploaded yet'}
      <label>
        {present ? `Replace ${kind}` : `Upload ${kind}`} (PNG or JPEG, up to 1 MB)
        <input type="file" accept="image/png,image/jpeg" onChange={(e) => void upload(kind, e)} />
      </label>
      {present && <button onClick={() => void remove(kind)}>{`Remove ${kind}`}</button>}
    </p>
  );

  return (
    <section className="card">
      <h1>Certificate design</h1>
      <p className="muted">
        Shown on every certificate drawn from now on. The organising department is added
        automatically. To change certificates that already exist, an admin redraws them from the
        event page.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {design && (
        <>
          <form onSubmit={(e) => void saveText(e)}>
            <label>
              College or organisation name
              <input
                value={form.organizationName}
                maxLength={120}
                onChange={(e) => setForm({ ...form, organizationName: e.target.value })}
              />
            </label>
            <label>
              Signatory name
              <input
                value={form.signatoryName}
                maxLength={120}
                onChange={(e) => setForm({ ...form, signatoryName: e.target.value })}
              />
            </label>
            <label>
              Signatory title
              <input
                value={form.signatoryTitle}
                maxLength={120}
                onChange={(e) => setForm({ ...form, signatoryTitle: e.target.value })}
              />
            </label>
            <button type="submit">Save</button>
          </form>
          {imageRow('logo', 'Logo', design.hasLogo)}
          {imageRow('signature', 'Signature image', design.hasSignature)}
          {design.updatedAt && (
            <p className="muted">Last changed {formatDateTime(design.updatedAt)}.</p>
          )}
        </>
      )}
    </section>
  );
}
