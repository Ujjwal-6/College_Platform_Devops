import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import { adminUser, json, mockFetch, renderApp, studentUser } from './utils';

beforeEach(() => {
  setAccessToken(null);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const asAdmin = {
  'POST /api/auth/refresh': () => json(200, { accessToken: 't', user: adminUser }),
};
const asStudent = {
  'POST /api/auth/refresh': () => json(200, { accessToken: 't', user: studentUser }),
};

const record = (over: Record<string, unknown> = {}) => ({
  id: '1',
  createdAt: '2031-03-01T04:30:00.000Z',
  action: 'hall.created',
  actor: { id: 'u1', name: 'Ada Admin', email: 'admin@college.test' },
  targetType: 'hall',
  targetId: 'h1',
  metadata: {},
  ...over,
});
const auditPage = (data: unknown[], total = data.length, offset = 0) =>
  json(200, { data, page: { total, limit: 25, offset } });

describe('admin navigation', () => {
  it('shows the audit log and jobs links to admins only', async () => {
    mockFetch({
      ...asAdmin,
      'GET /api/admin/audit-log/actions': () => json(200, { data: [] }),
      'GET /api/admin/audit-log?limit=25&offset=0': () => auditPage([]),
    });
    renderApp('/admin/audit');
    expect(await screen.findByRole('link', { name: 'Audit log' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Jobs' })).toBeInTheDocument();
  });

  it('hides the links and keeps other roles out of the pages', async () => {
    const { calls } = mockFetch(asStudent);
    renderApp('/admin/audit');
    expect(await screen.findByRole('alert')).toHaveTextContent('do not have access');
    expect(screen.queryByRole('link', { name: 'Audit log' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Jobs' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.key.includes('/api/admin/'))).toBe(false);
  });
});

describe('audit log page', () => {
  it('lists records with who did what, and shows system actions', async () => {
    mockFetch({
      ...asAdmin,
      'GET /api/admin/audit-log/actions': () => json(200, { data: ['hall.created'] }),
      'GET /api/admin/audit-log?limit=25&offset=0': () =>
        auditPage([
          record(),
          record({ id: '2', action: 'auth.login_failed', actor: null, targetType: null }),
        ]),
    });
    renderApp('/admin/audit');
    expect(await screen.findByText('Ada Admin (admin@college.test)')).toBeInTheDocument();
    expect(screen.getByText('System / not signed in')).toBeInTheDocument();
    expect(screen.getByText('1–2 of 2')).toBeInTheDocument();
  });

  it('shows text from records as plain text, never as markup', async () => {
    mockFetch({
      ...asAdmin,
      'GET /api/admin/audit-log/actions': () => json(200, { data: [] }),
      'GET /api/admin/audit-log?limit=25&offset=0': () =>
        auditPage([record({ metadata: { note: '<img src=x onerror=alert(1)>' } })]),
    });
    const { container } = renderApp('/admin/audit');
    expect(await screen.findByText(/onerror=alert/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('searches by action and starts again from the first page', async () => {
    const { calls } = mockFetch({
      ...asAdmin,
      'GET /api/admin/audit-log/actions': () =>
        json(200, { data: ['hall.created', 'booking.requested'] }),
      'GET /api/admin/audit-log?limit=25&offset=0': () => auditPage([record()]),
      'GET /api/admin/audit-log?limit=25&offset=0&action=booking.requested': () =>
        auditPage([record({ id: '9', action: 'booking.requested' })]),
    });
    renderApp('/admin/audit');
    await screen.findByText('Ada Admin (admin@college.test)');
    await userEvent.selectOptions(screen.getByLabelText('Action'), 'booking.requested');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findAllByText('booking.requested')).not.toHaveLength(0);
    expect(calls.map((c) => c.key)).toContain(
      'GET /api/admin/audit-log?limit=25&offset=0&action=booking.requested',
    );
  });

  it('moves between pages', async () => {
    const { calls } = mockFetch({
      ...asAdmin,
      'GET /api/admin/audit-log/actions': () => json(200, { data: [] }),
      'GET /api/admin/audit-log?limit=25&offset=0': () => auditPage([record()], 30, 0),
      'GET /api/admin/audit-log?limit=25&offset=25': () =>
        auditPage([record({ id: '26', action: 'user.updated' })], 30, 25),
    });
    renderApp('/admin/audit');
    await screen.findByText('1–25 of 30');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('26–30 of 30')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(calls.map((c) => c.key)).toContain('GET /api/admin/audit-log?limit=25&offset=25');
  });
});

const job = (over: Record<string, unknown> = {}) => ({
  id: 'j1',
  type: 'email.send',
  status: 'failed',
  attempts: 5,
  maxAttempts: 5,
  lastError: 'SMTP connection refused',
  updatedAt: '2031-03-01T04:30:00.000Z',
  ...over,
});
const counts = { queued: 2, running: 0, succeeded: 40, failed: 1 };
const jobsPage = (data: unknown[]) => json(200, { data, counts, page: { total: data.length } });

describe('background jobs page', () => {
  it('shows failed jobs first, with counts and the last error', async () => {
    mockFetch({
      ...asAdmin,
      'GET /api/admin/jobs?status=failed&limit=100': () => jobsPage([job()]),
    });
    renderApp('/admin/jobs');
    expect(await screen.findByText('SMTP connection refused')).toBeInTheDocument();
    expect(screen.getByText('5 / 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show failed jobs' })).toHaveTextContent(
      'failed (1)',
    );
    expect(screen.getByRole('button', { name: 'Show succeeded jobs' })).toHaveTextContent(
      'succeeded (40)',
    );
  });

  it('retries a failed job and reloads the list', async () => {
    let failed = [job()];
    const { calls } = mockFetch({
      ...asAdmin,
      'GET /api/admin/jobs?status=failed&limit=100': () => jobsPage(failed),
      'POST /api/admin/jobs/j1/retry': () => {
        failed = [];
        return json(200, { data: { id: 'j1', status: 'queued' } });
      },
    });
    renderApp('/admin/jobs');
    await userEvent.click(await screen.findByRole('button', { name: 'Retry email.send job' }));
    expect(await screen.findByText('No failed jobs.')).toBeInTheDocument();
    expect(calls.map((c) => c.key)).toContain('POST /api/admin/jobs/j1/retry');
  });

  it('shows the server message when the job cannot be retried', async () => {
    mockFetch({
      ...asAdmin,
      'GET /api/admin/jobs?status=failed&limit=100': () => jobsPage([job()]),
      'POST /api/admin/jobs/j1/retry': () =>
        json(409, {
          error: { code: 'JOB_NOT_FAILED', message: 'Only failed jobs can be retried' },
        }),
    });
    renderApp('/admin/jobs');
    await userEvent.click(await screen.findByRole('button', { name: 'Retry email.send job' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only failed jobs can be retried');
  });

  it('offers no retry for jobs that are not failed', async () => {
    mockFetch({
      ...asAdmin,
      'GET /api/admin/jobs?status=failed&limit=100': () => jobsPage([]),
      'GET /api/admin/jobs?status=queued&limit=100': () =>
        jobsPage([job({ status: 'queued', lastError: null, attempts: 0 })]),
    });
    renderApp('/admin/jobs');
    await screen.findByText('No failed jobs.');
    await userEvent.click(screen.getByRole('button', { name: 'Show queued jobs' }));
    const row = (await screen.findByText('email.send')).closest('tr')!;
    expect(within(row).queryByRole('button')).toBeNull();
  });
});
