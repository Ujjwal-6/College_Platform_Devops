import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { BookingSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { BookingBadge } from '../components/BookingBadge';
import { formatDateTime } from '../lib/datetime';

type Scope = 'mine' | 'approvals' | 'department';

export function Bookings({ initialScope }: { initialScope?: Scope }) {
  const { hasRole } = useAuth();
  const staff = hasRole('faculty', 'hod', 'admin');
  const tabs: { scope: Scope; label: string }[] = [
    { scope: 'mine', label: 'My bookings' },
    ...(staff
      ? [
          { scope: 'approvals' as const, label: 'Approval queue' },
          { scope: 'department' as const, label: 'Department' },
        ]
      : []),
  ];
  const [scope, setScope] = useState<Scope>(initialScope ?? 'mine');
  const [rows, setRows] = useState<BookingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    api<{ data: BookingSummary[] }>(`/bookings?scope=${scope}&limit=100`)
      .then((r) => !cancelled && setRows(r.data))
      .catch(() => !cancelled && setError('Could not load bookings.'));
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return (
    <section className="card">
      <h1>Hall bookings</h1>
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
      {!rows && !error && <p role="status">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="muted">
          {scope === 'approvals' ? 'No bookings are waiting for you.' : 'No bookings to show.'}
        </p>
      )}
      {rows && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Hall</th>
              <th>Event</th>
              <th>When</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td>
                  <Link to={`/bookings/${b.id}`}>{b.hallName ?? 'Hall'}</Link>
                </td>
                <td>{b.eventTitle ?? '—'}</td>
                <td>
                  {formatDateTime(b.startAt)} to {formatDateTime(b.endAt)}
                </td>
                <td>
                  <BookingBadge status={b.status} level={b.approvalLevel} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
