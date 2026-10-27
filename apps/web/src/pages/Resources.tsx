import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fieldIssues } from '../api/client';
import type { Resource, ResourceAvailability } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { localInputToIso } from '../lib/datetime';

export function Resources() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  const [resources, setResources] = useState<Resource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Resource | null>(null);

  const load = useCallback(async () => {
    try {
      setResources((await api<{ data: Resource[] }>('/resources')).data);
    } catch {
      setError('Could not load resources.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <section className="card">
      <h1>Equipment and resources</h1>
      <Availability />
      <h2>All resources</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Category</th>
            <th>Total units</th>
            <th>Status</th>
            {isAdmin && <th />}
          </tr>
        </thead>
        <tbody>
          {resources.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.category}</td>
              <td>{r.quantity}</td>
              <td>{r.status}</td>
              {isAdmin && (
                <td>
                  <button onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                    Edit
                  </button>
                </td>
              )}
            </tr>
          ))}
          {resources.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No resources yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {isAdmin && (
        <ResourceForm
          key={editing?.id ?? 'new'}
          resource={editing}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function Availability() {
  const [form, setForm] = useState({ startAt: '', endAt: '' });
  const [rows, setRows] = useState<ResourceAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const q = new URLSearchParams({
      startAt: localInputToIso(form.startAt),
      endAt: localInputToIso(form.endAt),
    });
    try {
      setRows((await api<{ data: ResourceAvailability[] }>(`/resources/availability?${q}`)).data);
    } catch (err) {
      setRows(null);
      const issues = fieldIssues(err);
      setError(
        issues.length
          ? issues.map((i) => i.message).join('. ')
          : err instanceof ApiError
            ? err.message
            : 'Check failed.',
      );
    }
  }

  return (
    <>
      <form onSubmit={check} aria-label="Resource availability">
        <h2>What is free?</h2>
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
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit">Check availability</button>
      </form>
      {rows && (
        <table aria-label="Availability results">
          <thead>
            <tr>
              <th>Resource</th>
              <th>Total</th>
              <th>In use at the busiest moment</th>
              <th>Free</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.resource.id}>
                <td>{r.resource.name}</td>
                <td>{r.resource.quantity}</td>
                <td>{r.inUse}</td>
                <td>
                  {r.resource.status === 'available' ? (
                    <span className={r.available > 0 ? 'free' : 'taken'}>{r.available}</span>
                  ) : (
                    <span className="muted">{r.resource.status}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ResourceForm({ resource, onDone }: { resource: Resource | null; onDone: () => void }) {
  const [form, setForm] = useState({
    name: resource?.name ?? '',
    category: resource?.category ?? '',
    quantity: resource ? String(resource.quantity) : '',
    description: resource?.description ?? '',
    status: resource?.status ?? 'available',
  });
  const [errors, setErrors] = useState<string[]>([]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors([]);
    const body = {
      name: form.name,
      category: form.category,
      quantity: Number(form.quantity),
      description: form.description,
      status: form.status,
    };
    try {
      if (resource) await api(`/resources/${resource.id}`, { method: 'PATCH', body });
      else await api('/resources', { method: 'POST', body });
      onDone();
    } catch (err) {
      const issues = fieldIssues(err);
      setErrors(
        issues.length
          ? issues.map((i) => i.message)
          : [err instanceof ApiError ? err.message : 'Could not save the resource.'],
      );
    }
  }

  return (
    <form onSubmit={submit} aria-label={resource ? 'Edit resource' : 'Add resource'}>
      <h2>{resource ? `Edit ${resource.name}` : 'Add a resource'}</h2>
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
          Category
          <input
            required
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            placeholder="av, furniture, ..."
          />
        </label>
      </div>
      <div className="grid2">
        <label>
          Total units
          <input
            type="number"
            min={1}
            required
            value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
          />
        </label>
        <label>
          Status
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as Resource['status'] })}
          >
            <option value="available">Available</option>
            <option value="maintenance">Under maintenance</option>
            <option value="retired">Retired</option>
          </select>
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
      {errors.map((m) => (
        <p key={m} role="alert" className="error">
          {m}
        </p>
      ))}
      <div className="row">
        <button type="submit">{resource ? 'Save resource' : 'Add resource'}</button>
        {resource && (
          <button type="button" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
