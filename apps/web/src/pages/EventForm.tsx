import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, fieldIssues } from '../api/client';
import type { Department, EventDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { isoToLocalInput, localInputToIso } from '../lib/datetime';

interface FormState {
  title: string;
  description: string;
  category: string;
  departmentId: string;
  startAt: string;
  endAt: string;
  expectedAttendance: string;
  capacity: string;
  registrationMode: 'individual' | 'team';
  teamSizeMin: string;
  teamSizeMax: string;
  registrationDeadline: string;
  speakers: { name: string; designation: string; organization: string }[];
}

const EMPTY: FormState = {
  title: '',
  description: '',
  category: '',
  departmentId: '',
  startAt: '',
  endAt: '',
  expectedAttendance: '',
  capacity: '',
  registrationMode: 'individual',
  teamSizeMin: '',
  teamSizeMax: '',
  registrationDeadline: '',
  speakers: [],
};
const CATEGORIES = ['technical', 'cultural', 'sports', 'workshop', 'seminar', 'academic'];
const num = (v: string) => (v.trim() === '' ? null : Number(v));

function toPayload(f: FormState, isAdmin: boolean) {
  return {
    title: f.title,
    description: f.description,
    category: f.category,
    ...(isAdmin && f.departmentId ? { departmentId: f.departmentId } : {}),
    startAt: f.startAt ? localInputToIso(f.startAt) : '',
    endAt: f.endAt ? localInputToIso(f.endAt) : '',
    expectedAttendance: Number(f.expectedAttendance),
    capacity: num(f.capacity),
    registrationMode: f.registrationMode,
    teamSizeMin: f.registrationMode === 'team' ? num(f.teamSizeMin) : null,
    teamSizeMax: f.registrationMode === 'team' ? num(f.teamSizeMax) : null,
    registrationDeadline: f.registrationDeadline ? localInputToIso(f.registrationDeadline) : null,
    speakers: f.speakers
      .filter((s) => s.name.trim())
      .map((s) => ({
        name: s.name,
        designation: s.designation || null,
        organization: s.organization || null,
      })),
  };
}

export function EventForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  const [form, setForm] = useState<FormState>(EMPTY);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [status, setStatus] = useState<EventDetail['status']>('draft');
  const [materialFields, setMaterialFields] = useState<string[]>([]);
  const [loading, setLoading] = useState(editing);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isAdmin)
      void api<{ data: Department[] }>('/departments').then((r) => setDepartments(r.data));
  }, [isAdmin]);

  useEffect(() => {
    if (!id) return;
    api<{ data: EventDetail }>(`/events/${id}`)
      .then(({ data: e }) => {
        setStatus(e.status);
        setMaterialFields(e.materialFields);
        setForm({
          title: e.title,
          description: e.description,
          category: e.category,
          departmentId: e.departmentId,
          startAt: isoToLocalInput(e.startAt),
          endAt: isoToLocalInput(e.endAt),
          expectedAttendance: String(e.expectedAttendance),
          capacity: e.capacity === null ? '' : String(e.capacity),
          registrationMode: e.registrationMode,
          teamSizeMin: e.teamSizeMin === null ? '' : String(e.teamSizeMin),
          teamSizeMax: e.teamSizeMax === null ? '' : String(e.teamSizeMax),
          registrationDeadline: e.registrationDeadline
            ? isoToLocalInput(e.registrationDeadline)
            : '',
          speakers: e.speakers.map((s) => ({
            name: s.name,
            designation: s.designation ?? '',
            organization: s.organization ?? '',
          })),
        });
      })
      .catch(() => setFormError('Could not load this event.'))
      .finally(() => setLoading(false));
  }, [id]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  // After approval only small corrections are allowed; the rest needs "Revise" on the event page.
  const locked = (field: string) => editing && status !== 'draft' && materialFields.includes(field);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const payload = toPayload(form, isAdmin);
      const saved = editing
        ? await api<{ data: EventDetail }>(`/events/${id}`, { method: 'PATCH', body: payload })
        : await api<{ data: EventDetail }>('/events', { method: 'POST', body: payload });
      navigate(`/events/${saved.data.id}`);
    } catch (err) {
      const issues = fieldIssues(err);
      if (issues.length) {
        setFieldErrors(
          Object.fromEntries(issues.map((d) => [d.path.split('.')[0] ?? d.path, d.message])),
        );
        setFormError('Please fix the highlighted fields.');
      } else if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError('Could not save the event.');
      }
    } finally {
      setBusy(false);
    }
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
      <h1>{editing ? 'Edit event' : 'New event'}</h1>
      {editing && status !== 'draft' && (
        <p className="notice">
          This event is {status}. Only small corrections are possible here; to change dates,
          capacity or similar details, use “Revise” on the event page (it needs approval again).
        </p>
      )}
      <form onSubmit={onSubmit} noValidate aria-label="Event form">
        <label>
          Title
          <input value={form.title} onChange={(e) => set('title', e.target.value)} required />
          {err('title')}
        </label>
        <label>
          Category
          <input
            list="categories"
            value={form.category}
            onChange={(e) => set('category', e.target.value)}
            disabled={locked('category')}
            required
          />
          <datalist id="categories">
            {CATEGORIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          {err('category')}
        </label>
        {isAdmin && (
          <label>
            Department
            <select
              value={form.departmentId}
              onChange={(e) => set('departmentId', e.target.value)}
              disabled={locked('departmentId')}
              required
            >
              <option value="">Choose…</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            {err('departmentId')}
          </label>
        )}
        <label>
          Description
          <textarea
            rows={4}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
          {err('description')}
        </label>
        <div className="grid2">
          <label>
            Starts (India time)
            <input
              type="datetime-local"
              value={form.startAt}
              onChange={(e) => set('startAt', e.target.value)}
              disabled={locked('startAt')}
              required
            />
            {err('startAt')}
          </label>
          <label>
            Ends (India time)
            <input
              type="datetime-local"
              value={form.endAt}
              onChange={(e) => set('endAt', e.target.value)}
              disabled={locked('endAt')}
              required
            />
            {err('endAt')}
          </label>
        </div>
        <div className="grid2">
          <label>
            Expected attendance
            <input
              type="number"
              min={1}
              value={form.expectedAttendance}
              onChange={(e) => set('expectedAttendance', e.target.value)}
              disabled={locked('expectedAttendance')}
              required
            />
            {err('expectedAttendance')}
          </label>
          <label>
            Registration capacity (optional)
            <input
              type="number"
              min={1}
              value={form.capacity}
              onChange={(e) => set('capacity', e.target.value)}
              disabled={locked('capacity')}
            />
            {err('capacity')}
          </label>
        </div>
        <div className="grid2">
          <label>
            Registration
            <select
              value={form.registrationMode}
              onChange={(e) =>
                set('registrationMode', e.target.value as FormState['registrationMode'])
              }
              disabled={locked('registrationMode')}
            >
              <option value="individual">Individuals</option>
              <option value="team">Teams</option>
            </select>
            {err('registrationMode')}
          </label>
          <label>
            Registration closes (optional)
            <input
              type="datetime-local"
              value={form.registrationDeadline}
              onChange={(e) => set('registrationDeadline', e.target.value)}
            />
            {err('registrationDeadline')}
          </label>
        </div>
        {form.registrationMode === 'team' && (
          <div className="grid2">
            <label>
              Minimum team size
              <input
                type="number"
                min={2}
                value={form.teamSizeMin}
                onChange={(e) => set('teamSizeMin', e.target.value)}
                disabled={locked('teamSizeMin')}
              />
              {err('teamSizeMin')}
            </label>
            <label>
              Maximum team size
              <input
                type="number"
                min={2}
                value={form.teamSizeMax}
                onChange={(e) => set('teamSizeMax', e.target.value)}
                disabled={locked('teamSizeMax')}
              />
              {err('teamSizeMax')}
            </label>
          </div>
        )}
        <fieldset>
          <legend>Speakers</legend>
          {form.speakers.map((s, i) => (
            <div className="grid3" key={i}>
              <input
                aria-label={`Speaker ${i + 1} name`}
                placeholder="Name"
                value={s.name}
                onChange={(e) =>
                  set(
                    'speakers',
                    form.speakers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                  )
                }
              />
              <input
                aria-label={`Speaker ${i + 1} designation`}
                placeholder="Designation"
                value={s.designation}
                onChange={(e) =>
                  set(
                    'speakers',
                    form.speakers.map((x, j) =>
                      j === i ? { ...x, designation: e.target.value } : x,
                    ),
                  )
                }
              />
              <input
                aria-label={`Speaker ${i + 1} organization`}
                placeholder="Organization"
                value={s.organization}
                onChange={(e) =>
                  set(
                    'speakers',
                    form.speakers.map((x, j) =>
                      j === i ? { ...x, organization: e.target.value } : x,
                    ),
                  )
                }
              />
              <button
                className="danger"
                type="button"
                onClick={() =>
                  set(
                    'speakers',
                    form.speakers.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
          {err('speakers')}
          <button
            type="button"
            onClick={() =>
              set('speakers', [...form.speakers, { name: '', designation: '', organization: '' }])
            }
          >
            Add speaker
          </button>
        </fieldset>
        {formError && (
          <p role="alert" className="error">
            {formError}
          </p>
        )}
        <div className="row">
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create draft'}
          </button>
          <button type="button" onClick={() => navigate(editing ? `/events/${id}` : '/events')}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
