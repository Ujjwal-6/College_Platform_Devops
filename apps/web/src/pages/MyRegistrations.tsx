import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { MyRegistration } from '../api/registrationTypes';
import { formatDateTime } from '../lib/datetime';
import { Pill } from '../components/Pill';

export function MyRegistrations() {
  const [rows, setRows] = useState<MyRegistration[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await api<{ data: MyRegistration[] }>('/registrations')).data);
    } catch {
      setError('Could not load your registrations.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function cancel(r: MyRegistration) {
    try {
      await api(`/registrations/${r.id}/cancel`, { method: 'POST', body: {} });
      await load();
    } catch (err) {
      await load();
      setError(err instanceof ApiError ? err.message : 'Could not cancel the registration.');
    }
  }

  return (
    <section className="card">
      <h1>My registrations</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>When (India)</th>
            <th>Team</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id}>
              <td>{r.event ? <Link to={`/events/${r.event.id}`}>{r.event.title}</Link> : '—'}</td>
              <td>{r.event ? formatDateTime(r.event.startAt) : ''}</td>
              <td>{r.team ? r.team.name : '—'}</td>
              <td>
                {r.status === 'registered' ? (
                  <Pill tone="ok">Registered</Pill>
                ) : r.status === 'waitlisted' ? (
                  <Pill tone="warn">{`Waitlisted (place ${r.waitlistPosition})`}</Pill>
                ) : (
                  <Pill tone="bad">
                    {r.cancelReason === 'event_cancelled'
                      ? 'Cancelled (event cancelled)'
                      : 'Cancelled'}
                  </Pill>
                )}
              </td>
              <td>
                {r.status !== 'cancelled' &&
                  r.event &&
                  Date.parse(r.event.startAt) > Date.now() && (
                    <button
                      className="danger"
                      onClick={() => void cancel(r)}
                      aria-label={`${r.status === 'waitlisted' ? 'Leave waitlist' : 'Cancel registration'} for ${r.event.title}`}
                    >
                      {r.status === 'waitlisted' ? 'Leave waitlist' : 'Cancel'}
                    </button>
                  )}
              </td>
            </tr>
          ))}
          {rows && rows.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                You have not registered for any event yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
