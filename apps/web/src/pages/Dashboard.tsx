import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { EventSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/datetime';

interface Tile {
  to: string;
  title: string;
  hint: string;
  roles?: string[];
}

const TILES: Tile[] = [
  { to: '/events', title: 'Events', hint: 'Browse, create and manage events' },
  {
    to: '/approvals',
    title: 'Approvals',
    hint: 'Events waiting for your decision',
    roles: ['faculty', 'hod', 'admin'],
  },
  { to: '/my-registrations', title: 'My registrations', hint: 'Passes and events you joined' },
  { to: '/certificates', title: 'Certificates', hint: 'Your certificates of participation' },
  { to: '/halls', title: 'Halls', hint: 'See what is free and when' },
  {
    to: '/bookings',
    title: 'Bookings',
    hint: 'Hall requests and their approval',
    roles: ['organizer', 'faculty', 'hod', 'admin'],
  },
  { to: '/check-in', title: 'Check-in', hint: 'Scan passes at the door' },
  { to: '/calendar', title: 'Calendar', hint: 'Academic dates and restrictions' },
  {
    to: '/analytics',
    title: 'Analytics',
    hint: 'Attendance, budgets and reports',
    roles: ['hod', 'admin'],
  },
];

export function Dashboard() {
  const { user, hasRole } = useAuth();
  const approver = hasRole('faculty', 'hod', 'admin');
  const [upcoming, setUpcoming] = useState<EventSummary[] | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ data: EventSummary[] }>('/events?scope=published&limit=5')
      .then((r) => !cancelled && setUpcoming(r.data))
      .catch(() => !cancelled && setUpcoming([]));
    if (approver) {
      api<{ page: { total: number } }>('/events?scope=approvals&limit=1')
        .then((r) => !cancelled && setWaiting(r.page.total))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [approver]);

  const tiles = TILES.filter(
    (t) => !t.roles || t.roles.some((r) => user?.roles.includes(r as never)),
  );
  return (
    <section className="card">
      <div className="hero">
        <span className="avatar" aria-hidden="true">
          {user?.name.charAt(0).toUpperCase()}
        </span>
        <div>
          <h1>Welcome, {user?.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            Signed in as {user?.email}
          </p>
          <div className="chips" aria-label="Roles">
            {user?.roles.map((r) => (
              <span key={r} className="chip">
                {r}
              </span>
            ))}
          </div>
        </div>
      </div>

      {waiting !== null && waiting > 0 && (
        <Link to="/approvals" className="attention">
          <strong>
            {waiting} {waiting === 1 ? 'event is' : 'events are'} waiting for your approval
          </strong>
          <span>Review them now →</span>
        </Link>
      )}

      <h2>Coming up</h2>
      {upcoming === null ? (
        <p className="muted">Loading…</p>
      ) : upcoming.length === 0 ? (
        <p className="muted">No upcoming events yet.</p>
      ) : (
        <ul className="agenda" aria-label="Upcoming events">
          {upcoming.map((e) => (
            <li key={e.id}>
              <div>
                <Link to={`/events/${e.id}`}>{e.title}</Link>
                <span className="muted">
                  {formatDateTime(e.startAt)} · {e.organizerName ?? 'organizer'}
                </span>
              </div>
              <StatusBadge status={e.status} />
            </li>
          ))}
        </ul>
      )}

      <h2>Shortcuts</h2>
      <div className="tiles">
        {tiles.map((t) => (
          <Link key={t.to} to={t.to} className="tile">
            <strong>{t.title}</strong>
            <span>{t.hint}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
