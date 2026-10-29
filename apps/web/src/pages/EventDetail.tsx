import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { EventDetail as Detail } from '../api/types';
import { EventBookings } from '../components/EventBookings';
import { EventRegistration } from '../components/EventRegistration';
import { levelLabel, StatusBadge } from '../components/StatusBadge';
import { formatDate, formatDateTime } from '../lib/datetime';

type Panel = 'approve' | 'reject' | 'cancel' | 'revise' | null;

const ACTION_LABEL: Record<string, string> = {
  create: 'Created',
  update: 'Edited',
  submit: 'Submitted for approval',
  withdraw: 'Withdrawn',
  approve: 'Approved',
  reject: 'Rejected',
  publish: 'Published',
  unpublish: 'Unpublished',
  revise: 'Revised (back to draft)',
  cancel: 'Cancelled',
  close: 'Closed',
};

export function EventDetailPage() {
  const { id } = useParams();
  const [event, setEvent] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [problem, setProblem] = useState<ApiError | string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setEvent((await api<{ data: Detail }>(`/events/${id}`)).data);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof ApiError && err.status === 404
          ? 'This event does not exist or you cannot view it.'
          : 'Could not load the event.',
      );
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  async function run(action: string, body?: object) {
    setBusy(true);
    setProblem(null);
    try {
      await api(`/events/${id}/${action}`, { method: 'POST', body: body ?? {} });
      setPanel(null);
      setComment('');
      await load();
    } catch (err) {
      setProblem(err instanceof ApiError ? err : 'Action failed.');
      if (err instanceof ApiError && err.status === 409) await load(); // someone else changed it: show the current state
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
  if (!event) return <p role="status">Loading…</p>;
  const a = event.actions;
  const needsComment = panel === 'reject' || panel === 'cancel';

  const submitPanel = () => {
    if (needsComment && !comment.trim()) {
      setProblem(
        panel === 'reject'
          ? 'Please explain why you are rejecting this event.'
          : 'Please give a reason for cancelling.',
      );
      return;
    }
    if (panel === 'approve')
      void run('approve', { level: event.approvalLevel, ...(comment.trim() ? { comment } : {}) });
    if (panel === 'reject') void run('reject', { level: event.approvalLevel, comment });
    if (panel === 'cancel') void run('cancel', { comment });
    if (panel === 'revise') void run('revise');
  };

  return (
    <article className="card">
      <div className="row">
        <h1>{event.title}</h1>
        <StatusBadge status={event.status} level={event.approvalLevel} />
      </div>
      <p className="muted">
        {event.category} · organised by {event.organizerName ?? 'unknown'}
      </p>

      {event.status === 'draft' && event.lastRejection && (
        <p className="notice notice-error" role="note">
          Rejected at the {levelLabel(event.lastRejection.level)} level: “
          {event.lastRejection.comment}”. Edit the event and submit it again.
        </p>
      )}
      {event.status === 'cancelled' && event.cancelReason && (
        <p className="notice notice-error" role="note">
          Cancelled: {event.cancelReason}
        </p>
      )}
      {event.calendar && event.calendar.blocks.length > 0 && (
        <p className="notice" role="note">
          Heads-up: these dates fall on a restricted academic period (
          {event.calendar.blocks
            .map((b) => `${b.title}, ${formatDate(b.startDate)}–${formatDate(b.endDate)}`)
            .join('; ')}
          ). This is only a suggestion: you can still submit the event, and approvers will see it.
        </p>
      )}
      {event.calendar && event.calendar.warnings.length > 0 && (
        <p className="notice" role="note">
          Heads-up: these dates overlap{' '}
          {event.calendar.warnings
            .map((w) => `${w.title} (${formatDate(w.startDate)}–${formatDate(w.endDate)})`)
            .join('; ')}
          . Approvers will see this.
        </p>
      )}

      <dl className="facts">
        <dt>Starts</dt>
        <dd>{formatDateTime(event.startAt)}</dd>
        <dt>Ends</dt>
        <dd>{formatDateTime(event.endAt)}</dd>
        <dt>Expected attendance</dt>
        <dd>{event.expectedAttendance}</dd>
        <dt>Registration</dt>
        <dd>
          {event.registrationMode === 'team'
            ? `Teams of ${event.teamSizeMin}–${event.teamSizeMax}`
            : 'Individuals'}
          {event.capacity ? `, capacity ${event.capacity}` : ''}
          {event.registrationDeadline
            ? `, closes ${formatDateTime(event.registrationDeadline)}`
            : ''}
          {event.registrationEligible ? ' (open)' : ''}
        </dd>
      </dl>
      {event.description && <p className="prewrap">{event.description}</p>}
      {event.speakers.length > 0 && (
        <>
          <h2>Speakers</h2>
          <ul>
            {event.speakers.map((s, i) => (
              <li key={i}>{[s.name, s.designation, s.organization].filter(Boolean).join(', ')}</li>
            ))}
          </ul>
        </>
      )}

      {problem && (
        <div role="alert" className="error">
          <p>{typeof problem === 'string' ? problem : problem.message}</p>
        </div>
      )}

      <div className="actions" aria-label="Event actions">
        {a.canEdit && (
          <Link className="button" to={`/events/${event.id}/edit`}>
            Edit
          </Link>
        )}
        {a.canSubmit && (
          <button disabled={busy} onClick={() => void run('submit')}>
            Submit for approval
          </button>
        )}
        {a.canWithdraw && (
          <button disabled={busy} onClick={() => void run('withdraw')}>
            Withdraw
          </button>
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
        {a.canPublish && (
          <button disabled={busy} onClick={() => void run('publish')}>
            Publish
          </button>
        )}
        {a.canUnpublish && (
          <button disabled={busy} onClick={() => void run('unpublish')}>
            Unpublish
          </button>
        )}
        {a.canRevise && (
          <button
            disabled={busy}
            onClick={() => {
              setPanel('revise');
              setProblem(null);
            }}
          >
            Revise
          </button>
        )}
        {a.canClose && (
          <button disabled={busy} onClick={() => void run('close')}>
            Close event
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
            Cancel event
          </button>
        )}
      </div>

      {panel && (
        <form
          className="panel"
          aria-label={`${panel} panel`}
          onSubmit={(e) => {
            e.preventDefault();
            submitPanel();
          }}
        >
          {panel === 'revise' ? (
            <p>
              Revising returns this event to draft
              {event.status === 'published' ? ' and unpublishes it' : ''}. It will need to be
              approved again.
            </p>
          ) : (
            <label>
              {panel === 'approve'
                ? 'Comment (optional)'
                : panel === 'reject'
                  ? 'Reason for rejecting (required)'
                  : 'Reason for cancelling (required)'}
              <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
          )}
          <div className="row">
            <button type="submit" disabled={busy}>
              {panel === 'approve'
                ? 'Confirm approval'
                : panel === 'reject'
                  ? 'Confirm rejection'
                  : panel === 'cancel'
                    ? 'Confirm cancellation'
                    : 'Confirm revision'}
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

      {event.workflow && (
        <>
          <h2>Approvals</h2>
          {event.workflow.approvals.length === 0 ? (
            <p className="muted">No decisions yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Level</th>
                  <th>Decision</th>
                  <th>By</th>
                  <th>When</th>
                  <th>Comment</th>
                </tr>
              </thead>
              <tbody>
                {event.workflow.approvals.map((d) => (
                  <tr key={d.id}>
                    <td>{d.round}</td>
                    <td>{levelLabel(d.level)}</td>
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
            {event.workflow.history.map((h) => (
              <li key={h.id}>
                <strong>{ACTION_LABEL[h.action] ?? h.action}</strong>
                {h.level ? ` (${levelLabel(h.level)})` : ''} by {h.actorName ?? 'system'} ·{' '}
                {formatDateTime(h.createdAt)}
                {h.comment ? ` — ${h.comment}` : ''}
              </li>
            ))}
          </ol>
        </>
      )}
      <EventRegistration key={event.status} event={event} />
      {event.workflow && <EventBookings key={event.status} event={event} />}
    </article>
  );
}
