import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, fieldIssues } from '../api/client';
import type {
  AttendanceRow,
  AttendanceSummary,
  CheckInResult,
  Volunteer,
} from '../api/attendanceTypes';
import type { Registrant } from '../api/registrationTypes';
import type { EventDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { QrScanner } from '../components/QrScanner';
import { formatDateTime } from '../lib/datetime';

const REFRESH_MS = 5000;

type Outcome = { kind: 'ok' | 'error'; text: string };

/** The gate screen of one event: scan or type a pass, see who is in, and (organizer) check in by hand and manage volunteers. */
export function CheckIn() {
  const { id = '' } = useParams();
  const { user, hasRole } = useAuth();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [overview, setOverview] = useState<{
    summary: AttendanceSummary;
    data: AttendanceRow[];
  } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [typed, setTyped] = useState('');
  const working = useRef(false);

  const manager = !!event && !!user && (event.organizerId === user.id || hasRole('admin'));

  const refresh = useCallback(async () => {
    try {
      setOverview(
        await api<{ summary: AttendanceSummary; data: AttendanceRow[] }>(
          `/events/${id}/attendance?limit=15`,
        ),
      );
    } catch {
      // a missed refresh is not worth interrupting the person at the gate; the next one tries again
    }
  }, [id]);

  useEffect(() => {
    api<{ data: EventDetail }>(`/events/${id}`)
      .then((r) => setEvent(r.data))
      .catch(() => setLoadError('Could not load this event.'));
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [id, refresh]);

  /** One scan at a time: the camera can read the same pass many times a second. */
  const submitCode = useCallback(
    async (text: string) => {
      if (working.current) return;
      working.current = true;
      try {
        const res = await api<{ data: CheckInResult }>(`/events/${id}/check-ins`, {
          method: 'POST',
          body: { token: text.trim() },
        });
        const r = res.data;
        setOutcome({
          kind: 'ok',
          text: `${r.attendee.name} is checked in${r.team ? ` (team ${r.team})` : ''}.`,
        });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'ALREADY_CHECKED_IN') {
          const at = (err.details as { checkedInAt?: string } | undefined)?.checkedInAt;
          setOutcome({
            kind: 'error',
            text: `Already checked in${at ? ` at ${formatDateTime(at)}` : ''}.`,
          });
        } else {
          const issues = fieldIssues(err);
          setOutcome({
            kind: 'error',
            text: issues.length
              ? issues.map((i) => i.message).join(' ')
              : err instanceof ApiError
                ? err.message
                : 'Could not check in. Please try again.',
          });
        }
      } finally {
        working.current = false;
        await refresh();
      }
    },
    [id, refresh],
  );

  if (loadError) {
    return (
      <p role="alert" className="error">
        {loadError}
      </p>
    );
  }
  const summary = overview?.summary;
  return (
    <section className="card">
      <h1>Check-in{event ? `: ${event.title}` : ''}</h1>
      <p>
        <Link to={`/events/${id}`}>Back to the event</Link>
      </p>

      {summary && (
        <p aria-live="polite">
          <strong>
            {summary.checkedIn} of {summary.registered} checked in
          </strong>{' '}
          · {summary.remaining} still to come
        </p>
      )}
      {summary && !summary.open && (
        <p className="muted">
          Check-in is closed right now. It is open from {formatDateTime(summary.opensAt)} until{' '}
          {formatDateTime(summary.closesAt)}.
        </p>
      )}

      <div className="row">
        <button onClick={() => setCamera((c) => !c)} disabled={summary ? !summary.open : false}>
          {camera ? 'Stop camera' : 'Start camera'}
        </button>
      </div>
      <QrScanner active={camera} onCode={(text) => void submitCode(text)} />

      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!typed.trim()) return;
          void submitCode(typed).then(() => setTyped(''));
        }}
      >
        <label>
          Pass code (type or paste)
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
        <button type="submit" disabled={summary ? !summary.open : false}>
          Check in
        </button>
      </form>

      {outcome &&
        (outcome.kind === 'ok' ? (
          <p role="status" className="notice">
            ✓ {outcome.text}
          </p>
        ) : (
          <p role="alert" className="error">
            {outcome.text}
          </p>
        ))}

      <h2>Latest check-ins</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Time (India)</th>
            <th>How</th>
          </tr>
        </thead>
        <tbody>
          {overview?.data.map((r) => (
            <tr key={r.id}>
              <td>{r.attendee.name}</td>
              <td>{formatDateTime(r.checkedInAt)}</td>
              <td>
                {r.method === 'qr' ? 'Scanned' : `By hand (${r.reason ?? ''})`} · {r.checkedInBy}
              </td>
            </tr>
          ))}
          {overview && overview.data.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                Nobody has checked in yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {manager && <ManualCheckIn eventId={id} onDone={refresh} setOutcome={setOutcome} />}
      {manager && <Volunteers eventId={id} />}
    </section>
  );
}

