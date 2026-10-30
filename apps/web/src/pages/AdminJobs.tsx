import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { formatDateTime } from '../lib/datetime';
import { Pill } from '../components/Pill';

const STATUSES = ['failed', 'queued', 'running', 'succeeded'] as const;
type Status = (typeof STATUSES)[number];

interface JobSummary {
  id: string;
  type: string;
  status: Status;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  updatedAt: string;
}
interface JobsPage {
  data: JobSummary[];
  counts: Record<Status, number>;
  page: { total: number };
}

export function AdminJobs() {
  const [status, setStatus] = useState<Status>('failed');
  const [result, setResult] = useState<JobsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setResult(await api<JobsPage>(`/admin/jobs?status=${status}&limit=100`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load background jobs.');
    }
  }, [status]);
  useEffect(() => void load(), [load]);

  async function retry(job: JobSummary) {
    try {
      await api(`/admin/jobs/${job.id}/retry`, { method: 'POST' });
      await load();
    } catch (err) {
      // Reload first (it clears the error), then show why the retry was refused.
      await load();
      setError(err instanceof ApiError ? err.message : 'Could not retry the job.');
    }
  }

  return (
    <section className="card">
      <h1>Background jobs</h1>
      <p className="row">
        {STATUSES.map((s) => (
          <button
            key={s}
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            aria-label={`Show ${s} jobs`}
          >
            {s} ({result?.counts[s] ?? 0})
          </button>
        ))}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Last error</th>
            <th>Updated (India)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {result?.data.map((j) => (
            <tr key={j.id}>
              <td>{j.type}</td>
              <td>
                <Pill
                  tone={
                    j.status === 'failed'
                      ? 'bad'
                      : j.status === 'succeeded'
                        ? 'ok'
                        : j.status === 'running'
                          ? 'warn'
                          : 'info'
                  }
                >
                  {j.status}
                </Pill>
              </td>
              <td>
                {j.attempts} / {j.maxAttempts}
              </td>
              <td className="muted">{j.lastError ?? ''}</td>
              <td>{formatDateTime(j.updatedAt)}</td>
              <td>
                {j.status === 'failed' && (
                  <button onClick={() => void retry(j)} aria-label={`Retry ${j.type} job`}>
                    Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
          {result && result.data.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No {status} jobs.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
