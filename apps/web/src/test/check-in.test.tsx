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

// The page is tested with a stand-in scanner that reports whatever the test tells it to.
vi.mock('../components/QrScanner', () => ({
  QrScanner: ({ active, onCode }: { active: boolean; onCode: (t: string) => void }) =>
    active ? (
      <div>
        <button onClick={() => onCode('EQ1.scanned.code')}>simulate scan</button>
      </div>
    ) : null,
}));

beforeEach(() => {
  setAccessToken(null);
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const summary = (over: Record<string, unknown> = {}) => ({
  registered: 5,
  checkedIn: 2,
  remaining: 3,
  open: true,
  opensAt: '2031-03-01T02:30:00.000Z',
  closesAt: '2031-03-01T06:30:00.000Z',
  ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  registrationId: 'r1',
  attendee: { id: 'u1', name: 'Priya Sharma' },
  checkedInBy: 'Olive Organizer',
  method: 'qr',
  reason: null,
  checkedInAt: '2031-03-01T04:40:00.000Z',
  ...over,
});
const overview = (s = summary(), data: object[] = [row()]) =>
  json(200, { summary: s, data, page: { total: data.length, limit: 15, offset: 0 } });
const ATTENDANCE = 'GET /api/events/e1/attendance?limit=15';
const EVENT = 'GET /api/events/e1';
const published = (over: Record<string, unknown> = {}) =>
  makeEvent({ status: 'published', organizerId: organizerUser.id, ...over });
const base = (user: object = organizerUser, s = summary()) => ({
  ...session(user),
  [EVENT]: () => json(200, { data: published() }),
  [ATTENDANCE]: () => overview(s),
  'GET /api/events/e1/registrations?status=registered&limit=100': () =>
    json(200, { data: [], page: { total: 0, limit: 100, offset: 0 } }),
  'GET /api/events/e1/volunteers': () => json(200, { data: [] }),
});
const ok = (name = 'Priya Sharma', team: string | null = null) =>
  json(201, {
    data: {
      attendanceId: 'a9',
      registrationId: 'r9',
      attendee: { id: 'u9', name },
      team,
      method: 'qr',
      checkedInAt: '2031-03-01T04:45:00.000Z',
      counts: { registered: 5, checkedIn: 3 },
    },
  });

describe('the gate screen', () => {
  it('shows the live count and the latest check-ins', async () => {
    mockFetch(base());
    renderApp('/events/e1/check-in');
    expect(await screen.findByText('2 of 5 checked in')).toBeInTheDocument();
    expect(screen.getByText(/3 still to come/)).toBeInTheDocument();
    expect(await screen.findByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText(/Scanned · Olive Organizer/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Check-in: Tech Symposium/ })).toBeInTheDocument();
  });

  it('checks a typed or pasted code in and shows who it was', async () => {
    const { calls } = mockFetch({
      ...base(),
      'POST /api/events/e1/check-ins': () => ok('Priya Sharma', 'Gate Crashers'),
    });
    renderApp('/events/e1/check-in');
    await userEvent.type(
      await screen.findByLabelText('Pass code (type or paste)'),
      '  EQ1.some.code ',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Check in' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Priya Sharma is checked in (team Gate Crashers).',
    );
    const post = calls.find((c) => c.key === 'POST /api/events/e1/check-ins')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ token: 'EQ1.some.code' });
    await waitFor(() => expect(screen.getByLabelText('Pass code (type or paste)')).toHaveValue(''));
    expect(calls.filter((c) => c.key === ATTENDANCE).length).toBeGreaterThan(1); // the count was refreshed
  });

  it('says "already checked in" with the time', async () => {
    mockFetch({
      ...base(),
      'POST /api/events/e1/check-ins': () =>
        json(409, {
          error: {
            code: 'ALREADY_CHECKED_IN',
            message: 'This person is already checked in',
            details: { checkedInAt: '2031-03-01T04:40:00.000Z', method: 'qr' },
          },
        }),
    });
    renderApp('/events/e1/check-in');
    await userEvent.type(await screen.findByLabelText('Pass code (type or paste)'), 'EQ1.a.b');
    await userEvent.click(screen.getByRole('button', { name: 'Check in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Already checked in at .*10:10/);
  });

  it('shows why a code was refused', async () => {
    mockFetch({
      ...base(),
      'POST /api/events/e1/check-ins': () =>
        json(400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: [{ path: 'token', message: 'This pass is for a different event' }],
          },
        }),
    });
    renderApp('/events/e1/check-in');
    await userEvent.type(await screen.findByLabelText('Pass code (type or paste)'), 'EQ1.a.b');
    await userEvent.click(screen.getByRole('button', { name: 'Check in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This pass is for a different event',
    );
  });

  it('checks in a code the camera reads, one at a time', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = mockFetch({
      ...base(),
      'POST /api/events/e1/check-ins': async () => {
        await gate;
        return ok();
      },
    });
    renderApp('/events/e1/check-in');
    await userEvent.click(await screen.findByRole('button', { name: 'Start camera' }));
    const scan = await screen.findByRole('button', { name: 'simulate scan' });
    await userEvent.click(scan);
    await userEvent.click(scan); // the camera sees the pass again while the first request is still running
    release();
    expect(await screen.findByRole('status')).toHaveTextContent('Priya Sharma is checked in.');
    expect(calls.filter((c) => c.key === 'POST /api/events/e1/check-ins')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Stop camera' })).toBeInTheDocument();
  });

  it('shows the window and disables checking in while it is closed', async () => {
    mockFetch(base(organizerUser, summary({ open: false })));
    renderApp('/events/e1/check-in');
    expect(await screen.findByText(/Check-in is closed right now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start camera' })).toBeDisabled();
  });

  it('shows by-hand check-ins with their reason', async () => {
    mockFetch({
      ...base(),
      [ATTENDANCE]: () => overview(summary(), [row({ method: 'manual', reason: 'Phone died' })]),
    });
    renderApp('/events/e1/check-in');
    expect(await screen.findByText(/By hand \(Phone died\)/)).toBeInTheDocument();
  });
});

describe('who sees what', () => {
  it('shows the organizer the by-hand form and the volunteers', async () => {
    mockFetch(base());
    renderApp('/events/e1/check-in');
    expect(await screen.findByRole('heading', { name: 'Check in by hand' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Volunteers' })).toBeInTheDocument();
  });

  it('shows an admin the same', async () => {
    mockFetch(base(adminUser));
    renderApp('/events/e1/check-in');
    expect(await screen.findByRole('heading', { name: 'Volunteers' })).toBeInTheDocument();
  });

  it('shows a volunteer only the scanning part, and never asks for registrants or volunteers', async () => {
    const { calls } = mockFetch({ ...base(studentUser) });
    renderApp('/events/e1/check-in');
    expect(await screen.findByLabelText('Pass code (type or paste)')).toBeInTheDocument();
    await screen.findByText('2 of 5 checked in');
    expect(screen.queryByRole('heading', { name: 'Check in by hand' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Volunteers' })).not.toBeInTheDocument();
    expect(
      calls.some((c) => c.key.includes('/volunteers') || c.key.includes('/registrations?')),
    ).toBe(false);
  });

  it('tells a person with no access, as the server words it', async () => {
    mockFetch({
      ...base(studentUser),
      [ATTENDANCE]: () => json(403, { error: { code: 'FORBIDDEN', message: 'No permission' } }),
      'POST /api/events/e1/check-ins': () =>
        json(403, {
          error: {
            code: 'FORBIDDEN',
            message: 'You do not have permission to perform this action',
          },
        }),
    });
    renderApp('/events/e1/check-in');
    await userEvent.type(await screen.findByLabelText('Pass code (type or paste)'), 'EQ1.a.b');
    await userEvent.click(screen.getByRole('button', { name: 'Check in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not have permission');
  });
});

describe('manual check-in and volunteers', () => {
  it('checks someone in by hand with a reason', async () => {
    const { calls } = mockFetch({
      ...base(),
      'GET /api/events/e1/registrations?status=registered&limit=100': () =>
        json(200, {
          data: [
            {
              id: 'r7',
              eventId: 'e1',
              status: 'registered',
              cancelReason: null,
              registeredAt: '2031-02-01T04:30:00.000Z',
              cancelledAt: null,
              waitlistPosition: null,
              team: null,
              user: { id: 'u7', name: 'Ravi Kumar', email: 'ravi@college.test' },
            },
          ],
          page: { total: 1, limit: 100, offset: 0 },
        }),
      'POST /api/events/e1/check-ins/manual': () => ok('Ravi Kumar'),
    });
    renderApp('/events/e1/check-in');
    await screen.findByRole('option', { name: /Ravi Kumar/ });
    await userEvent.selectOptions(screen.getByLabelText('Person'), 'r7');
    await userEvent.type(screen.getByLabelText('Reason'), 'Phone battery died');
    await userEvent.click(screen.getByRole('button', { name: 'Check in by hand' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Ravi Kumar is checked in by hand.',
    );
    const post = calls.find((c) => c.key === 'POST /api/events/e1/check-ins/manual')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({
      registrationId: 'r7',
      reason: 'Phone battery died',
    });
  });

  it('adds and removes volunteers', async () => {
    let list: object[] = [];
    const volunteer = {
      userId: 'v1',
      name: 'Vik Volunteer',
      email: 'vik@college.test',
      assignedAt: '2031-02-01T04:30:00.000Z',
    };
    const { calls } = mockFetch({
      ...base(),
      'GET /api/events/e1/volunteers': () => json(200, { data: list }),
      'POST /api/events/e1/volunteers': () => {
        list = [volunteer];
        return json(200, { data: list });
      },
      'DELETE /api/events/e1/volunteers/v1': () => {
        list = [];
        return json(200, { data: list });
      },
    });
    renderApp('/events/e1/check-in');
    await userEvent.type(await screen.findByLabelText('Volunteer email'), 'vik@college.test');
    await userEvent.click(screen.getByRole('button', { name: 'Add volunteer' }));
    expect(await screen.findByText(/Vik Volunteer \(vik@college.test\)/)).toBeInTheDocument();
    const added = calls.find((c) => c.key === 'POST /api/events/e1/volunteers')!;
    expect(JSON.parse(String(added.init?.body))).toEqual({ email: 'vik@college.test' });

    await userEvent.click(screen.getByRole('button', { name: 'Remove Vik Volunteer' }));
    expect(await screen.findByText('No volunteers yet.')).toBeInTheDocument();
  });

  it('shows the server message when a volunteer cannot be added', async () => {
    mockFetch({
      ...base(),
      'POST /api/events/e1/volunteers': () =>
        json(404, {
          error: { code: 'NOT_FOUND', message: 'Active user with that email not found' },
        }),
    });
    renderApp('/events/e1/check-in');
    await userEvent.type(await screen.findByLabelText('Volunteer email'), 'nobody@college.test');
    await userEvent.click(screen.getByRole('button', { name: 'Add volunteer' }));
    const alert = await screen.findByText('Active user with that email not found');
    expect(within(alert.closest('p')!).getByText(/not found/)).toBeInTheDocument();
  });
});

describe('the list of events to check in for', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    title: 'Tech Symposium',
    startAt: '2031-03-01T04:30:00.000Z',
    endAt: '2031-03-01T06:30:00.000Z',
    role: 'volunteer',
    ...over,
  });

  it('lists the events with the person’s role and a link', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/check-in/events': () =>
        json(200, { data: [entry(), entry({ id: 'e2', title: 'Hack Night', role: 'organizer' })] }),
    });
    renderApp('/check-in');
    expect(await screen.findByText('Tech Symposium')).toBeInTheDocument();
    expect(screen.getByText('Volunteer')).toBeInTheDocument();
    expect(screen.getByText('Organizer')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open check-in' })[0]).toHaveAttribute(
      'href',
      '/events/e1/check-in',
    );
  });

  it('explains when there is nothing to check in for', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/check-in/events': () => json(200, { data: [] }),
    });
    renderApp('/check-in');
    expect(await screen.findByText(/not set up to check anyone in/)).toBeInTheDocument();
  });

  it('needs a signed-in user', async () => {
    mockFetch({
      'POST /api/auth/refresh': () =>
        json(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'x' } }),
    });
    renderApp('/check-in');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
