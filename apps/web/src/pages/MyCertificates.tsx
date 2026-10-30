import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, downloadFile } from '../api/client';
import type { MyCertificate } from '../api/aftermathTypes';
import { formatDateTime } from '../lib/datetime';

const POLL_MS = 5000;

export function MyCertificates() {
  const [rows, setRows] = useState<MyCertificate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api<{ data: MyCertificate[] }>('/certificates')).data);
    } catch {
      setError('Could not load your certificates.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!rows?.some((r) => r.status === 'pending' && !r.revokedAt)) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [rows, load]);

  async function download(r: MyCertificate) {
    setError(null);
    try {
      await downloadFile(`/certificates/${r.id}/download`, 'certificate.pdf');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not download the certificate.');
    }
  }

  return (
    <section className="card">
      <h1>My certificates</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Issued (India)</th>
            <th>Code</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id}>
              <td>{r.event ? <Link to={`/events/${r.event.id}`}>{r.event.title}</Link> : '—'}</td>
              <td>{formatDateTime(r.issuedAt)}</td>
              <td>
                <Link to={`/verify/${r.code}`}>{r.code}</Link>
              </td>
              <td>
                {r.revokedAt ? (
                  <span className="muted">Withdrawn</span>
                ) : r.status === 'ready' ? (
                  <button
                    onClick={() => void download(r)}
                    aria-label={`Download certificate for ${r.event?.title ?? 'the event'}`}
                  >
                    Download (PDF)
                  </button>
                ) : (
                  <span className="muted">Being prepared…</span>
                )}
              </td>
            </tr>
          ))}
          {rows && rows.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                You have no certificates yet. They are issued after an event to people who attended
                it.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