function ManualCheckIn({
  eventId,
  onDone,
  setOutcome,
}: {
  eventId: string;
  onDone: () => Promise<void>;
  setOutcome: (o: Outcome) => void;
}) {
  const [people, setPeople] = useState<Registrant[]>([]);
  const [registrationId, setRegistrationId] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    api<{ data: Registrant[] }>(`/events/${eventId}/registrations?status=registered&limit=100`)
      .then((r) => setPeople(r.data))
      .catch(() => setPeople([]));
  }, [eventId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api<{ data: CheckInResult }>(`/events/${eventId}/check-ins/manual`, {
        method: 'POST',
        body: { registrationId, reason },
      });
      setOutcome({ kind: 'ok', text: `${res.data.attendee.name} is checked in by hand.` });
      setReason('');
    } catch (err) {
      const issues = fieldIssues(err);
      setOutcome({
        kind: 'error',
        text: issues.length
          ? issues.map((i) => i.message).join(' ')
          : err instanceof ApiError
            ? err.message
            : 'Could not check in.',
      });
    }
    await onDone();
  }

  return (
    <>
      <h2>Check in by hand</h2>
      <p className="muted">For a pass that cannot be scanned. The reason is recorded.</p>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Person
          <select
            value={registrationId}
            onChange={(e) => setRegistrationId(e.target.value)}
            required
          >
            <option value="">Choose…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.user.name} ({p.user.email})
              </option>
            ))}
          </select>
        </label>
        <label>
          Reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            required
          />
        </label>
        <button type="submit">Check in by hand</button>
      </form>
    </>
  );
}

function Volunteers({ eventId }: { eventId: string }) {
  const [list, setList] = useState<Volunteer[]>([]);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Volunteer[] }>(`/events/${eventId}/volunteers`)
      .then((r) => setList(r.data))
      .catch(() => setError('Could not load volunteers.'));
  }, [eventId]);

  async function change(run: () => Promise<{ data: Volunteer[] }>) {
    setError(null);
    try {
      setList((await run()).data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }

  return (
    <>
      <h2>Volunteers</h2>
      <p className="muted">
        Volunteers can scan passes for this event. Add them by their account email.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ul>
        {list.map((v) => (
          <li key={v.userId}>
            {v.name} ({v.email}){' '}
            <button
              aria-label={`Remove ${v.name}`}
              onClick={() =>
                void change(() =>
                  api(`/events/${eventId}/volunteers/${v.userId}`, { method: 'DELETE' }),
                )
              }
            >
              Remove
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="muted">No volunteers yet.</li>}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void change(() =>
            api(`/events/${eventId}/volunteers`, { method: 'POST', body: { email } }),
          ).then(() => setEmail(''));
        }}
      >
        <label>
          Volunteer email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <button type="submit">Add volunteer</button>
      </form>
    </>
  );
}
