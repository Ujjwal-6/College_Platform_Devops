import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import { adminUser, json, makeEvent, mockFetch, renderApp, session, studentUser } from './utils';

beforeEach(() => {
  setAccessToken(null);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const published = (over: Record<string, unknown> = {}) =>
  makeEvent({ status: 'published', workflow: null, registrationEligible: true, ...over });
const eventRoute = (e: object) => ({ 'GET /api/events/e1': () => json(200, { data: e }) });

const mineView = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  eventId: 'e1',
  status: 'registered',
  cancelReason: null,
  registeredAt: '2031-02-01T04:30:00.000Z',
  cancelledAt: null,
  team: null,
  ...over,
});
const summary = (over: Record<string, unknown> = {}) =>
  json(200, {
    data: {
      eventId: 'e1',
      registrationMode: 'individual',
      capacity: 50,
      registered: 12,
      seatsLeft: 38,
      open: true,
      full: false,
      mine: null,
      ...over,
    },
  });
const SUMMARY = 'GET /api/events/e1/registration-summary';

describe('registering for an event', () => {
  it('shows the seats and registers with one click, sending an Idempotency-Key', async () => {
    let mine: object | null = null;
    const { calls } = mockFetch({
      ...session(studentUser),
      ...eventRoute(published({ capacity: 50 })),
      [SUMMARY]: () => summary({ mine }),
      'POST /api/events/e1/registrations': () => {
        mine = mineView();
        return json(201, { data: mine });
      },
    });
    renderApp('/events/e1');
    expect(await screen.findByText('12 of 50 seats taken · 38 left')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Register' }));
    expect(await screen.findByText('You are registered')).toBeInTheDocument();

    const post = calls.find((c) => c.key === 'POST /api/events/e1/registrations')!;
    const headers = post.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.queryByRole('button', { name: 'Register' })).not.toBeInTheDocument();
  });

  it('sends only one request when the button is clicked twice quickly', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = mockFetch({
      ...session(studentUser),
      ...eventRoute(published()),
      [SUMMARY]: () => summary(),
      'POST /api/events/e1/registrations': async () => {
        await gate;
        return json(201, { data: mineView() });
      },
    });
    renderApp('/events/e1');
    const button = await screen.findByRole('button', { name: 'Register' });
    await userEvent.dblClick(button);
    release();
    await screen.findByRole('button', { name: 'Register' });
    expect(calls.filter((c) => c.key === 'POST /api/events/e1/registrations')).toHaveLength(1);
  });

  it('says when the event is full and offers no button', async () => {
    mockFetch({
      ...session(studentUser),
      ...eventRoute(published({ capacity: 50 })),
      [SUMMARY]: () => summary({ registered: 50, seatsLeft: 0, full: true }),
    });
    renderApp('/events/e1');
    expect(await screen.findByText('This event is full.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register' })).not.toBeInTheDocument();
  });

  it('says when registration is closed', async () => {
    mockFetch({
      ...session(studentUser),
      ...eventRoute(published({ registrationEligible: false })),
      [SUMMARY]: () => summary({ open: false }),
    });
    renderApp('/events/e1');
    expect(await screen.findByText('Registration is closed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register' })).not.toBeInTheDocument();
  });

  it('shows the server message when registering is refused', async () => {
    mockFetch({
      ...session(studentUser),
      ...eventRoute(published()),
      [SUMMARY]: () => summary(),
      'POST /api/events/e1/registrations': () =>
        json(409, { error: { code: 'EVENT_FULL', message: 'This event is full' } }),
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByRole('button', { name: 'Register' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This event is full');
  });

  it('cancels a registration', async () => {
    let mine: object | null = mineView();
    const { calls } = mockFetch({
      ...session(studentUser),
      ...eventRoute(published()),
      [SUMMARY]: () => summary({ mine }),
      'POST /api/registrations/r1/cancel': () => {
        mine = mineView({ status: 'cancelled', cancelReason: 'self' });
        return json(200, { data: mine });
      },
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel registration' }));
    expect(await screen.findByRole('button', { name: 'Register' })).toBeInTheDocument();
    expect(calls.map((c) => c.key)).toContain('POST /api/registrations/r1/cancel');
  });

  it('does not offer cancelling once the event has started', async () => {
    mockFetch({
      ...session(studentUser),
      ...eventRoute(
        published({ startAt: '2020-01-01T04:30:00.000Z', endAt: '2020-01-01T06:30:00.000Z' }),
      ),
      [SUMMARY]: () => summary({ mine: mineView() }),
    });
    renderApp('/events/e1');
    expect(await screen.findByText('You are registered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel registration' })).not.toBeInTheDocument();
  });
});

const teamEvent = (over: Record<string, unknown> = {}) =>
  published({ registrationMode: 'team', teamSizeMin: 2, teamSizeMax: 4, ...over });
const teamSummary = (over: Record<string, unknown> = {}) => ({
  registrationMode: 'team',
  ...over,
});
const teamView = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  eventId: 'e1',
  name: 'Code Ninjas',
  status: 'active',
  leader: { id: '2', name: 'Sam Student' },
  size: 1,
  minSize: 2,
  maxSize: 4,
  complete: false,
  members: [{ userId: '2', name: 'Sam Student', registrationId: 'r1', isLeader: true }],
  invitation: { active: true, expiresAt: '2031-02-08T04:30:00.000Z' },
  ...over,
});

describe('team registration', () => {
  it('creates a team and shows the invitation code once', async () => {
    let mine: object | null = null;
    const { calls } = mockFetch({
      ...session(studentUser),
      ...eventRoute(teamEvent()),
      [SUMMARY]: () => summary(teamSummary({ mine })),
      'POST /api/events/e1/teams': () => {
        mine = mineView({
          team: { id: 't1', name: 'Code Ninjas', isLeader: true, status: 'active' },
        });
        return json(201, {
          data: {
            registration: mine,
            team: teamView(),
            invitationCode: '7K2M-QX9D-4HT8-WB3N',
            invitationExpiresAt: '2031-02-08T04:30:00.000Z',
          },
        });
      },
      'GET /api/teams/t1': () => json(200, { data: teamView() }),
    });
    renderApp('/events/e1');
    await userEvent.type(await screen.findByLabelText('Team name'), 'Code Ninjas');
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }));

    expect(await screen.findByText('7K2M-QX9D-4HT8-WB3N')).toBeInTheDocument();
    expect(screen.getByText(/shown only now/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Team “Code Ninjas”' })).toBeInTheDocument();
    expect(screen.getByText(/needs at least 2 members \(1 more\)/)).toBeInTheDocument();
    const post = calls.find((c) => c.key === 'POST /api/events/e1/teams')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ name: 'Code Ninjas' });
    expect((post.init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    // the code lives only on screen, never in browser storage
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('7K2M');
  });

  it('joins a team with a code', async () => {
    let mine: object | null = null;
    const { calls } = mockFetch({
      ...session(studentUser),
      ...eventRoute(teamEvent()),
      [SUMMARY]: () => summary(teamSummary({ mine })),
      'POST /api/teams/join': () => {
        mine = mineView({
          team: { id: 't1', name: 'Code Ninjas', isLeader: false, status: 'active' },
        });
        return json(201, { data: { registration: mine, team: teamView({ size: 2 }) } });
      },
      'GET /api/teams/t1': () =>
        json(200, {
          data: teamView({
            size: 2,
            complete: true,
            invitation: undefined,
            leader: { id: '9', name: 'Lena Leader' },
            members: [
              { userId: '9', name: 'Lena Leader', registrationId: 'r0', isLeader: true },
              { userId: '2', name: 'Sam Student', registrationId: 'r1', isLeader: false },
            ],
          }),
        }),
    });
    renderApp('/events/e1');
    await userEvent.type(await screen.findByLabelText('Invitation code'), '7k2m qx9d 4ht8 wb3n');
    await userEvent.click(screen.getByRole('button', { name: 'Join team' }));

    expect(await screen.findByText('Lena Leader (leader)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New invitation code' })).not.toBeInTheDocument();
    const post = calls.find((c) => c.key === 'POST /api/teams/join')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ code: '7k2m qx9d 4ht8 wb3n' });
  });

  it('shows a wrong code as the server words it', async () => {
    mockFetch({
      ...session(studentUser),
      ...eventRoute(teamEvent()),
      [SUMMARY]: () => summary(teamSummary()),
      'POST /api/teams/join': () =>
        json(404, {
          error: {
            code: 'INVALID_INVITATION',
            message: 'This invitation code is invalid or has expired',
          },
        }),
    });
    renderApp('/events/e1');
    await userEvent.type(await screen.findByLabelText('Invitation code'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Join team' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid or has expired');
  });

  it('lets the leader get a new code, which replaces the old one on screen, and turn the code off', async () => {
    let active = true;
    const { calls } = mockFetch({
      ...session(studentUser),
      ...eventRoute(teamEvent()),
      [SUMMARY]: () =>
        summary(
          teamSummary({
            mine: mineView({
              team: { id: 't1', name: 'Code Ninjas', isLeader: true, status: 'active' },
            }),
          }),
        ),
      'GET /api/teams/t1': () =>
        json(200, {
          data: teamView({ invitation: { active, expiresAt: '2031-02-08T04:30:00.000Z' } }),
        }),
      'POST /api/teams/t1/invitation': () =>
        json(200, {
          data: {
            invitationCode: 'AAAA-BBBB-CCCC-DDDD',
            invitationExpiresAt: '2031-02-08T04:30:00.000Z',
          },
        }),
      'POST /api/teams/t1/invitation/revoke': () => {
        active = false;
        return json(200, { data: { revoked: true } });
      },
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByRole('button', { name: 'New invitation code' }));
    expect(await screen.findByText('AAAA-BBBB-CCCC-DDDD')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Turn off code' }));
    expect(await screen.findByText('No active invitation code')).toBeInTheDocument();
    expect(screen.queryByText('AAAA-BBBB-CCCC-DDDD')).not.toBeInTheDocument();
    expect(calls.map((c) => c.key)).toContain('POST /api/teams/t1/invitation/revoke');
  });
});

describe('who sees the registrants', () => {
  const rows = [
    {
      ...mineView({
        id: 'r9',
        team: { id: 't1', name: 'Code Ninjas', isLeader: true, status: 'active' },
      }),
      user: { id: 'u9', name: 'Rhea Registrant', email: 'rhea@college.test' },
    },
  ];

  it('shows names and emails to event staff', async () => {
    mockFetch({
      ...session(adminUser),
      ...eventRoute(published({ workflow: { approvals: [], history: [] } })),
      [SUMMARY]: () => summary({ registered: 1 }),
      'GET /api/events/e1/registrations?status=registered&limit=100': () =>
        json(200, { data: rows, page: { total: 1, limit: 100, offset: 0 } }),
    });
    renderApp('/events/e1');
    expect(await screen.findByText('Rhea Registrant')).toBeInTheDocument();
    expect(screen.getByText('rhea@college.test')).toBeInTheDocument();
    expect(screen.getByText('Code Ninjas')).toBeInTheDocument();
  });

  it('never asks for the list when the viewer is not staff', async () => {
    const { calls } = mockFetch({
      ...session(studentUser),
      ...eventRoute(published()),
      [SUMMARY]: () => summary(),
    });
    renderApp('/events/e1');
    await screen.findByText('12 of 50 seats taken · 38 left');
    expect(calls.some((c) => c.key.includes('/registrations?'))).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Registered people' })).not.toBeInTheDocument();
  });

  it('shows text from a name as plain text, never as markup', async () => {
    const evil = [
      {
        ...rows[0]!,
        user: { id: 'u', name: '<img src=x onerror=alert(1)>', email: 'x@college.test' },
      },
    ];
    mockFetch({
      ...session(adminUser),
      ...eventRoute(published({ workflow: { approvals: [], history: [] } })),
      [SUMMARY]: () => summary({ registered: 1 }),
      'GET /api/events/e1/registrations?status=registered&limit=100': () =>
        json(200, { data: evil, page: { total: 1, limit: 100, offset: 0 } }),
    });
    const { container } = renderApp('/events/e1');
    expect(await screen.findByText(/onerror=alert/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('my registrations page', () => {
  const mineRow = (over: Record<string, unknown> = {}) => ({
    ...mineView(),
    event: {
      id: 'e1',
      title: 'Robotics Meet',
      startAt: '2031-03-01T04:30:00.000Z',
      endAt: '2031-03-01T06:30:00.000Z',
      status: 'published',
    },
    ...over,
  });

  it('lists registrations and cancels one', async () => {
    let rows = [mineRow()];
    const { calls } = mockFetch({
      ...session(studentUser),
      'GET /api/registrations': () => json(200, { data: rows }),
      'POST /api/registrations/r1/cancel': () => {
        rows = [mineRow({ status: 'cancelled', cancelReason: 'self' })];
        return json(200, { data: rows[0] });
      },
    });
    renderApp('/my-registrations');
    expect(await screen.findByRole('link', { name: 'Robotics Meet' })).toHaveAttribute(
      'href',
      '/events/e1',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel registration for Robotics Meet' }),
    );
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(calls.map((c) => c.key)).toContain('POST /api/registrations/r1/cancel');
  });

  it('explains a cancellation caused by the event, and offers no cancel button for it', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/registrations': () =>
        json(200, { data: [mineRow({ status: 'cancelled', cancelReason: 'event_cancelled' })] }),
    });
    renderApp('/my-registrations');
    expect(await screen.findByText('Cancelled (event cancelled)')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Cancel registration for/ }),
    ).not.toBeInTheDocument();
  });

  it('shows an empty message', async () => {
    mockFetch({ ...session(studentUser), 'GET /api/registrations': () => json(200, { data: [] }) });
    renderApp('/my-registrations');
    expect(
      await screen.findByText('You have not registered for any event yet.'),
    ).toBeInTheDocument();
  });

  it('needs a signed-in user', async () => {
    mockFetch({
      'POST /api/auth/refresh': () =>
        json(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'x' } }),
    });
    renderApp('/my-registrations');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('the waitlist', () => {
  const full = (over: Record<string, unknown> = {}) =>
    summary({
      registered: 50,
      seatsLeft: 0,
      full: true,
      waitlisted: 4,
      waitlistOpen: true,
      ...over,
    });

  it('offers to join the waitlist when the event is full, and sends waitlist: true', async () => {
    let mine: object | null = null;
    const { calls } = mockFetch({
      ...session(studentUser),
      ...eventRoute(published({ capacity: 50 })),
      [SUMMARY]: () => full({ mine }),
      'POST /api/events/e1/registrations': () => {
        mine = mineView({ status: 'waitlisted', waitlistPosition: 5 });
        return json(201, { data: mine });
      },
    });
    renderApp('/events/e1');
    expect(await screen.findByText('This event is full.')).toBeInTheDocument();
    expect(screen.getByText(/4 waiting/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    expect(await screen.findByText('You are on the waitlist')).toBeInTheDocument();
    expect(screen.getByText(/place 5/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).not.toBeInTheDocument();
    const post = calls.find((c) => c.key === 'POST /api/events/e1/registrations')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ waitlist: true });
    expect((post.init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });

  it('lets a waiting person leave the queue', async () => {
    let mine: object | null = mineView({ status: 'waitlisted', waitlistPosition: 2 });
    const { calls } = mockFetch({
      ...session(studentUser),
      ...eventRoute(published({ capacity: 50 })),
      [SUMMARY]: () => full({ mine }),
      'POST /api/registrations/r1/cancel': () => {
        mine = mineView({ status: 'cancelled', cancelReason: 'self' });
        return json(200, { data: mine });
      },
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByRole('button', { name: 'Leave the waitlist' }));
    expect(await screen.findByRole('button', { name: 'Join the waitlist' })).toBeInTheDocument();
    expect(calls.map((c) => c.key)).toContain('POST /api/registrations/r1/cancel');
  });

  it('shows no waitlist button for team events or closed registration', async () => {
    mockFetch({
      ...session(studentUser),
      ...eventRoute(teamEvent({ capacity: 50 })),
      [SUMMARY]: () => full({ waitlistOpen: false, registrationMode: 'team' }),
    });
    renderApp('/events/e1');
    expect(await screen.findByText('This event is full.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join the waitlist' })).not.toBeInTheDocument();
  });

  it('shows staff the waiting list with places, only when somebody is waiting', async () => {
    const waiting = [
      {
        ...mineView({ id: 'w1', status: 'waitlisted', waitlistPosition: 1 }),
        user: { id: 'u1', name: 'Wendy Waiting', email: 'wendy@college.test' },
      },
    ];
    mockFetch({
      ...session(adminUser),
      ...eventRoute(published({ capacity: 50, workflow: { approvals: [], history: [] } })),
      [SUMMARY]: () => full({ waitlisted: 1 }),
      'GET /api/events/e1/registrations?status=waitlisted&limit=100': () =>
        json(200, { data: waiting, page: { total: 1, limit: 100, offset: 0 } }),
    });
    renderApp('/events/e1');
    expect(await screen.findByRole('heading', { name: 'Waiting list' })).toBeInTheDocument();
    expect(screen.getByText('Wendy Waiting')).toBeInTheDocument();
    expect(screen.getByText('wendy@college.test')).toBeInTheDocument();
  });

  it('shows the place and a leave button on "my registrations"', async () => {
    const { calls } = mockFetch({
      ...session(studentUser),
      'GET /api/registrations': () =>
        json(200, {
          data: [
            {
              ...mineView({ status: 'waitlisted', waitlistPosition: 3 }),
              event: {
                id: 'e1',
                title: 'Robotics Meet',
                startAt: '2031-03-01T04:30:00.000Z',
                endAt: '2031-03-01T06:30:00.000Z',
                status: 'published',
              },
            },
          ],
        }),
      'POST /api/registrations/r1/cancel': () =>
        json(200, { data: mineView({ status: 'cancelled' }) }),
    });
    renderApp('/my-registrations');
    expect(await screen.findByText('Waitlisted (place 3)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Leave waitlist for Robotics Meet' }));
    expect(calls.map((c) => c.key)).toContain('POST /api/registrations/r1/cancel');
  });
});
