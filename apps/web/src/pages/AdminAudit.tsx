import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { formatDateTime, localInputToIso } from '../lib/datetime';

interface AuditRecord {
  id: string;
  createdAt: string;
  action: string;
  actor: { id: string; name: string; email: string } | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}
interface AuditPage {
  data: AuditRecord[];
  page: { total: number; limit: number; offset: number };
}

const PAGE_SIZE = 25;
const empty = { action: '', targetType: '', targetId: '', from: '', to: '' };

export function AdminAudit() {
  const [form, setForm] = useState(empty);
  const [applied, setApplied] = useState(empty);
  const [offset, setOffset] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [result, setResult] = useState<AuditPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: string[] }>('/admin/audit-log/actions')
      .then((r) => setActions(r.data))
      .catch(() => setActions([]));
  }, []);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (applied.action) q.set('action', applied.action);
    if (applied.targetType.trim()) q.set('targetType', applied.targetType.trim());
    if (applied.targetId.trim()) q.set('targetId', applied.targetId.trim());
    if (applied.from) q.set('from', localInputToIso(applied.from));
    if (applied.to) q.set('to', localInputToIso(applied.to));
    try {
      setResult(await api<AuditPage>(`/admin/audit-log?${q}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the audit log.');
    }
  }, [applied, offset]);
  useEffect(() => void load(), [load]);

  function search(e: FormEvent) {
    e.preventDefault();
    setOffset(0);
    setApplied(form);
  }

  const total = result?.page.total ?? 0;
  return (
    <section className="card">
      <h1>Audit log</h1>
      <form onSubmit={search} className="row">
        <label>
          Action
          <select
            value={form.action}
            onChange={(e) => setForm({ ...form, action: e.target.value })}
          >
            <option value="">Any action</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target type
          <input
            value={form.targetType}
            maxLength={50}
            onChange={(e) => setForm({ ...form, targetType: e.target.value })}
          />
        </label>
        <label>
          Target id
          <input
            value={form.targetId}
            maxLength={100}
            onChange={(e) => setForm({ ...form, targetId: e.target.value })}
          />
        </label>
        <label>
          From
          <input
            type="datetime-local"
            value={form.from}
            onChange={(e) => setForm({ ...form, from: e.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={form.to}
            onChange={(e) => setForm({ ...form, to: e.target.value })}
          />
        </label>
        <button type="submit">Search</button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Time (India)</th>
            <th>Action</th>
            <th>Who</th>
            <th>Target</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {result?.data.map((r) => (
            <tr key={r.id}>
              <td>{formatDateTime(r.createdAt)}</td>
              <td>{r.action}</td>
              <td>{r.actor ? `${r.actor.name} (${r.actor.email})` : 'System / not signed in'}</td>
              <td>{r.targetType ? `${r.targetType} ${r.targetId ?? ''}` : ''}</td>
              <td className="muted">
                {Object.keys(r.metadata).length ? JSON.stringify(r.metadata) : ''}
              </td>
            </tr>
          ))}
          {result && result.data.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No matching records.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="row">
        <span className="muted">
          {total === 0
            ? '0 records'
            : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
        </span>
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          Previous
        </button>
        <button
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          Next
        </button>
      </p>
    </section>
  );
}
