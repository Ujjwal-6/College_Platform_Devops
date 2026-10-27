import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fieldIssues } from '../api/client';
import type { Hall, HallAvailability } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime, localInputToIso } from '../lib/datetime';

const tags = (text: string) =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

export function Halls() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  const [halls, setHalls] = useState<Hall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Hall | null>(null);

  const load = useCallback(async () => {
    try {
      setHalls(
        (await api<{ data: Hall[] }>(`/halls${isAdmin ? '?includeInactive=true' : ''}`)).data,
      );
    } catch {
      setError('Could not load halls.');
    }
  }, [isAdmin]);
  useEffect(() => void load(), [load]);

  return (
    <section className="card">
      <h1>Halls</h1>
      <Search />
      <h2>All halls</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Hall</th>
            <th>Location</th>
            <th>Capacity</th>
            <th>Facilities</th>
            {isAdmin && <th>Status</th>}
            {isAdmin && <th />}
          </tr>
        </thead>
        <tbody>
          {halls.map((h) => (
            <tr key={h.id}>
              <td>{h.name}</td>
              <td>{h.location}</td>
              <td>{h.capacity}</td>
              <td>{h.facilities.join(', ')}</td>
              {isAdmin && <td>{h.isActive ? 'Active' : 'Inactive'}</td>}
              {isAdmin && (
                <td>
                  <button onClick={() => setEditing(h)} aria-label={`Edit ${h.name}`}>
                    Edit
                  </button>
                </td>
              )}
            </tr>
          ))}
          {halls.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No halls yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {isAdmin && (
        <HallForm
          key={editing?.id ?? 'new'}
          hall={editing}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

/** Which halls are free for a time range. Informational: the booking itself is re-checked by the server. */
function Search() {
  const [form, setForm] = useState({
    startAt: '',
    endAt: '',
    attendance: '',
    facilities: '',
    onlyAvailable: false,
  });
  const [results, setResults] = useState<HallAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const q = new URLSearchParams({
      startAt: localInputToIso(form.startAt),
      endAt: localInputToIso(form.endAt),
    });
    if (form.attendance) q.set('attendance', form.attendance);
    if (form.facilities.trim()) q.set('facilities', tags(form.facilities).join(','));
    if (form.onlyAvailable) q.set('onlyAvailable', 'true');
    try {
      setResults((await api<{ data: HallAvailability[] }>(`/bookings/availability?${q}`)).data);
    } catch (err) {
      setResults(null);
      const issues = fieldIssues(err);
      setError(
        issues.length
          ? issues.map((i) => i.message).join('. ')
          : err instanceof ApiError
            ? err.message
            : 'Search failed.',
      );
    }
  }

  return (
    <>
      <form onSubmit={search} aria-label="Hall availability search">
        <h2>Find a hall</h2>
        <div className="grid2">
          <label>
            From (India time)
            <input
              type="datetime-local"
              required
              value={form.startAt}
              onChange={(e) => setForm({ ...form, startAt: e.target.value })}
            />
          </label>
          <label>
            To (India time)
            <input
              type="datetime-local"
              required
              value={form.endAt}
              onChange={(e) => setForm({ ...form, endAt: e.target.value })}
            />
          </label>
        </div>
        <div className="grid2">
          <label>
            People expected (optional)
            <input
              type="number"
              min={1}
              value={form.attendance}
              onChange={(e) => setForm({ ...form, attendance: e.target.value })}
            />
          </label>
          <label>
            Facilities needed (optional, comma separated)
            <input
              value={form.facilities}
              onChange={(e) => setForm({ ...form, facilities: e.target.value })}
              placeholder="projector, stage"
            />
          </label>
        </div>
        <label className="inline">
          <input
            type="checkbox"
            checked={form.onlyAvailable}
            onChange={(e) => setForm({ ...form, onlyAvailable: e.target.checked })}
          />{' '}
          Show only free halls
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit">Search</button>
      </form>
      {results && (
        <table aria-label="Availability results">
          <thead>
            <tr>
              <th>Hall</th>
              <th>Capacity</th>
              <th>Facilities</th>
              <th>That time</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.hall.id}>
                <td>
                  {r.hall.name}
                  <br />
                  <span className="muted">{r.hall.location}</span>
                </td>
                <td>
                  {r.hall.capacity}
                  {!r.capacityOk && <span className="flag"> (smaller than expected)</span>}
                </td>
                <td>
                  {r.hall.facilities.join(', ')}
                  {r.missingFacilities.length > 0 && (
                    <span className="flag"> (missing: {r.missingFacilities.join(', ')})</span>
                  )}
                </td>
                <td>
                  {r.available ? (
                    <span className="free">Free</span>
                  ) : (
                    <>
                      <span className="taken">Booked</span>
                      <ul>
                        {r.conflicts.map((c) => (
                          <li key={c.bookingId}>
                            {c.eventTitle ?? 'Reserved'}: {formatDateTime(c.startAt)} to{' '}
                            {formatDateTime(c.endAt)}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No halls match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </>
  );
}

function HallForm({ hall, onDone }: { hall: Hall | null; onDone: () => void }) {
  const [form, setForm] = useState({
    name: hall?.name ?? '',
    location: hall?.location ?? '',
    capacity: hall ? String(hall.capacity) : '',
    facilities: hall?.facilities.join(', ') ?? '',
    description: hall?.description ?? '',
    isActive: hall?.isActive ?? true,
  });
  const [errors, setErrors] = useState<string[]>([]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors([]);
    const body = {
      name: form.name,
      location: form.location,
      capacity: Number(form.capacity),
      facilities: tags(form.facilities),
      description: form.description,
      isActive: form.isActive,
    };
    try {
      if (hall) await api(`/halls/${hall.id}`, { method: 'PATCH', body });
      else await api('/halls', { method: 'POST', body });
      onDone();
    } catch (err) {
      const issues = fieldIssues(err);
      setErrors(
        issues.length
          ? issues.map((i) => i.message)
          : [err instanceof ApiError ? err.message : 'Could not save the hall.'],
      );
    }
  }

  return (
    <form onSubmit={submit} aria-label={hall ? 'Edit hall' : 'Add hall'}>
      <h2>{hall ? `Edit ${hall.name}` : 'Add a hall'}</h2>
      <div className="grid2">
        <label>
          Name
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Location
          <input
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
          />
        </label>
      </div>
      <div className="grid2">
        <label>
          Capacity
          <input
            type="number"
            min={1}
            required
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
          />
        </label>
        <label>
          Facilities (comma separated)
          <input
            value={form.facilities}
            onChange={(e) => setForm({ ...form, facilities: e.target.value })}
            placeholder="projector, ac, stage"
          />
        </label>
      </div>
      <label>
        Description
        <textarea
          rows={2}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </label>
      <label className="inline">
        <input
          type="checkbox"
          checked={form.isActive}
          onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
        />{' '}
        Active (can be booked)
      </label>
      {errors.map((m) => (
        <p key={m} role="alert" className="error">
          {m}
        </p>
      ))}
      <div className="row">
        <button type="submit">{hall ? 'Save hall' : 'Add hall'}</button>
        {hall && (
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
