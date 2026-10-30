import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fieldIssues } from '../api/client';
import {
  newIdempotencyKey,
  type Registrant,
  type RegistrationSummary,
  type TeamView,
} from '../api/registrationTypes';
import type { EventDetail } from '../api/types';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../lib/datetime';
import { MyPass } from './MyPass';

interface ShownCode {
  code: string;
  expiresAt: string;
}

const PAGE = 100;

/** Registration for one event: seats, register / team / join, the person's own status, and (for staff) who registered. */
export function EventRegistration({ event }: { event: EventDetail }) {
  const { user, hasRole } = useAuth();
  const manager = event.organizerId === user?.id || hasRole('admin');
  const staff = event.workflow !== null; // the server only sends the workflow to the owner, admins and department staff
  const [summary, setSummary] = useState<RegistrationSummary | null>(null);
  const [team, setTeam] = useState<TeamView | null>(null);
  const [registrants, setRegistrants] = useState<{ rows: Registrant[]; total: number } | null>(
    null,
  );
  const [waiting, setWaiting] = useState<Registrant[]>([]);
  const [shown, setShown] = useState<ShownCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [code, setCode] = useState('');

  const load = useCallback(async () => {
    try {
      const s = (
        await api<{ data: RegistrationSummary }>(`/events/${event.id}/registration-summary`)
      ).data;
      setSummary(s);
      setTeam(
        s.mine?.status === 'registered' && s.mine.team
          ? (await api<{ data: TeamView }>(`/teams/${s.mine.team.id}`)).data
          : null,
      );
      if (staff) {
        const r = await api<{ data: Registrant[]; page: { total: number } }>(
          `/events/${event.id}/registrations?status=registered&limit=${PAGE}`,
        );
        setRegistrants({ rows: r.data, total: r.page.total });
        setWaiting(
          s.waitlisted > 0
            ? (
                await api<{ data: Registrant[] }>(
                  `/events/${event.id}/registrations?status=waitlisted&limit=${PAGE}`,
                )
              ).data
            : [],
        );
      }
    } catch {
      setError('Could not load registration details.');
    }
  }, [event.id, staff]);
  useEffect(() => void load(), [load]);

  /** Runs one action, then reloads. Buttons stay disabled meanwhile, so a double click is one request. */
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const issues = fieldIssues(err);
      setError(
        issues.length
          ? issues.map((i) => i.message).join(' ')
          : err instanceof ApiError
            ? err.message
            : 'Something went wrong. Please try again.',
      );
    } finally {
      setBusy(false);
    }
    await load();
  }

  const post = (path: string, body: object = {}, key = false) =>
    api<{ data: Record<string, unknown> }>(path, {
      method: 'POST',
      body,
      headers: key ? { 'Idempotency-Key': newIdempotencyKey() } : undefined,
    });

  if (event.status === 'draft' || !summary) {
    return error ? (
      <p role="alert" className="error">
        {error}
      </p>
    ) : null;
  }

  const mine = summary.mine?.status === 'registered' ? summary.mine : null;
  const queued = summary.mine?.status === 'waitlisted' ? summary.mine : null;
  const started = Date.parse(event.startAt) <= Date.now();
  const showSection =
    event.status !== 'pending_approval' &&
    (summary.open || mine || queued || staff || summary.registered > 0);
  if (!showSection) return null;

  return (
    <>
      <h2>Registration</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p>
        {summary.capacity === null
          ? `${summary.registered} registered · no seat limit`
          : `${summary.registered} of ${summary.capacity} seats taken · ${summary.seatsLeft} left`}
        {summary.waitlisted > 0 ? ` · ${summary.waitlisted} waiting` : ''}
        {event.registrationMode === 'team' && event.teamSizeMin !== null
          ? ` · teams of ${event.teamSizeMin} to ${event.teamSizeMax}`
          : ''}
      </p>
      {manager && event.status === 'published' && (
        <p>
          <Link to={`/events/${event.id}/check-in`}>Open check-in for this event</Link>
        </p>
      )}
      {!summary.open && !mine && !queued && <p className="muted">Registration is closed.</p>}
      {summary.open && summary.full && !mine && !queued && (
        <p className="muted">This event is full.</p>
      )}
      {summary.waitlistOpen && !mine && !queued && (
        <button
          disabled={busy}
          onClick={() =>
            void act(
              async () =>
                void (await post(`/events/${event.id}/registrations`, { waitlist: true }, true)),
            )
          }
        >
          Join the waitlist
        </button>
      )}

      {queued && (
        <div className="notice notice-warn">
          <p>
            <strong>You are on the waitlist</strong> (place {queued.waitlistPosition}). If a seat
            opens you are registered automatically and we email you.
          </p>
          {!started && (
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void act(async () => void (await post(`/registrations/${queued.id}/cancel`)))
              }
            >
              Leave the waitlist
            </button>
          )}
        </div>
      )}

      {mine && (
        <>
          <div className="notice notice-ok">
            <p>
              <strong>You are registered</strong>
              {mine.team ? ` as part of the team “${mine.team.name}”` : ''}.
            </p>
            {!started && (
              <button
                className="danger"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await post(`/registrations/${mine.id}/cancel`);
                    setShown(null);
                  })
                }
              >
                {mine.team && mine.team.isLeader
                  ? 'Leave the team and cancel'
                  : 'Cancel registration'}
              </button>
            )}
          </div>
          <MyPass key={mine.id} registrationId={mine.id} />
        </>
      )}

      {!mine && summary.open && !summary.full && event.registrationMode === 'individual' && (
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => void (await post(`/events/${event.id}/registrations`, {}, true)))
          }
        >
          Register
        </button>
      )}

      {!mine && summary.open && !summary.full && event.registrationMode === 'team' && (
        <div className="row">
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void act(async () => {
                const res = await post(`/events/${event.id}/teams`, { name: teamName }, true);
                const data = res.data as { invitationCode: string; invitationExpiresAt: string };
                setShown({ code: data.invitationCode, expiresAt: data.invitationExpiresAt });
                setTeamName('');
              });
            }}
          >
            <label>
              Team name
              <input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                maxLength={60}
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              Create team
            </button>
          </form>
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void act(async () => {
                await post('/teams/join', { code }, true);
                setCode('');
              });
            }}
          >
            <label>
              Invitation code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={64}
                required
                autoComplete="off"
              />
            </label>
            <button type="submit" disabled={busy}>
              Join team
            </button>
          </form>
        </div>
      )}

      {shown && (
        <div className="notice" role="status">
          <p>
            Invitation code (shown only now, valid until {formatDateTime(shown.expiresAt)}):{' '}
            <strong>{shown.code}</strong>
          </p>
          <p className="muted">
            Share it with your team mates. Keep it private: anyone with it can join while there is
            room.
          </p>
        </div>
      )}

      {team && (
        <>
          <h3>Team “{team.name}”</h3>
          <p>
            {team.size} {team.size === 1 ? 'member' : 'members'}
            {team.maxSize !== null ? ` of up to ${team.maxSize}` : ''}
            {!team.complete && team.minSize !== null
              ? ` · needs at least ${team.minSize} members (${team.minSize - team.size} more)`
              : ''}
          </p>
          <ul>
            {team.members.map((m) => (
              <li key={m.registrationId}>
                {m.name}
                {m.isLeader ? ' (leader)' : ''}
              </li>
            ))}
          </ul>
          {team.invitation && (
            <p className="row">
              <span className="muted">
                {team.invitation.active
                  ? `Invitation code active until ${formatDateTime(team.invitation.expiresAt!)}`
                  : 'No active invitation code'}
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const res = await post(`/teams/${team.id}/invitation`);
                    const data = res.data as {
                      invitationCode: string;
                      invitationExpiresAt: string;
                    };
                    setShown({ code: data.invitationCode, expiresAt: data.invitationExpiresAt });
                  })
                }
              >
                New invitation code
              </button>
              {team.invitation.active && (
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await post(`/teams/${team.id}/invitation/revoke`);
                      setShown(null);
                    })
                  }
                >
                  Turn off code
                </button>
              )}
            </p>
          )}
        </>
      )}

      {staff && waiting.length > 0 && (
        <>
          <h3>Waiting list</h3>
          <table>
            <thead>
              <tr>
                <th>Place</th>
                <th>Name</th>
                <th>Email</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((r) => (
                <tr key={r.id}>
                  <td>{r.waitlistPosition}</td>
                  <td>{r.user.name}</td>
                  <td>{r.user.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {staff && registrants && (
        <>
          <h3>Registered people</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Team</th>
                <th>Registered (India)</th>
              </tr>
            </thead>
            <tbody>
              {registrants.rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.user.name}</td>
                  <td>{r.user.email}</td>
                  <td>{r.team ? r.team.name : '—'}</td>
                  <td>{formatDateTime(r.registeredAt)}</td>
                </tr>
              ))}
              {registrants.rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Nobody has registered yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {registrants.total > PAGE && (
            <p className="muted">
              Showing the first {PAGE} of {registrants.total}.
            </p>
          )}
        </>
      )}
    </>
  );
}
