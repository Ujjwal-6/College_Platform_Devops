import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fieldIssues } from '../api/client';
import type { FeedbackResults, MyFeedbackState } from '../api/aftermathTypes';
import type { EventDetail } from '../api/types';
import { formatDateTime } from '../lib/datetime';

const stars = (n: number) => `${n} ${n === 1 ? 'star' : 'stars'}`;

/**
 * Feedback for a finished event. Someone who was checked in sees the form (once); the organizer,
 * department staff and admins see the ratings and comments, without names.
 */
export function EventFeedback({ event }: { event: EventDetail }) {
  const over =
    Date.parse(event.endAt) <= Date.now() &&
    (event.status === 'published' || event.status === 'closed');
  const staff = event.workflow !== null;
  const [mine, setMine] = useState<MyFeedbackState | null>(null);
  const [results, setResults] = useState<FeedbackResults | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [thanks, setThanks] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMine((await api<{ data: MyFeedbackState }>(`/events/${event.id}/feedback/mine`)).data);
      if (staff) {
        setResults((await api<{ data: FeedbackResults }>(`/events/${event.id}/feedback`)).data);
      }
    } catch {
      setError('Could not load feedback.');
    }
  }, [event.id, staff]);
  useEffect(() => {
    if (over) void load();
  }, [over, load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!rating) {
      setError('Please choose a rating from 1 to 5 stars.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/events/${event.id}/feedback`, {
        method: 'POST',
        body: comment.trim() ? { rating, comment } : { rating },
      });
      setThanks(true);
    } catch (err) {
      const issues = fieldIssues(err);
      setError(
        issues.length
          ? issues.map((i) => i.message).join(' ')
          : err instanceof ApiError
            ? err.message
            : 'Could not send your feedback.',
      );
    } finally {
      setBusy(false);
    }
    await load();
  }

  if (!over || !mine)
    return error ? (
      <p role="alert" className="error">
        {error}
      </p>
    ) : null;
  const giving = mine.eligible;
  if (!giving && !staff) return null;

  return (
    <>
      <h2>Feedback</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {giving &&
        (mine.submitted || thanks ? (
          <p>Thank you, your feedback was received.</p>
        ) : mine.open ? (
          <form onSubmit={(e) => void submit(e)}>
            <p className="muted">
              Your answer is anonymous to the organizers. You can answer once, until{' '}
              {formatDateTime(mine.closesAt)}.
            </p>
            <fieldset>
              <legend>Your rating</legend>
              {[1, 2, 3, 4, 5].map((n) => (
                <label key={n}>
                  <input
                    type="radio"
                    name="rating"
                    value={n}
                    checked={rating === n}
                    onChange={() => setRating(n)}
                  />
                  {stars(n)}
                </label>
              ))}
            </fieldset>
            <label>
              Comment (optional)
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={1000}
                rows={3}
              />
            </label>
            <button type="submit" disabled={busy}>
              Send feedback
            </button>
          </form>
        ) : (
          <p className="muted">Feedback for this event is closed.</p>
        ))}

      {staff && results && (
        <>
          <h3>What attendees said</h3>
          {results.summary.count === 0 ? (
            <p className="muted">No feedback yet.</p>
          ) : (
            <>
              <p>
                <strong>Average {results.summary.average?.toFixed(1)} out of 5</strong> from{' '}
                {results.summary.count} {results.summary.count === 1 ? 'response' : 'responses'}
              </p>
              <ul>
                {[5, 4, 3, 2, 1].map((n) => (
                  <li key={n}>
                    {stars(n)}: {results.summary.distribution[n - 1]}
                  </li>
                ))}
              </ul>
              {results.comments.length > 0 && (
                <ul aria-label="Comments">
                  {results.comments.map((c, i) => (
                    <li key={i}>
                      <span className="muted">{stars(c.rating)}</span> {c.comment}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
