import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, fieldIssues } from '../api/client';
import type {
  AttendanceRow,
  AttendanceSettings,
  AttendanceSummary,
  CheckInResult,
  CheckOutResult,
  Volunteer,
} from '../api/attendanceTypes';
import type { Registrant } from '../api/registrationTypes';
import type { EventDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { QrScanner } from '../components/QrScanner';
import { formatDateTime } from '../lib/datetime';

const REFRESH_MS = 5000;

type Outcome = { kind: 'ok' | 'error'; text: string };
type Mode = 'in' | 'out';

const errorText = (err: unknown, fallback: string): string => {
  const issues = fieldIssues(err);
  if (issues.length) return issues.map((i) => i.message).join(' ');
  return err instanceof ApiError ? err.message : fallback;
};

const duration = (minutes: number) =>
  minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;

const checkOutText = (r: CheckOutResult, how = '') =>
  `${r.attendee.name} is checked out${how} after ${duration(r.stayedMinutes)}${
    r.leftEarly ? '. Left early.' : '.'
  }`;

/**
 * The gate screen of one event: scan or type a pass when people arrive and again when they leave, see who
 * is in, and (organizer) allow walk-ins, check in or out by hand and manage volunteers.
 */
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
  const [denied, setDenied] = useState(false);
  const [camera, setCamera] = useState(false);
  const [mode, setMode] = useState<Mode>('in');
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
    } catch (err) {
      // someone who may not check people in for this event is told so; any other missed refresh is not
      // worth interrupting the person at the gate, and the next one tries again
      if (err instanceof ApiError && err.status === 403) setDenied(true);
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
        const body = { token: text.trim() };
        if (mode === 'in') {
          const res = await api<{ data: CheckInResult }>(`/events/${id}/check-ins`, {
            method: 'POST',
            body,
          });
          const r = res.data;
          setOutcome({
            kind: 'ok',
            text: `${r.attendee.name} is checked in${r.team ? ` (team ${r.team})` : ''}.`,
          });
        } else {
          const res = await api<{ data: CheckOutResult }>(`/events/${id}/check-outs`, {
            method: 'POST',
            body,
          });
          setOutcome({ kind: 'ok', text: checkOutText(res.data) });
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'ALREADY_CHECKED_IN') {
          const at = (err.details as { checkedInAt?: string } | undefined)?.checkedInAt;
          setOutcome({
            kind: 'error',
            text: `Already checked in${at ? ` at ${formatDateTime(at)}` : ''}.`,
          });
        } else if (err instanceof ApiError && err.code === 'ALREADY_CHECKED_OUT') {
          const at = (err.details as { checkedOutAt?: string } | undefined)?.checkedOutAt;
          setOutcome({
            kind: 'error',
            text: `Already checked out${at ? ` at ${formatDateTime(at)}` : ''}.`,
          });
        } else {
          setOutcome({
            kind: 'error',
            text: errorText(err, 'Could not record that. Please try again.'),
          });
        }
      } finally {
        working.current = false;
        await refresh();
      }
    },
    [id, mode, refresh],
  );

  if (denied) {
    return (
      <section className="card">
        <h1>Check-in</h1>
        <p role="alert">
          You cannot check people in for this event. Only its organizer, the volunteers the
          organizer added, and admins can.
        </p>
        <p>
          <Link className="button" to={`/events/${id}`}>
            Back to the event
          </Link>
        </p>
      </section>
    );
  }
  if (loadError) {
    return (
      <section className="card">
        <h1>Check-in</h1>
        <p role="alert" className="error">
          {loadError}
        </p>
      </section>
    );
  }
  const summary = overview?.summary;
  const windowOpen = summary ? (mode === 'in' ? summary.open : summary.checkOutOpen) : true;
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
          · {summary.remaining} still to come · {summary.inside} inside · {summary.checkedOut} left
          {summary.settings.requireCheckOut ? ` · ${summary.completed} stayed to the end` : ''}
        </p>
      )}
      {summary && !windowOpen && (
        <p className="muted">
          {mode === 'in'
            ? `Check-in is closed right now. It is open from ${formatDateTime(summary.opensAt)} until ${formatDateTime(summary.closesAt)}.`
            : `Check-out is closed right now. It is open from ${formatDateTime(summary.opensAt)} until ${formatDateTime(summary.checkOutClosesAt)}.`}
        </p>
      )}

      <fieldset>
        <legend>What are you recording?</legend>
        <label>
          <input type="radio" name="mode" checked={mode === 'in'} onChange={() => setMode('in')} />
          Arriving
        </label>{' '}
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'out'}
            onChange={() => setMode('out')}
          />
          Leaving
        </label>
      </fieldset>

      <div className="row">
        <button onClick={() => setCamera((c) => !c)} disabled={!windowOpen}>
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
        <button type="submit" disabled={!windowOpen}>
          {mode === 'in' ? 'Check in' : 'Check out'}
        </button>
      </form>

      {summary?.settings.allowWalkIns && (
        <WalkIn
          eventId={id}
          disabled={!summary.open}
          overCapacity={summary.settings.walkInsOverCapacity}
          onDone={refresh}
          setOutcome={setOutcome}
        />
      )}

      {outcome &&
        (outcome.kind === 'ok' ? (
          <p role="status" className="notice notice-ok">
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
            <th>In (India)</th>
            <th>How</th>
            <th>Out</th>
          </tr>
        </thead>
        <tbody>
          {overview?.data.map((r) => (
            <tr key={r.id}>
              <td>{r.attendee.name}</td>
              <td>{formatDateTime(r.checkedInAt)}</td>
              <td>
                {r.method === 'qr'
                  ? 'Scanned'
                  : r.method === 'walk_in'
                    ? 'Walk-in'
                    : `By hand (${r.reason ?? ''})`}{' '}
                · {r.checkedInBy}
              </td>
              <td>
                {r.checkedOutAt
                  ? `${formatDateTime(r.checkedOutAt)}${r.leftEarly ? ' (left early)' : ''}${
                      r.checkOutMethod === 'manual' ? ` by hand (${r.checkOutReason ?? ''})` : ''
                    }`
                  : 'Inside'}
              </td>
            </tr>
          ))}
          {overview && overview.data.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Nobody has checked in yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {manager && summary && <Settings eventId={id} settings={summary.settings} onDone={refresh} />}
      {manager && <ManualEntry eventId={id} onDone={refresh} setOutcome={setOutcome} />}
      {manager && <Volunteers eventId={id} />}
    </section>
  );
}

function WalkIn({
  eventId,
  disabled,
  overCapacity,
  onDone,
  setOutcome,
}: {
  eventId: string;
  disabled: boolean;
  overCapacity: boolean;
  onDone: () => Promise<void>;
  setOutcome: (o: Outcome) => void;
}) {
  const [email, setEmail] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api<{ data: CheckInResult }>(`/events/${eventId}/check-ins/walk-in`, {
        method: 'POST',
        body: { email },
      });
      setOutcome({
        kind: 'ok',
        text: `${res.data.attendee.name} is registered and checked in as a walk-in.`,
      });
      setEmail('');
    } catch (err) {
      setOutcome({ kind: 'error', text: errorText(err, 'Could not check the walk-in in.') });
    }
    await onDone();
  }

  return (
    <>
      <h2>Walk-in</h2>
      <p className="muted">
        For someone without a registration. They need an account and they take a seat.{' '}
        {overCapacity
          ? 'The organizer allowed walk-ins beyond the seat limit.'
          : 'A full event refuses them.'}
      </p>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Walk-in’s account email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <button type="submit" disabled={disabled}>
          Check in walk-in
        </button>
      </form>
    </>
  );
}

