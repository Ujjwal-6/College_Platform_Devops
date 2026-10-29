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
  inside: 2,
  checkedOut: 0,
  completed: 0,
  open: true,
  checkOutOpen: true,
  opensAt: '2031-03-01T02:30:00.000Z',
  closesAt: '2031-03-01T06:30:00.000Z',
  checkOutClosesAt: '2031-03-01T07:30:00.000Z',
  settings: { allowWalkIns: false, requireCheckOut: true },
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
  checkedOutAt: null,
  checkedOutBy: null,
  checkOutMethod: null,
  checkOutReason: null,
  leftEarly: null,
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
      counts: { registered: 5, checkedIn: 3, inside: 3 },
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
    expect(await screen.findByRole('heading', { name: 'Record by hand' })).toBeInTheDocument();
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
    expect(screen.queryByRole('heading', { name: 'Record by hand' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Settings for this event' }),
    ).not.toBeInTheDocument();
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

const out = (over: Record<string, unknown> = {}) =>
  json(201, {
    data: {
      attendanceId: 'a1',
      registrationId: 'r1',
      attendee: { id: 'u1', name: 'Priya Sharma' },
      team: null,
      method: 'qr',
      checkedInAt: '2031-03-01T04:00:00.000Z',
      checkedOutAt: '2031-03-01T04:45:00.000Z',
      stayedMinutes: 45,
      leftEarly: false,
      counts: { registered: 5, checkedIn: 2, inside: 1 },
      ...over,
    },
  });

describe('leaving (check-out)', () => {
  it('shows the live numbers including who is inside and who stayed', async () => {
    mockFetch(base(organizerUser, summary({ inside: 1, checkedOut: 1, completed: 1 })));
    renderApp('/events/e1/check-in');
    expect(await screen.findByText(/1 inside · 1 left · 1 stayed to the end/)).toBeInTheDocument();
  });

  it('checks a code out when the person is recording people leaving', async () => {
    const { calls } = mockFetch({
      ...base(),
      'POST /api/events/e1/check-outs': () => out({ stayedMinutes: 135, leftEarly: false }),
    });
    renderApp('/events/e1/check-in');
    await userEvent.click(await screen.findByLabelText('Leaving'));
    await userEvent.type(screen.getByLabelText('Pass code (type or paste)'), 'EQ1.some.code');
    await userEvent.click(screen.getByRole('button', { name: 'Check out' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Priya Sharma is checked out after 2 h 15 min.',
    );
    const post = calls.find((c) => c.key === 'POST /api/events/e1/check-outs')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ token: 'EQ1.some.code' });
    expect(calls.some((c) => c.key === 'POST /api/events/e1/check-ins')).toBe(false);
  });

  it('warns when the person left early', async () => {
    mockFetch({
      ...base(),
      'POST /api/events/e1/check-outs': () => out({ stayedMinutes: 20, leftEarly: true }),
    });
    renderApp('/events/e1/check-in');
    await userEvent.click(await screen.findByLabelText('Leaving'));
    await userEvent.type(screen.getByLabelText('Pass code (type or paste)'), 'EQ1.a.b');
    await userEvent.click(screen.getByRole('button', { name: 'Check out' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'checked out after 20 min. Left early.',
    );
  });

  it('uses the camera for leaving too', async () => {
    const { calls } = mockFetch({ ...base(), 'POST /api/events/e1/check-outs': () => out() });
    renderApp('/events/e1/check-in');
    await userEvent.click(await screen.findByLabelText('Leaving'));
    await userEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await userEvent.click(await screen.findByRole('button', { name: 'simulate scan' }));
    expect(await screen.findByRole('status')).toHaveTextContent('is checked out');
    expect(calls.some((c) => c.key === 'POST /api/events/e1/check-outs')).toBe(true);
  });

  it('says "already checked out" with the time, and why a check-out was refused', async () => {
    mockFetch({
      ...base(),
      'POST /api/events/e1/check-outs': () =>
        json(409, {
          error: {
            code: 'ALREADY_CHECKED_OUT',
            message: 'This person has already been checked out',
            details: { checkedOutAt: '2031-03-01T04:45:00.000Z', method: 'qr' },
          },
        }),
    });
    renderApp('/events/e1/check-in');
    await userEvent.click(await screen.findByLabelText('Leaving'));
    await userEvent.type(screen.getByLabelText('Pass code (type or paste)'), 'EQ1.a.b');
    await userEvent.click(screen.getByRole('button', { name: 'Check out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Already checked out at .*10:15/);
  });

  it('shows the not-checked-in refusal from the server', async () => {
    mockFetch({
      ...base(),
      'POST /api/events/e1/check-outs': () =>
        json(409, {
          error: {
            code: 'NOT_CHECKED_IN',
            message: 'This person has not been checked in, so cannot be checked out',
          },
        }),
    });
    renderApp('/events/e1/check-in');
    await userEvent.click(await screen.findByLabelText('Leaving'));
    await userEvent.type(screen.getByLabelText('Pass code (type or paste)'), 'EQ1.a.b');
    await userEvent.click(screen.getByRole('button', { name: 'Check out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('has not been checked in');
  });

  it('disables leaving, with an explanation, when check-out is closed, but arriving can still be open', async () => {
    mockFetch(base(organizerUser, summary({ checkOutOpen: false })));
    renderApp('/events/e1/check-in');
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeEnabled();
    await userEvent.click(screen.getByLabelText('Leaving'));
    expect(screen.getByText(/Check-out is closed right now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check out' })).toBeDisabled();
  });

  it('shows in the list who left, who left early, and who is still inside', async () => {
    mockFetch({
      ...base(),
      [ATTENDANCE]: () =>
        overview(summary(), [
          row({
            id: 'a1',
            attendee: { id: 'u1', name: 'Priya Sharma' },
            checkedOutAt: '2031-03-01T06:20:00.000Z',
            leftEarly: false,
          }),
          row({
            id: 'a2',
            attendee: { id: 'u2', name: 'Ravi Kumar' },
            checkedOutAt: '2031-03-01T05:00:00.000Z',
            leftEarly: true,
          }),
          row({ id: 'a3', attendee: { id: 'u3', name: 'Wendy Walker' }, method: 'walk_in' }),
        ]),
    });
    renderApp('/events/e1/check-in');
    const ravi = (await screen.findByText('Ravi Kumar')).closest('tr')!;
    expect(within(ravi).getByText(/\(left early\)/)).toBeInTheDocument();
    const wendy = screen.getByText('Wendy Walker').closest('tr')!;
    expect(within(wendy).getByText('Inside')).toBeInTheDocument();
    expect(within(wendy).getByText(/Walk-in/)).toBeInTheDocument();
    const priya = screen.getByText('Priya Sharma').closest('tr')!;
    expect(within(priya).queryByText(/left early/)).not.toBeInTheDocument();
  });
});

describe('walk-ins', () => {
  const allowed = (s = summary()) =>
    summary({ ...s, settings: { allowWalkIns: true, requireCheckOut: true } });

  it('are not offered unless the organizer allowed them', async () => {
    mockFetch(base());
    renderApp('/events/e1/check-in');
    await screen.findByText('2 of 5 checked in');
    expect(screen.queryByRole('heading', { name: 'Walk-in' })).not.toBeInTheDocument();
  });

  it('are offered to a volunteer too, and check the person in', async () => {
    const { calls } = mockFetch({
      ...base(studentUser, allowed()),
      'POST /api/events/e1/check-ins/walk-in': () => ok('Wendy Walker'),
    });
    renderApp('/events/e1/check-in');
    await userEvent.type(
      await screen.findByLabelText('Walk-in’s account email'),
      'wendy@college.test',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Check in walk-in' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Wendy Walker is registered and checked in as a walk-in.',
    );
    const post = calls.find((c) => c.key === 'POST /api/events/e1/check-ins/walk-in')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ email: 'wendy@college.test' });
  });

  it('shows why a walk-in was refused', async () => {
    mockFetch({
      ...base(organizerUser, allowed()),
      'POST /api/events/e1/check-ins/walk-in': () =>
        json(409, { error: { code: 'EVENT_FULL', message: 'This event is full' } }),
    });
    renderApp('/events/e1/check-in');
    await userEvent.type(
      await screen.findByLabelText('Walk-in’s account email'),
      'wendy@college.test',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Check in walk-in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This event is full');
  });

  it('cannot be submitted while check-in is closed', async () => {
    mockFetch(base(organizerUser, allowed(summary({ open: false }))));
    renderApp('/events/e1/check-in');
    expect(await screen.findByRole('button', { name: 'Check in walk-in' })).toBeDisabled();
  });
});

describe('the organizer’s settings', () => {
  it('shows the current choices and saves a change', async () => {
    let settings = { allowWalkIns: false, requireCheckOut: true };
    const { calls } = mockFetch({
      ...base(),
      [ATTENDANCE]: () => overview(summary({ settings })),
      'PUT /api/events/e1/attendance-settings': () => {
        settings = { ...settings, allowWalkIns: true };
        return json(200, { data: settings });
      },
    });
    renderApp('/events/e1/check-in');
    const walkIns = await screen.findByLabelText(/Allow walk-ins/);
    expect(walkIns).not.toBeChecked();
    expect(screen.getByLabelText(/Require check-out/)).toBeChecked();

    await userEvent.click(walkIns);
    await waitFor(() => expect(screen.getByLabelText(/Allow walk-ins/)).toBeChecked());
    const put = calls.find((c) => c.key === 'PUT /api/events/e1/attendance-settings')!;
    expect(JSON.parse(String(put.init?.body))).toEqual({ allowWalkIns: true });
    expect(await screen.findByRole('heading', { name: 'Walk-in' })).toBeInTheDocument();
  });

  it('shows the server message when a change is refused', async () => {
    mockFetch({
      ...base(),
      'PUT /api/events/e1/attendance-settings': () =>
        json(409, { error: { code: 'EVENT_ENDED', message: 'This event is closed or cancelled' } }),
    });
    renderApp('/events/e1/check-in');
    await userEvent.click(await screen.findByLabelText(/Require check-out/));
    expect(await screen.findByRole('alert')).toHaveTextContent('closed or cancelled');
  });
});

describe('checking out by hand', () => {
  const people = {
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
  };

  it('records leaving with a reason', async () => {
    const { calls } = mockFetch({
      ...base(),
      'GET /api/events/e1/registrations?status=registered&limit=100': () => json(200, people),
      'POST /api/events/e1/check-outs/manual': () =>
        out({ attendee: { id: 'u7', name: 'Ravi Kumar' }, method: 'manual' }),
    });
    renderApp('/events/e1/check-in');
    await screen.findByRole('option', { name: /Ravi Kumar/ });
    await userEvent.selectOptions(screen.getByLabelText('Person'), 'r7');
    await userEvent.type(screen.getByLabelText('Reason'), 'Pass would not scan');
    await userEvent.click(screen.getByRole('button', { name: 'Check out by hand' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Ravi Kumar is checked out by hand after 45 min.',
    );
    const post = calls.find((c) => c.key === 'POST /api/events/e1/check-outs/manual')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({
      registrationId: 'r7',
      reason: 'Pass would not scan',
    });
  });

  it('asks for the person and a reason before sending anything', async () => {
    const { calls } = mockFetch({
      ...base(),
      'GET /api/events/e1/registrations?status=registered&limit=100': () => json(200, people),
    });
    renderApp('/events/e1/check-in');
    await userEvent.click(await screen.findByRole('button', { name: 'Check out by hand' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose the person and give a reason',
    );
    expect(calls.some((c) => c.key.includes('/check-outs/manual'))).toBe(false);
  });
});
