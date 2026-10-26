import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, fieldIssues } from '../api/client';
import type { BookingSummary, EventDetail, Reservation, ResourceAvailability } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../lib/datetime';
import { BookingBadge } from './BookingBadge';

/** Hall bookings and resource reservations of one event, shown on the event page to people who may see its workflow. */
export function EventBookings({ event }: { event: EventDetail }) {
  const { user, hasRole } = useAuth();
  const manager = user?.id === event.organizerId || hasRole('admin');
  const beforeStart = Date.parse(event.startAt) > Date.now();
  const canBook =
    manager &&
    beforeStart &&
    ['draft', 'pending_approval', 'approved', 'published'].includes(event.status);
  const canReserve = manager && beforeStart && ['approved', 'published'].includes(event.status);

  const [bookings, setBookings] = useState<BookingSummary[] | null>(null);
  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [resources, setResources] = useState<ResourceAvailability[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, r] = await Promise.all([
        api<{ data: BookingSummary[] }>(`/bookings?scope=event&eventId=${event.id}&limit=100`),
        api<{ data: Reservation[] }>(`/resource-reservations?eventId=${event.id}`),
      ]);
      setBookings(b.data);
      setReservations(r.data);
      if (canReserve) {
        const q = new URLSearchParams({ startAt: event.startAt, endAt: event.endAt });
        setResources(
          (await api<{ data: ResourceAvailability[] }>(`/resources/availability?${q}`)).data,
        );
      }
    } catch {
      setError('Could not load bookings and resources.');
    }
  }, [event.id, event.startAt, event.endAt, canReserve]);
  useEffect(() => void load(), [load]);

  return (
    <>
      <h2>Hall bookings</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {bookings && bookings.length === 0 && <p className="muted">No hall booked yet.</p>}
      {bookings && bookings.length > 0 && (
        <table aria-label="Hall bookings">
          <thead>
            <tr>
              <th>Hall</th>
              <th>When</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id}>
                <td>
                  <Link to={`/bookings/${b.id}`}>{b.hallName ?? 'Hall'}</Link>
                </td>
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
      {canBook && (
        <Link className="button" to={`/events/${event.id}/book`}>
          Book a hall
        </Link>
      )}

      <h2>Equipment and resources</h2>
      {!canReserve &&
        manager &&
        beforeStart &&
        event.status !== 'cancelled' &&
        event.status !== 'closed' && (
          <p className="muted">Equipment can be reserved once the event is fully approved.</p>
        )}
      {reservations && reservations.length === 0 && <p className="muted">Nothing reserved yet.</p>}
      {reservations && reservations.length > 0 && (
        <table aria-label="Resource reservations">
          <thead>
            <tr>
              <th>Resource</th>
              <th>Units</th>
              <th>When</th>
              <th>Status</th>
              {manager && <th />}
            </tr>
          </thead>
          <tbody>
            {reservations.map((r) => (
              <tr key={r.id}>
                <td>{r.resourceName}</td>
                <td>{r.quantity}</td>
                <td>
                  {formatDateTime(r.startAt)} to {formatDateTime(r.endAt)}
                </td>
                <td>
                  {r.status === 'confirmed'
                    ? 'Reserved'
                    : `Released${r.releaseReason ? ` (${r.releaseReason})` : ''}`}
                </td>
                {manager && (
                  <td>
                    {r.status === 'confirmed' && (
                      <button
                        aria-label={`Release ${r.resourceName}`}
                        onClick={() =>
                          void api(`/resource-reservations/${r.id}/release`, {
                            method: 'POST',
                            body: {},
                          })
                            .then(load)
                            .catch(() => setError('Could not release the reservation.'))
                        }
                      >
                        Release
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canReserve && <ReserveForm eventId={event.id} resources={resources} onDone={load} />}
    </>
  );
}

function ReserveForm({
  eventId,
  resources,
  onDone,
}: {
  eventId: string;
  resources: ResourceAvailability[];
  onDone: () => Promise<void>;
}) {
  const [resourceId, setResourceId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/resource-reservations', {
        method: 'POST',
        body: { eventId, resourceId, quantity: Number(quantity) },
      });
      setQuantity('1');
      await onDone();
    } catch (err) {
      const issues = fieldIssues(err);
      setError(
        issues.length
          ? issues.map((i) => i.message).join('. ')
          : err instanceof ApiError
            ? err.message
            : 'Could not reserve.',
      );
    }
  }

  return (
    <form onSubmit={submit} aria-label="Reserve equipment" className="inline-form">
      <label>
        Resource
        <select required value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
          <option value="">Choose…</option>
          {resources
            .filter((r) => r.resource.status === 'available')
            .map((r) => (
              <option key={r.resource.id} value={r.resource.id}>
                {r.resource.name} ({r.available} free)
              </option>
            ))}
        </select>
      </label>
      <label>
        Units
        <input
          type="number"
          min={1}
          required
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </label>
      <button type="submit">Reserve</button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}
