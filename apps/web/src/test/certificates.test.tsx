import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import {
  adminUser,
  json,
  makeEvent,
  mockFetch,
  organizerUser,
  renderApp,
  session,
  studentUser,
} from './utils';

beforeEach(() => {
  setAccessToken(null);
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const noSession = {
  'POST /api/auth/refresh': () =>
    json(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'x' } }),
};

describe('verifying a certificate (public)', () => {
  const genuine = {
    valid: true,
    code: '7K2M-QX9D-4HT8-WB3N',
    holderName: 'Priya Sharma',
    eventTitle: 'Tech Symposium',
    eventStartAt: '2031-03-01T04:30:00.000Z',
    eventEndAt: '2031-03-01T06:30:00.000Z',
    issuedAt: '2031-03-02T04:30:00.000Z',
  };

  it('confirms a genuine code from the address, without signing in', async () => {
    const { calls } = mockFetch({
      ...noSession,
      'GET /api/certificates/verify/7K2M-QX9D-4HT8-WB3N': () => json(200, { data: genuine }),
    });
    renderApp('/verify/7K2M-QX9D-4HT8-WB3N');
    expect(await screen.findByText('This certificate is genuine.')).toBeInTheDocument();
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Tech Symposium')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.key.startsWith('GET /api/certificates/verify/'))).toBe(true);
  });

  it('says no certificate was found for an unknown code', async () => {
    mockFetch({
      ...noSession,
      'GET /api/certificates/verify/0000-0000-0000-0000': () =>
        json(404, {
          error: { code: 'CERTIFICATE_NOT_FOUND', message: 'No certificate with this code' },
        }),
    });
    renderApp('/verify/0000-0000-0000-0000');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No certificate was found with this code',
    );
    expect(screen.queryByText('This certificate is genuine.')).not.toBeInTheDocument();
  });

  it('checks a code that is typed in', async () => {
    const { calls } = mockFetch({
      ...noSession,
      'GET /api/certificates/verify/7k2m%20qx9d': () => json(200, { data: genuine }),
    });
    renderApp('/verify');
    await userEvent.type(await screen.findByLabelText('Certificate code'), '7k2m qx9d');
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('This certificate is genuine.')).toBeInTheDocument();
    expect(calls.map((c) => c.key)).toContain('GET /api/certificates/verify/7k2m%20qx9d');
  });

  it('shows nothing until a code is given', async () => {
    mockFetch(noSession);
    renderApp('/verify');
    expect(
      await screen.findByRole('heading', { name: 'Verify a certificate' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so when too many checks were made', async () => {
    mockFetch({
      ...noSession,
      'GET /api/certificates/verify/abc': () =>
        json(429, { error: { code: 'RATE_LIMITED', message: 'slow' } }),
    });
    renderApp('/verify/abc');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many checks');
  });

  it('shows a name as plain text, never as markup', async () => {
    mockFetch({
      ...noSession,
      'GET /api/certificates/verify/abc': () =>
        json(200, { data: { ...genuine, holderName: '<img src=x onerror=alert(1)>' } }),
    });
    const { container } = renderApp('/verify/abc');
    expect(await screen.findByText(/onerror=alert/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('my certificates', () => {
  const cert = (o: Record<string, unknown> = {}) => ({
    id: 'c1',
    eventId: 'e1',
    holderName: 'Sam Student',
    code: '7K2M-QX9D-4HT8-WB3N',
    status: 'ready',
    issuedAt: '2031-03-02T04:30:00.000Z',
    generatedAt: '2031-03-02T04:31:00.000Z',
    event: {
      id: 'e1',
      title: 'Tech Symposium',
      startAt: '2031-03-01T04:30:00.000Z',
      endAt: '2031-03-01T06:30:00.000Z',
    },
    ...o,
  });

  it('lists them with a link to the event and to the verification page', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/certificates': () => json(200, { data: [cert()] }),
    });
    renderApp('/certificates');
    expect(await screen.findByRole('link', { name: 'Tech Symposium' })).toHaveAttribute(
      'href',
      '/events/e1',
    );
    expect(screen.getByRole('link', { name: '7K2M-QX9D-4HT8-WB3N' })).toHaveAttribute(
      'href',
      '/verify/7K2M-QX9D-4HT8-WB3N',
    );
  });

  it('downloads the PDF with the sign-in token', async () => {
    const created = vi.fn(() => 'blob:fake');
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { calls } = mockFetch({
      ...session(studentUser),
      'GET /api/certificates': () => json(200, { data: [cert()] }),
      'GET /api/certificates/c1/download': () =>
        Promise.resolve(new Response('%PDF-1.3', { status: 200 })),
    });
    renderApp('/certificates');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Download certificate for Tech Symposium' }),
    );
    await waitFor(() => expect(click).toHaveBeenCalled());
    const get = calls.find((c) => c.key === 'GET /api/certificates/c1/download')!;
    expect((get.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    click.mockRestore();
  });

  it('shows "being prepared" until the PDF exists', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/certificates': () =>
        json(200, { data: [cert({ status: 'pending', generatedAt: null })] }),
    });
    renderApp('/certificates');
    expect(await screen.findByText('Being prepared…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download certificate/ })).not.toBeInTheDocument();
  });

  it('explains when there are none', async () => {
    mockFetch({ ...session(studentUser), 'GET /api/certificates': () => json(200, { data: [] }) });
    renderApp('/certificates');
    expect(await screen.findByText(/You have no certificates yet/)).toBeInTheDocument();
  });

  it('needs a signed-in user', async () => {
    mockFetch(noSession);
    renderApp('/certificates');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('certificates on the event page (staff)', () => {
  const finished = (o: Record<string, unknown> = {}) =>
    makeEvent({
      status: 'closed',
      organizerId: organizerUser.id,
      workflow: { approvals: [], history: [] },
      startAt: '2020-03-01T04:30:00.000Z',
      endAt: '2020-03-01T06:30:00.000Z',
      ...o,
    });
  /** A function, so each request gets a fresh response (a body can only be read once). */
  const data =
    (summary: Record<string, unknown> = {}, rows: object[] = []) =>
    () =>
      json(200, {
        summary: { eligible: 3, issued: 2, ready: 2, canIssue: true, ...summary },
        data: rows,
      });
  const row = (o: Record<string, unknown> = {}) => ({
    id: 'c1',
    eventId: 'e1',
    holderName: 'Priya Sharma',
    code: '7K2M-QX9D-4HT8-WB3N',
    status: 'ready',
    issuedAt: '2031-03-02T04:30:00.000Z',
    generatedAt: '2031-03-02T04:31:00.000Z',
    ...o,
  });
  const routes = (user: object, certs = data(), event = finished()) => ({
    ...session(user),
    'GET /api/events/e1': () => json(200, { data: event }),
    'GET /api/events/e1/certificates': certs,
  });

  it('shows the counts and who has one', async () => {
    mockFetch(
      routes(
        organizerUser,
        data({}, [
          row(),
          row({ id: 'c2', holderName: 'Ravi Kumar', status: 'pending', generatedAt: null }),
        ]),
      ),
    );
    renderApp('/events/e1');
    expect(await screen.findByText(/2 issued · 2 ready · 3 eligible/)).toBeInTheDocument();
    const ravi = screen.getByText('Ravi Kumar').closest('tr')!;
    expect(within(ravi).getByText('Being prepared')).toBeInTheDocument();
    expect(
      within(screen.getByText('Priya Sharma').closest('tr')!).getByText('Ready'),
    ).toBeInTheDocument();
  });

  it('asks for certificates to be issued', async () => {
    const { calls } = mockFetch({
      ...routes(organizerUser),
      'POST /api/events/e1/certificates/issue': () =>
        json(202, { data: { queued: true, eligible: 3, issued: 2 } }),
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByRole('button', { name: 'Issue certificates' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Certificates are being prepared');
    expect(calls.map((c) => c.key)).toContain('POST /api/events/e1/certificates/issue');
  });

  it('offers no issue button while the event cannot issue yet', async () => {
    mockFetch(routes(organizerUser, data({ canIssue: false })));
    renderApp('/events/e1');
    await screen.findByText(/2 issued/);
    expect(screen.queryByRole('button', { name: 'Issue certificates' })).not.toBeInTheDocument();
  });

  it('shows the server message when issuing is refused', async () => {
    mockFetch({
      ...routes(organizerUser),
      'POST /api/events/e1/certificates/issue': () =>
        json(409, {
          error: {
            code: 'EVENT_NOT_OVER',
            message: 'Certificates can be issued once the event has ended',
          },
        }),
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByRole('button', { name: 'Issue certificates' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('once the event has ended');
  });

  it('lets only an admin redraw a certificate', async () => {
    const { calls } = mockFetch({
      ...routes(adminUser, data({}, [row()])),
      'POST /api/certificates/c1/regenerate': () => json(202, { data: { queued: true } }),
    });
    renderApp('/events/e1');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Redraw certificate for Priya Sharma' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('redrawn with the current name');
    expect(calls.map((c) => c.key)).toContain('POST /api/certificates/c1/regenerate');
  });

  it('shows the organizer no redraw button', async () => {
    mockFetch(routes(organizerUser, data({}, [row()])));
    renderApp('/events/e1');
    await screen.findByText('Priya Sharma');
    expect(screen.queryByRole('button', { name: /Redraw/ })).not.toBeInTheDocument();
  });

  it('shows nothing, and asks for nothing, to someone who is not staff', async () => {
    const { calls } = mockFetch({
      ...session(studentUser),
      'GET /api/events/e1': () => json(200, { data: finished({ workflow: null }) }),
    });
    renderApp('/events/e1');
    await screen.findByRole('heading', { name: 'Tech Symposium' });
    expect(screen.queryByRole('heading', { name: 'Certificates' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.key.endsWith('/certificates'))).toBe(false);
  });
});
