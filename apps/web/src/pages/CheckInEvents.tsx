import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { CheckInEvent } from '../api/attendanceTypes';
import { formatDateTime } from '../lib/datetime';

const ROLE: Record<CheckInEvent['role'], string> = {
  admin: 'Admin',
  organizer: 'Organizer',
  volunteer: 'Volunteer',
};

/** The events this person can scan gate passes for right now (organizer, volunteer or admin). */
export function CheckInEvents() {
  const [events, setEvents] = useState<CheckInEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: CheckInEvent[] }>('/check-in/events')
      .then((r) => setEvents(r.data))
      .catch(() => setError('Could not load your events.'));
  }, []);

  return (
    <section className="card">
      <h1>Check-in</h1>
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
            <th>Your role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {events?.map((e) => (
            <tr key={e.id}>
              <td>{e.title}</td>
              <td>{formatDateTime(e.startAt)}</td>
              <td>{ROLE[e.role]}</td>
              <td>
                <Link to={`/events/${e.id}/check-in`}>Open check-in</Link>
              </td>
            </tr>
          ))}
          {events && events.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                You are not set up to check anyone in for an upcoming event. An organizer can add
                you as a volunteer.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
