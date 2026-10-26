import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fieldIssues } from '../api/client';
import { ROLES, type Department, type ManagedUser, type Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';

interface ListResponse {
  data: ManagedUser[];
  page: { total: number };
}

export function AdminUsers() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole('admin');
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, depts] = await Promise.all([
        api<ListResponse>('/users?limit=100'),
        api<{ data: Department[] }>('/departments'),
      ]);
      setUsers(list.data);
      setDepartments(depts.data);
    } catch {
      setError('Could not load users.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function toggle(u: ManagedUser) {
    setError(null);
    try {
      await api(`/users/${u.id}/${u.isActive ? 'deactivate' : 'activate'}`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed.');
    }
  }

  return (
    <section className="card">
      <h1>Users</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Roles</th>
            <th>Status</th>
            {isAdmin && <th />}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{u.roles.join(', ')}</td>
              <td>{u.isActive ? 'Active' : 'Deactivated'}</td>
              {isAdmin && (
                <td>
                  <button onClick={() => void toggle(u)}>
                    {u.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && <CreateUser departments={departments} onCreated={load} />}
    </section>
  );
}

function CreateUser({
  departments,
  onCreated,
}: {
  departments: Department[];
  onCreated: () => Promise<void>;
}) {
  const [form, setForm] = useState({ name: '', email: '', password: '', departmentId: '' });
  const [roles, setRoles] = useState<Role[]>(['student']);
  const [errors, setErrors] = useState<string[]>([]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors([]);
    try {
      await api('/users', {
        method: 'POST',
        body: { ...form, departmentId: form.departmentId || null, roles },
      });
      setForm({ name: '', email: '', password: '', departmentId: '' });
      await onCreated();
    } catch (err) {
      const issues = fieldIssues(err);
      setErrors(
        issues.length
          ? issues.map((d) => d.message)
          : [err instanceof ApiError ? err.message : 'Could not create user.'],
      );
    }
  }

  const toggleRole = (r: Role) =>
    setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));

  return (
    <form onSubmit={submit} aria-label="Create user">
      <h2>Create user</h2>
      <label>
        Name
        <input
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>
      <label>
        Email
        <input
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </label>
      <label>
        Initial password (12+ characters)
        <input
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      </label>
      <label>
        Department
        <select
          value={form.departmentId}
          onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
        >
          <option value="">None</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Roles</legend>
        {ROLES.map((r) => (
          <label key={r} className="inline">
            <input type="checkbox" checked={roles.includes(r)} onChange={() => toggleRole(r)} /> {r}
          </label>
        ))}
      </fieldset>
      {errors.map((m) => (
        <p key={m} role="alert" className="error">
          {m}
        </p>
      ))}
      <button type="submit" disabled={roles.length === 0}>
        Create user
      </button>
    </form>
  );
}