function Settings({
  eventId,
  settings,
  onDone,
}: {
  eventId: string;
  settings: AttendanceSettings;
  onDone: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  async function change(patch: Partial<AttendanceSettings>) {
    setError(null);
    try {
      await api(`/events/${eventId}/attendance-settings`, { method: 'PUT', body: patch });
    } catch (err) {
      setError(errorText(err, 'Could not save the setting.'));
    }
    await onDone();
  }

  return (
    <>
      <h2>Settings for this event</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p>
        <label>
          <input
            type="checkbox"
            checked={settings.allowWalkIns}
            onChange={(e) => void change({ allowWalkIns: e.target.checked })}
          />
          Allow walk-ins (people without a registration)
        </label>
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            checked={settings.walkInsOverCapacity}
            disabled={!settings.allowWalkIns}
            onChange={(e) => void change({ walkInsOverCapacity: e.target.checked })}
          />
          Let walk-ins take seats beyond the seat limit
        </label>
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            checked={settings.requireCheckOut}
            onChange={(e) => void change({ requireCheckOut: e.target.checked })}
          />
          Require check-out (someone counts as having attended only if they stay to the end)
        </label>
      </p>
    </>
  );
}

function ManualEntry({
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

  async function record(kind: 'in' | 'out') {
    if (!registrationId || reason.trim().length < 3) {
      setOutcome({
        kind: 'error',
        text: 'Choose the person and give a reason (at least 3 characters).',
      });
      return;
    }
    try {
      if (kind === 'in') {
        const res = await api<{ data: CheckInResult }>(`/events/${eventId}/check-ins/manual`, {
          method: 'POST',
          body: { registrationId, reason },
        });
        setOutcome({ kind: 'ok', text: `${res.data.attendee.name} is checked in by hand.` });
      } else {
        const res = await api<{ data: CheckOutResult }>(`/events/${eventId}/check-outs/manual`, {
          method: 'POST',
          body: { registrationId, reason },
        });
        setOutcome({ kind: 'ok', text: checkOutText(res.data, ' by hand') });
      }
      setReason('');
    } catch (err) {
      setOutcome({ kind: 'error', text: errorText(err, 'Could not record that.') });
    }
    await onDone();
  }

  return (
    <>
      <h2>Record by hand</h2>
      <p className="muted">For a pass that cannot be scanned. The reason is recorded.</p>
      <form onSubmit={(e) => e.preventDefault()}>
        <label>
          Person
          <select value={registrationId} onChange={(e) => setRegistrationId(e.target.value)}>
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
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </label>
        <button type="button" onClick={() => void record('in')}>
          Check in by hand
        </button>{' '}
        <button type="button" onClick={() => void record('out')}>
          Check out by hand
        </button>
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
              className="danger"
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
