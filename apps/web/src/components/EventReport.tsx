import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { api, ApiError, downloadFile, fetchBlobUrl, fieldIssues, uploadFile } from '../api/client';
import type { ReportOverview, ReportPhoto } from '../api/reportTypes';
import type { EventDetail } from '../api/types';
import { formatDateTime } from '../lib/datetime';

const POLL_MS = 5000;

const errorText = (err: unknown, fallback: string) => {
  const issues = fieldIssues(err);
  if (issues.length) return issues.map((i) => i.message).join(' ');
  return err instanceof ApiError ? err.message : fallback;
};

function Thumb({ eventId, photo }: { eventId: string; photo: ReportPhoto }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetchBlobUrl(`/events/${eventId}/report/photos/${photo.id}`)
      .then((u) => {
        if (cancelled) URL.revokeObjectURL(u);
        else {
          url = u;
          setSrc(u);
        }
      })
      .catch(() => setSrc(null));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [eventId, photo.id]);
  return src ? (
    <img src={src} alt={photo.caption ?? 'Event photograph'} width={120} />
  ) : (
    <span className="muted">Loading…</span>
  );
}

/**
 * The post-event report, for the event's organizer, department staff and admins: the outcomes text and
 * photographs the organizer adds (before or after the event closes), the versions of the report, and
 * asking for a new version. A report is made automatically when the event closes.
 */
export function EventReport({ event }: { event: EventDetail }) {
  const staff = event.workflow !== null;
  const active = event.status === 'published' || event.status === 'closed';
  const [data, setData] = useState<ReportOverview | null>(null);
  const [outcomes, setOutcomes] = useState('');
  const [caption, setCaption] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = (await api<{ data: ReportOverview }>(`/events/${event.id}/report`)).data;
      setData(r);
      setOutcomes((current) => (current === '' ? (r.inputs.outcomes ?? '') : current));
    } catch {
      setError('Could not load the report.');
    }
  }, [event.id]);
  useEffect(() => {
    if (staff && active) void load();
  }, [staff, active, load]);

  // A version is drawn in the background; look again until none is pending.
  useEffect(() => {
    if (!data?.reports.some((r) => r.status === 'pending')) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [data, load]);

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
    } catch (err) {
      setError(errorText(err, 'Something went wrong.'));
    } finally {
      setBusy(false);
    }
    await load();
  }

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const query = caption.trim() ? `?caption=${encodeURIComponent(caption.trim())}` : '';
    await run(async () => {
      await uploadFile(`/events/${event.id}/report/photos${query}`, file, true, 'POST');
      setCaption('');
    }, 'The photograph was added.');
  }

  if (!staff || !active) return null;
  const can = data?.can;
  return (
    <>
      <h2>Post-event report</h2>
      <p className="muted">
        A report is made automatically when the event is closed, from the event details, attendance,
        feedback and certificates, plus the outcomes and photographs below. Add them before closing,
        or add late ones and ask for a new version.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice notice-ok">
          {message}
        </p>
      )}
      {data && (
        <>
          <h3>Outcomes</h3>
          {can?.edit ? (
            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void run(async () => {
                  await api(`/events/${event.id}/report/outcomes`, {
                    method: 'PUT',
                    body: { outcomes: outcomes.trim() ? outcomes : null },
                  });
                }, 'The outcomes were saved.');
              }}
            >
              <label>
                What the event achieved
                <textarea
                  value={outcomes}
                  onChange={(e) => setOutcomes(e.target.value)}
                  rows={4}
                  maxLength={3000}
                />
              </label>
              <button type="submit" disabled={busy}>
                Save outcomes
              </button>
            </form>
          ) : data.inputs.outcomes ? (
            <p>{data.inputs.outcomes}</p>
          ) : (
            <p className="muted">No outcomes provided yet.</p>
          )}

          <h3>
            Photographs ({data.photos.length} of {data.limits.photoMaxCount})
          </h3>
          {data.photos.length === 0 && <p className="muted">No photographs provided yet.</p>}
          <ul>
            {data.photos.map((p) => (
              <li key={p.id}>
                <Thumb eventId={event.id} photo={p} />
                {p.caption && <span> {p.caption}</span>}{' '}
                {can?.edit && (
                  <button
                    className="danger"
                    disabled={busy}
                    aria-label={`Remove photograph ${p.caption ?? ''}`.trim()}
                    onClick={() =>
                      void run(
                        async () =>
                          void (await api(`/events/${event.id}/report/photos/${p.id}`, {
                            method: 'DELETE',
                          })),
                        'The photograph was removed.',
                      )
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {can?.edit && data.photos.length < data.limits.photoMaxCount && (
            <>
              <label>
                Caption for the next photograph (optional)
                <input
                  value={caption}
                  maxLength={200}
                  onChange={(e) => setCaption(e.target.value)}
                />
              </label>
              <label>
                Add a photograph (JPEG or PNG, up to{' '}
                {Math.round(data.limits.photoMaxBytes / 1_000_000)} MB)
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  disabled={busy}
                  onChange={(e) => void upload(e)}
                />
              </label>
            </>
          )}

          <h3>Reports</h3>
          {data.reports.length === 0 ? (
            <p className="muted">
              {event.status === 'closed'
                ? 'No report yet.'
                : 'The report will be made when the event is closed.'}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Made</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.reports.map((r) => (
                  <tr key={r.id}>
                    <td>{r.version}</td>
                    <td>
                      {r.reason === 'close'
                        ? 'When the event closed'
                        : `Asked for${r.requestedBy ? ` by ${r.requestedBy}` : ''}`}
                      {' · '}
                      {formatDateTime(r.generatedAt ?? r.createdAt)}
                    </td>
                    <td>
                      {r.status === 'ready'
                        ? 'Ready'
                        : r.status === 'pending'
                          ? 'Being prepared…'
                          : 'Could not be made'}
                    </td>
                    <td>
                      {r.status === 'ready' && (
                        <button
                          onClick={() =>
                            void run(
                              async () =>
                                downloadFile(
                                  `/event-reports/${r.id}/download`,
                                  `event-report-v${r.version}.pdf`,
                                ),
                              `Version ${r.version} was downloaded.`,
                            )
                          }
                          aria-label={`Download report version ${r.version}`}
                        >
                          Download (PDF)
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {can?.generate && (
            <button
              disabled={busy}
              onClick={() =>
                void run(
                  async () =>
                    void (await api(`/events/${event.id}/reports`, { method: 'POST', body: {} })),
                  'A new version of the report is being prepared. This page will update.',
                )
              }
            >
              Make a new version of the report
            </button>
          )}
        </>
      )}
    </>
  );
}
