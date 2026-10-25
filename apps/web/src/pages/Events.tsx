import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { EventSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/datetime';

type Scope = 'published' | 'mine' | 'department' | 'approvals';

export function Events({ initialScope }: { initialScope?: Scope }) {
  const { hasRole } = useAuth();
  const staff = hasRole('faculty', 'hod', 'admin');
  const canCreate = hasRole('organizer', 'faculty', 'hod', 'admin');
  const tabs: { scope: Scope; label: string }[] = [
    { scope: 'published', label: 'Upcoming events' },
    ...(canCreate ? [{ scope: 'mine' as const, label: 'My events' }] : []),
    ...(staff
      ? [
          { scope: 'approvals' as const, label: 'Approval queue' },
          { scope: 'department' as const, label: 'Department' },
        ]
      : []),
  ];
  const [scope, setScope] = useState<Scope>(initialScope ?? 'published');
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setError(null);
    api<{ data: EventSummary[] }>(`/events?scope=${scope}&limit=100`)
      .then((r) => !cancelled && setEvents(r.data))
      .catch(() => !cancelled && setError('Could not load events.'));
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return (
    <section className="card">
      <div className="row">
        <h1>Events</h1>
        {canCreate && (
          <Link className="button" to="/events/new">
            New event
          </Link>
        )}
      </div>
      <div role="tablist" className="tabs">
        {tabs.map((t) => (
          <button
            key={t.scope}
            role="tab"
            aria-selected={scope === t.scope}
            className={scope === t.scope ? 'active' : ''}
            onClick={() => setScope(t.scope)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!events && !error && <p role="status">Loading…</p>}
      {events && events.length === 0 && (
        <p className="muted">
          {scope === 'approvals' ? 'Nothing is waiting for your decision.' : 'No events to show.'}
        </p>
      )}
      {events && events.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>When</th>
              <th>Organizer</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>
                  <Link to={`/events/${e.id}`}>{e.title}</Link>
                </td>
                <td>{formatDateTime(e.startAt)}</td>
                <td>{e.organizerName ?? '—'}</td>
                <td>
                  <StatusBadge status={e.status} level={e.approvalLevel} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
