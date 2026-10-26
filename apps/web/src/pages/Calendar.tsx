import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fieldIssues } from '../api/client';
import type { CalendarEntry, Department } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDate } from '../lib/datetime';

const TYPES: { value: CalendarEntry['type']; label: string }[] = [
  { value: 'exam_period', label: 'Exam period' },
  { value: 'holiday', label: 'Holiday' },
  { value: 'major_fest', label: 'Major fest' },
  { value: 'academic_date', label: 'Academic date' },
  { value: 'other', label: 'Other' },
];
const typeLabel = (t: CalendarEntry['type']) => TYPES.find((x) => x.value === t)?.label ?? t;

export function Calendar() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<{ id: string; title: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const [list, depts] = await Promise.all([
        api<{ data: CalendarEntry[] }>(
          `/calendar/entries${isAdmin ? '?includeInactive=true' : ''}`,
        ),
        api<{ data: Department[] }>('/departments'),
      ]);
      setEntries(list.data);
      setDepartments(depts.data);
    } catch {
      setError('Could not load the calendar.');
    }
  }, [isAdmin]);
  useEffect(() => void load(), [load]);

  const deptName = (id: string | null) =>
    id ? (departments.find((d) => d.id === id)?.name ?? 'Department') : 'All departments';

  async function toggle(e: CalendarEntry) {
    try {
      const res = await api<{ conflicts: { id: string; title: string }[] }>(
        `/calendar/entries/${e.id}`,
        { method: 'PATCH', body: { isActive: !e.isActive } },
      );
      setConflicts(res.conflicts);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed.');
    }
  }
  async function remove(e: CalendarEntry) {
    try {
      await api(`/calendar/entries/${e.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
    }
  }

  return (
    <section className="card">
      <h1>Academic calendar</h1>
      <p className="muted">
        Events cannot be submitted on <strong>blocked</strong> dates. <strong>Warning</strong> dates
        are allowed, but approvers are told.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {conflicts.length > 0 && (
        <div className="notice" role="status">
          Existing events overlap this entry (they were not changed):{' '}
          {conflicts.map((c) => c.title).join(', ')}.
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Title</th>
            <th>Dates</th>
            <th>Effect</th>
            <th>Applies to</th>
            {isAdmin && <th>Active</th>}
            {isAdmin && <th />}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{typeLabel(e.type)}</td>
              <td>{e.title}</td>
              <td>
                {e.startDate === e.endDate
                  ? formatDate(e.startDate)
                  : `${formatDate(e.startDate)} – ${formatDate(e.endDate)}`}
              </td>
              <td>{e.severity === 'block' ? 'Blocked' : 'Warning'}</td>
              <td>{deptName(e.departmentId)}</td>
              {isAdmin && (
                <td>
                  <button
                    onClick={() => void toggle(e)}
                    aria-label={`${e.isActive ? 'Deactivate' : 'Activate'} ${e.title}`}
                  >
                    {e.isActive ? 'Active' : 'Inactive'}
                  </button>
                </td>
              )}
              {isAdmin && (
                <td>
                  <button onClick={() => void remove(e)} aria-label={`Delete ${e.title}`}>
                    Delete
                  </button>
                </td>
              )}
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No calendar entries.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {isAdmin && (
        <NewEntry
          departments={departments}
          onSaved={(c) => {
            setConflicts(c);
            void load();
          }}
        />
      )}
    </section>
  );
}

function NewEntry({
  departments,
  onSaved,
}: {
  departments: Department[];
  onSaved: (conflicts: { id: string; title: string }[]) => void;
}) {
  const [form, setForm] = useState({
    type: 'exam_period',
    title: '',
    startDate: '',
    endDate: '',
    severity: '',
    departmentId: '',
  });
  const [errors, setErrors] = useState<string[]>([]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors([]);
    try {
      const res = await api<{ conflicts: { id: string; title: string }[] }>('/calendar/entries', {
        method: 'POST',
        body: {
          type: form.type,
          title: form.title,
          startDate: form.startDate,
          endDate: form.endDate || form.startDate,
          ...(form.severity ? { severity: form.severity } : {}),
          departmentId: form.departmentId || null,
        },
      });
      setForm({ ...form, title: '', startDate: '', endDate: '' });
      onSaved(res.conflicts);
    } catch (err) {
      const issues = fieldIssues(err);
      setErrors(
        issues.length
          ? issues.map((i) => i.message)
          : [err instanceof ApiError ? err.message : 'Could not save the entry.'],
      );
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add calendar entry">
      <h2>Add entry</h2>
      <label>
        Type
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input
          required
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </label>
      <div className="grid2">
        <label>
          From
          <input
            type="date"
            required
            value={form.startDate}
            onChange={(e) => setForm({ ...form, startDate: e.target.value })}
          />
        </label>
        <label>
          To (optional)
          <input
            type="date"
            value={form.endDate}
            onChange={(e) => setForm({ ...form, endDate: e.target.value })}
          />
        </label>
      </div>
      <div className="grid2">
        <label>
          Effect
          <select
            value={form.severity}
            onChange={(e) => setForm({ ...form, severity: e.target.value })}
          >
            <option value="">Default for the type</option>
            <option value="block">Block submissions</option>
            <option value="warn">Warn only</option>
          </select>
        </label>
        <label>
          Applies to
          <select
            value={form.departmentId}
            onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {errors.map((m) => (
        <p key={m} role="alert" className="error">
          {m}
        </p>
      ))}
      <button type="submit">Add entry</button>
    </form>
  );
}
