import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, downloadFile } from '../api/client';
import type { Summary } from '../api/analyticsTypes';
import type { Department } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Bars } from '../components/Bars';
import { formatDateTime } from '../lib/datetime';
import { formatMoney } from '../lib/money';

const percent = (n: number | null) => (n === null ? '—' : `${n}%`);

/** Summary for admins (every department) and HODs (their own): totals, every event, departments, halls, CSV exports. */
export function Analytics() {
  const { hasRole } = useAuth();
  const admin = hasRole('admin');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState('');

  const load = useCallback(async (query: string) => {
    setError(null);
    try {
      setSummary((await api<{ data: Summary }>(`/analytics/summary${query}`)).data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the analytics.');
    }
  }, []);
  useEffect(() => {
    void load(applied);
  }, [load, applied]);
  useEffect(() => {
    if (admin) {
      api<{ data: Department[] }>('/departments')
        .then((r) => setDepartments(r.data))
        .catch(() => setError('Could not load the departments.'));
    }
  }, [admin]);

  const query = () => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (departmentId) p.set('departmentId', departmentId);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  function submit(e: FormEvent) {
    e.preventDefault();
    setApplied(query());
  }
  async function exportCsv(file: 'events' | 'halls') {
    setError(null);
    try {
      await downloadFile(`/analytics/${file}.csv${applied}`, `${file}.csv`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not download the file.');
    }
  }

  return (
    <main>
      <h1>Analytics</h1>
      <form onSubmit={submit} className="row" aria-label="Period">
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {admin && (
          <label>
            Department
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit">Show</button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {summary && (
        <>
          <p className="muted">
            Events that started between {summary.period.from} and {summary.period.to} (
            {summary.period.days} {summary.period.days === 1 ? 'day' : 'days'}, India time).
          </p>
          {summary.truncated && (
            <p role="status" className="notice">
              Only the first events of this period are listed. Choose a shorter period to see the
              rest.
            </p>
          )}
          <ul aria-label="Totals">
            <li>{summary.totals.events} events</li>
            <li>{summary.totals.registered} registered</li>
            <li>
              {summary.totals.checkedIn} checked in · attendance rate{' '}
              {percent(summary.totals.ratePercent)}
            </li>
            <li>
              Feedback:{' '}
              {summary.totals.feedbackAverage === null
                ? 'no responses'
                : `${summary.totals.feedbackAverage} out of 5 from ${summary.totals.feedbackCount}`}
            </li>
            <li>{summary.totals.certificates} certificates issued</li>
            <li>
              Budget: planned {formatMoney(summary.totals.budget.estimateMinor)}, spent{' '}
              {formatMoney(summary.totals.budget.actualMinor)} ·{' '}
              {summary.totals.budget.overBudgetEvents} above plan
            </li>
          </ul>
          <p className="row">
            <button onClick={() => void exportCsv('events')}>Download events (CSV)</button>
            {summary.halls && (
              <button onClick={() => void exportCsv('halls')}>Download halls (CSV)</button>
            )}
          </p>

          <h2>Registrations per day</h2>
          <Bars
            caption="Registrations per day"
            rows={summary.registrationsPerDay.map((d) => ({ label: d.date, value: d.count }))}
          />

          <h2>Events</h2>
          <table aria-label="Events">
            <thead>
              <tr>
                <th>Event</th>
                <th>Department</th>
                <th>Starts</th>
                <th>Registered</th>
                <th>Checked in</th>
                <th>Rate</th>
                <th>Feedback</th>
                <th>Budget (planned / spent)</th>
              </tr>
            </thead>
            <tbody>
              {summary.events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/events/${e.id}`}>{e.title}</Link>
                  </td>
                  <td>{e.department.name}</td>
                  <td>{formatDateTime(e.startAt)}</td>
                  <td>{e.registered}</td>
                  <td>{e.checkedIn}</td>
                  <td>{percent(e.ratePercent)}</td>
                  <td>{e.feedbackAverage ?? '—'}</td>
                  <td>
                    {e.budget
                      ? `${formatMoney(e.budget.estimateMinor)} / ${formatMoney(e.budget.actualMinor)}${e.budget.overBudget ? ' (above plan)' : ''}`
                      : '—'}
                  </td>
                </tr>
              ))}
              {summary.events.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No events in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {summary.departments.length > 1 && (
            <>
              <h2>Departments</h2>
              <table aria-label="Departments">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th>Events</th>
                    <th>Registered</th>
                    <th>Rate</th>
                    <th>Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.departments.map((d) => (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td>{d.events}</td>
                      <td>{d.registered}</td>
                      <td>{percent(d.ratePercent)}</td>
                      <td>{formatMoney(d.budget.actualMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {summary.halls && (
            <>
              <h2>Hall utilization</h2>
              <p className="muted">Confirmed bookings as a share of 08:00 to 20:00 each day.</p>
              <table aria-label="Hall utilization">
                <thead>
                  <tr>
                    <th>Hall</th>
                    <th>Bookings</th>
                    <th>Booked hours</th>
                    <th>Available hours</th>
                    <th>Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.halls.map((h) => (
                    <tr key={h.id}>
                      <td>{h.name}</td>
                      <td>{h.bookings}</td>
                      <td>{h.bookedHours}</td>
                      <td>{h.availableHours}</td>
                      <td>{h.utilizationPercent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </main>
  );
}
