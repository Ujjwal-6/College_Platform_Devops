import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, fieldIssues } from '../api/client';
import type { BookingDetail, BookingWarning, EventDetail, Hall, HallConflict } from '../api/types';
import { formatDateTime, isoToLocalInput, localInputToIso } from '../lib/datetime';

const tags = (text: string) =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

/** Create (route /events/:eventId/book) or edit (route /bookings/:id/edit) a hall booking. */
export function BookingForm() {
  const { eventId, id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const [halls, setHalls] = useState<Hall[]>([]);
  const [event, setEvent] = useState<{
    id: string;
    title: string;
    startAt: string;
    endAt: string;
  } | null>(null);
  const [form, setForm] = useState({
    hallId: '',
    startAt: '',
    endAt: '',
    facilities: '',
    notes: '',
  });
  const [loading, setLoading] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<BookingWarning[] | null>(null);
  const [conflicts, setConflicts] = useState<HallConflict[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hallList = await api<{ data: Hall[] }>('/halls');
        if (cancelled) return;
        setHalls(hallList.data);
        if (editing) {
          const b = (await api<{ data: BookingDetail }>(`/bookings/${id}`)).data;
          setEvent(
            b.event && {
              id: b.event.id,
              title: b.event.title,
              startAt: b.event.startAt,
              endAt: b.event.endAt,
            },
          );
          setForm({
            hallId: b.hallId,
            startAt: isoToLocalInput(b.startAt),
            endAt: isoToLocalInput(b.endAt),
            facilities: b.requiredFacilities.join(', '),
            notes: b.notes,
          });
        } else {
          const e = (await api<{ data: EventDetail }>(`/events/${eventId}`)).data;
          setEvent({ id: e.id, title: e.title, startAt: e.startAt, endAt: e.endAt });
          setForm((f) => ({
            ...f,
            startAt: isoToLocalInput(e.startAt),
            endAt: isoToLocalInput(e.endAt),
          }));
        }
      } catch {
        if (!cancelled) setFormError('Could not load this page.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editing, id, eventId]);

  async function submit(acknowledgeWarnings: boolean) {
    setBusy(true);
    setFieldErrors({});
    setFormError(null);
    setConflicts(null);
    try {
      const body = {
        hallId: form.hallId,
        startAt: localInputToIso(form.startAt),
        endAt: localInputToIso(form.endAt),
        requiredFacilities: tags(form.facilities),
        notes: form.notes,
        acknowledgeWarnings,
      };
      const res = editing
        ? await api<{ data: BookingDetail }>(`/bookings/${id}`, { method: 'PATCH', body })
        : await api<{ data: BookingDetail }>('/bookings', {
            method: 'POST',
            body: { eventId, ...body },
          });
      navigate(`/bookings/${res.data.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WARNINGS_NEED_ACKNOWLEDGEMENT') {
        setWarnings((err.details as { warnings: BookingWarning[] }).warnings);
      } else if (err instanceof ApiError && err.code === 'HALL_UNAVAILABLE') {
        setWarnings(null);
        setConflicts((err.details as { conflicts: HallConflict[] }).conflicts);
        setFormError(err.message);
      } else {
        setWarnings(null);
        const issues = fieldIssues(err);
        if (issues.length) {
          setFieldErrors(Object.fromEntries(issues.map((i) => [i.path, i.message])));
          setFormError('Please fix the highlighted fields.');
        } else {
          setFormError(err instanceof ApiError ? err.message : 'Could not save the booking.');
        }
      }
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setWarnings(null);
    void submit(false);
  }

  if (loading) return <p role="status">Loading…</p>;
  const err = (field: string) =>
    fieldErrors[field] && (
      <span role="alert" className="error">
        {fieldErrors[field]}
      </span>
    );

  return (
    <section className="card">
      <h1>{editing ? 'Change hall booking' : 'Book a hall'}</h1>
      {event && (
        <p className="muted">
          For <Link to={`/events/${event.id}`}>{event.title}</Link>, {formatDateTime(event.startAt)}{' '}
          to {formatDateTime(event.endAt)}
        </p>
      )}
      {editing && (
        <p className="notice">
          Changing the hall or time sends the booking back to the first approval step.
        </p>
      )}
      <form onSubmit={onSubmit} aria-label="Booking form" noValidate>
        <label>
          Hall
          <select
            required
            value={form.hallId}
            onChange={(e) => setForm({ ...form, hallId: e.target.value })}
          >
            <option value="">Choose…</option>
            {halls.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} (seats {h.capacity})
              </option>
            ))}
          </select>
          {err('hallId')}
        </label>
        <div className="grid2">
          <label>
            From (India time)
            <input
              type="datetime-local"
              required
              value={form.startAt}
              onChange={(e) => setForm({ ...form, startAt: e.target.value })}
            />
            {err('startAt')}
          </label>
          <label>
            To (India time)
            <input
              type="datetime-local"
              required
              value={form.endAt}
              onChange={(e) => setForm({ ...form, endAt: e.target.value })}
            />
            {err('endAt')}
          </label>
        </div>
        <label>
          Facilities you need (optional, comma separated)
          <input
            value={form.facilities}
            onChange={(e) => setForm({ ...form, facilities: e.target.value })}
            placeholder="projector, stage"
          />
          {err('requiredFacilities')}
        </label>
        <label>
          Notes for the approvers
          <textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
          {err('notes')}
        </label>

        {warnings && (
          <div className="warnbox" role="alert" aria-label="Warnings">
            <strong>Please review before booking:</strong>
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
            <p className="muted">These are suggestions only. The approvers will see them.</p>
            <button type="button" disabled={busy} onClick={() => void submit(true)}>
              Book anyway
            </button>
          </div>
        )}
        {formError && (
          <p role="alert" className="error">
            {formError}
          </p>
        )}
        {conflicts && (
          <ul aria-label="Conflicting bookings">
            {conflicts.map((c) => (
              <li key={c.bookingId}>
                {c.eventTitle ?? 'Reserved'}: {formatDateTime(c.startAt)} to{' '}
                {formatDateTime(c.endAt)}
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Request booking'}
          </button>
          <button type="button" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
