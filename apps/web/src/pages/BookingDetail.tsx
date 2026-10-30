import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { BookingDetail as Detail } from '../api/types';
import { BookingBadge, bookingLevelLabel } from '../components/BookingBadge';
import { formatDateTime } from '../lib/datetime';

type Panel = 'approve' | 'reject' | 'cancel' | null;
const ACTION: Record<string, string> = {
  request: 'Requested',
  update: 'Changed',
  approve: 'Approved',
  reject: 'Rejected',
  cancel: 'Cancelled',
};

export function BookingDetailPage() {
  const { id } = useParams();
  const [booking, setBooking] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setBooking((await api<{ data: Detail }>(`/bookings/${id}`)).data);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof ApiError && err.status === 404
          ? 'This booking does not exist or you cannot view it.'
          : 'Could not load the booking.',
      );
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  async function run(action: string, body: object) {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/bookings/${id}/${action}`, { method: 'POST', body });
      setPanel(null);
      setComment('');
      await load();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'Action failed.');
      if (err instanceof ApiError && err.status === 409) await load(); // someone else decided first: show the current state
    } finally {
      setBusy(false);
    }
  }

  if (loadError)
    return (
      <p role="alert" className="card error">
        {loadError}
      </p>
    );
  if (!booking) return <p role="status">Loading…</p>;
  const a = booking.actions;

  function confirmPanel() {
    if (panel === 'reject' && !comment.trim()) {
      setProblem('Please explain why you are rejecting this booking.');
      return;
    }
    if (panel === 'approve')
      void run('approve', {
        level: booking!.approvalLevel,
        ...(comment.trim() ? { comment } : {}),
      });
    if (panel === 'reject') void run('reject', { level: booking!.approvalLevel, comment });
    if (panel === 'cancel') void run('cancel', comment.trim() ? { comment } : {});
  }

  return (
    <article className="card">
      <div className="row">
        <h1>{booking.hall?.name ?? 'Hall booking'}</h1>
        <BookingBadge status={booking.status} level={booking.approvalLevel} />
      </div>
      {booking.event && (
        <p>
          For <Link to={`/events/${booking.event.id}`}>{booking.event.title}</Link>
        </p>
      )}
      <dl className="facts">
        <dt>When</dt>
        <dd>
          {formatDateTime(booking.startAt)} to {formatDateTime(booking.endAt)}
        </dd>
        <dt>Requested by</dt>
        <dd>{booking.requestedByName ?? '—'}</dd>
        <dt>Hall</dt>
        <dd>
          {booking.hall
            ? `${booking.hall.location || 'No location'}, seats ${booking.hall.capacity}${booking.hall.facilities.length ? `, ${booking.hall.facilities.join(', ')}` : ''}`
            : '—'}
        </dd>
        {booking.requiredFacilities.length > 0 && (
          <>
            <dt>Facilities asked for</dt>
            <dd>{booking.requiredFacilities.join(', ')}</dd>
          </>
        )}
        {booking.notes && (
          <>
            <dt>Notes</dt>
            <dd className="prewrap">{booking.notes}</dd>
          </>
        )}
      </dl>
      {!booking.coversEvent && booking.event && (
        <p className="notice notice-warn" role="note">
          This booking does not cover the whole event time ({formatDateTime(booking.event.startAt)}{' '}
          to {formatDateTime(booking.event.endAt)}).
        </p>
      )}
      {booking.warnings.length > 0 && (
        <div className="warnbox" role="note">
          <strong>Accepted warnings:</strong>
          <ul>
            {booking.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}
      {booking.closingComment && (
        <p className="notice notice-error" role="note">
          {booking.status === 'rejected' ? 'Rejected' : 'Cancelled'}: {booking.closingComment}
        </p>
      )}

      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="actions" aria-label="Booking actions">
        {a.canEdit && (
          <Link className="button" to={`/bookings/${booking.id}/edit`}>
            Change
          </Link>
        )}
        {a.canApprove && (
          <button
            disabled={busy}
            onClick={() => {
              setPanel('approve');
              setProblem(null);
            }}
          >
            Approve
          </button>
        )}
        {a.canApprove && (
          <button
            disabled={busy}
            onClick={() => {
              setPanel('reject');
              setProblem(null);
            }}
          >
            Reject
          </button>
        )}
        {a.canCancel && (
          <button
            disabled={busy}
            onClick={() => {
              setPanel('cancel');
              setProblem(null);
            }}
          >
            Cancel booking
          </button>
        )}
      </div>
      {panel && (
        <form
          className="panel"
          aria-label={`${panel} panel`}
          onSubmit={(e) => {
            e.preventDefault();
            confirmPanel();
          }}
        >
          <label>
            {panel === 'reject'
              ? 'Reason for rejecting (required)'
              : panel === 'cancel'
                ? 'Reason (required if this is not your own booking)'
                : 'Comment (optional)'}
            <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <div className="row">
            <button type="submit" disabled={busy}>
              {panel === 'approve'
                ? 'Confirm approval'
                : panel === 'reject'
                  ? 'Confirm rejection'
                  : 'Confirm cancellation'}
            </button>
            <button
              type="button"
              onClick={() => {
                setPanel(null);
                setComment('');
                setProblem(null);
              }}
            >
              Back
            </button>
          </div>
        </form>
      )}

      <h2>Approvals</h2>
      {booking.approvals.length === 0 ? (
        <p className="muted">No decisions yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Round</th>
              <th>Step</th>
              <th>Decision</th>
              <th>By</th>
              <th>When</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            {booking.approvals.map((d) => (
              <tr key={d.id}>
                <td>{d.round}</td>
                <td>{bookingLevelLabel(d.level)}</td>
                <td>{d.decision === 'approved' ? 'Approved' : 'Rejected'}</td>
                <td>{d.approverName ?? '—'}</td>
                <td>{formatDateTime(d.decidedAt)}</td>
                <td>{d.comment ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>History</h2>
      <ol className="timeline">
        {booking.history.map((h) => (
          <li key={h.id}>
            <strong>{ACTION[h.action] ?? h.action}</strong>
            {h.level ? ` (${bookingLevelLabel(h.level)})` : ''} by {h.actorName ?? 'system'} ·{' '}
            {formatDateTime(h.createdAt)}
            {h.comment ? ` — ${h.comment}` : ''}
          </li>
        ))}
      </ol>
    </article>
  );
}
