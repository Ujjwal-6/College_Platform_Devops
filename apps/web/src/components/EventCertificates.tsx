import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fieldIssues } from '../api/client';
import type { EventCertificates as Data } from '../api/aftermathTypes';
import type { EventDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Pill } from './Pill';

const POLL_MS = 5000;

/**
 * For the organizer, department staff and admins: who has a certificate, issuing them, and (organizer
 * or admin) withdrawing and reinstating one. Admins can also redraw them, for example after the college
 * added its logo.
 */
export function EventCertificates({ event }: { event: EventDetail }) {
  const { user, hasRole } = useAuth();
  const admin = hasRole('admin');
  const manager = admin || event.organizerId === user?.id;
  const staff = event.workflow !== null;
  const over =
    Date.parse(event.endAt) <= Date.now() &&
    (event.status === 'published' || event.status === 'closed');
  const [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState<{ id: string; name: string } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<Data>(`/events/${event.id}/certificates`));
    } catch {
      setError('Could not load certificates.');
    }
  }, [event.id]);
  useEffect(() => {
    if (staff && over) void load();
  }, [staff, over, load]);

  // PDFs are drawn in the background; look again until they are all ready.
  useEffect(() => {
    if (!data || data.summary.ready >= data.summary.issued) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [data, load]);

  async function act(path: string, done: string, body: object = {}) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api(path, { method: 'POST', body });
      setMessage(done);
    } catch (err) {
      const issues = fieldIssues(err);
      setError(
        issues.length
          ? issues.map((i) => i.message).join(' ')
          : err instanceof ApiError
            ? err.message
            : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
    await load();
  }

  async function withdraw(e: FormEvent) {
    e.preventDefault();
    if (!withdrawing) return;
    await act(
      `/certificates/${withdrawing.id}/revoke`,
      `The certificate for ${withdrawing.name} was withdrawn.`,
      {
        reason,
      },
    );
    setWithdrawing(null);
    setReason('');
  }

  if (!staff || !over) return null;
  return (
    <>
      <h2>Certificates</h2>
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
          <p>
            {data.summary.issued} issued · {data.summary.ready} ready · {data.summary.eligible}{' '}
            eligible
            {data.summary.revoked > 0 ? ` · ${data.summary.revoked} withdrawn` : ''}
          </p>
          <p className="muted">
            Certificates go to people who were checked in and, when check-out is required, stayed to
            the end. They are made when the organizer presses “Issue certificates”, so press it
            again after late check-outs.
          </p>
          {manager && data.summary.canIssue && (
            <button
              disabled={busy}
              onClick={() =>
                void act(
                  `/events/${event.id}/certificates/issue`,
                  'Certificates are being prepared. This page will update.',
                )
              }
            >
              Issue certificates
            </button>
          )}{' '}
          {admin && data.summary.ready > 0 && (
            <button
              disabled={busy}
              onClick={() =>
                void act(
                  `/events/${event.id}/certificates/redraw`,
                  'All certificates are being redrawn with the current design and names.',
                )
              }
            >
              Redraw all certificates
            </button>
          )}
          {data.data.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Code</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.data.map((c) => (
                  <tr key={c.id}>
                    <td>{c.holderName}</td>
                    <td>{c.code}</td>
                    <td>
                      {c.revokedAt ? (
                        <Pill tone="bad">{`Withdrawn${c.revokeReason ? ` (${c.revokeReason})` : ''}`}</Pill>
                      ) : c.status === 'ready' ? (
                        <Pill tone="ok">Ready</Pill>
                      ) : (
                        <Pill tone="warn">Being prepared</Pill>
                      )}
                    </td>
                    <td>
                      {admin && !c.revokedAt && (
                        <button
                          disabled={busy}
                          aria-label={`Redraw certificate for ${c.holderName}`}
                          onClick={() =>
                            void act(
                              `/certificates/${c.id}/regenerate`,
                              'The certificate is being redrawn with the current name.',
                            )
                          }
                        >
                          Redraw
                        </button>
                      )}{' '}
                      {manager &&
                        (c.revokedAt ? (
                          <button
                            disabled={busy}
                            aria-label={`Reinstate certificate for ${c.holderName}`}
                            onClick={() =>
                              void act(
                                `/certificates/${c.id}/reinstate`,
                                `The certificate for ${c.holderName} was reinstated.`,
                              )
                            }
                          >
                            Reinstate
                          </button>
                        ) : (
                          <button
                            className="danger"
                            disabled={busy}
                            aria-label={`Withdraw certificate for ${c.holderName}`}
                            onClick={() => setWithdrawing({ id: c.id, name: c.holderName })}
                          >
                            Withdraw
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {withdrawing && (
            <form onSubmit={(e) => void withdraw(e)}>
              <p>
                Withdraw the certificate of <strong>{withdrawing.name}</strong>? Its code will say
                “withdrawn” and the person can no longer download it. You can reinstate it later.
              </p>
              <label>
                Reason
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={300}
                  required
                />
              </label>
              <button type="submit" disabled={busy}>
                Confirm withdrawal
              </button>{' '}
              <button type="button" onClick={() => setWithdrawing(null)}>
                Cancel
              </button>
            </form>
          )}
        </>
      )}
    </>
  );
}
