import { screen, within } from '@testing-library/react';
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

const over = (o: Record<string, unknown> = {}) =>
  makeEvent({
    status: 'closed',
    workflow: null,
    startAt: '2020-03-01T04:30:00.000Z',
    endAt: '2020-03-01T06:30:00.000Z',
    ...o,
  });
const state = (o: Record<string, unknown> = {}) => ({
  eligible: true,
  submitted: false,
  open: true,
  opensAt: '2020-03-01T06:30:00.000Z',
  closesAt: '2020-03-15T06:30:00.000Z',
  ...o,
});
const base = (user: object, event: object, mine: object = state()) => ({
  ...session(user),
  'GET /api/events/e1': () => json(200, { data: event }),
  'GET /api/events/e1/feedback/mine': () => json(200, { data: mine }),
  'GET /api/events/e1/registration-summary': () =>
    json(200, {
      data: {
        eventId: 'e1',
        registrationMode: 'individual',
        capacity: null,
        registered: 0,
        seatsLeft: null,
        open: false,
        full: false,
        waitlisted: 0,
        waitlistOpen: false,
        mine: null,
      },
    }),
});

describe('giving feedback', () => {
  it('lets a checked-in person rate the finished event, then thanks them', async () => {
    let mine = state();
    const { calls } = mockFetch({
      ...base(studentUser, over()),
      'GET /api/events/e1/feedback/mine': () => json(200, { data: mine }),
      'POST /api/events/e1/feedback': () => {
        mine = state({ submitted: true });
        return json(201, { data: { submitted: true } });
      },
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByLabelText('4 stars'));
    await userEvent.type(screen.getByLabelText('Comment (optional)'), 'Great speakers');
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(await screen.findByText(/your feedback was received/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send feedback' })).not.toBeInTheDocument();
    const post = calls.find((c) => c.key === 'POST /api/events/e1/feedback')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ rating: 4, comment: 'Great speakers' });
  });

  it('leaves out an empty comment', async () => {
    const { calls } = mockFetch({
      ...base(studentUser, over()),
      'POST /api/events/e1/feedback': () => json(201, { data: { submitted: true } }),
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByLabelText('5 stars'));
    await userEvent.type(screen.getByLabelText('Comment (optional)'), '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    await screen.findByText(/your feedback was received/);
    const post = calls.find((c) => c.key === 'POST /api/events/e1/feedback')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ rating: 5 });
  });

  it('asks for a rating before sending anything', async () => {
    const { calls } = mockFetch(base(studentUser, over()));
    renderApp('/events/e1');
    await userEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('choose a rating');
    expect(calls.some((c) => c.key === 'POST /api/events/e1/feedback')).toBe(false);
  });

  it('says it is anonymous to the organizers and when it closes', async () => {
    mockFetch(base(studentUser, over()));
    renderApp('/events/e1');
    expect(await screen.findByText(/anonymous to the organizers/)).toBeInTheDocument();
    expect(screen.getByText(/You can answer once/)).toBeInTheDocument();
  });

  it('shows the server message when sending is refused', async () => {
    mockFetch({
      ...base(studentUser, over()),
      'POST /api/events/e1/feedback': () =>
        json(409, {
          error: {
            code: 'ALREADY_SUBMITTED',
            message: 'You have already given feedback for this event',
          },
        }),
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByLabelText('3 stars'));
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already given feedback');
  });

  it('shows no form to someone who already answered', async () => {
    mockFetch(base(studentUser, over(), state({ submitted: true })));
    renderApp('/events/e1');
    expect(await screen.findByText(/your feedback was received/)).toBeInTheDocument();
    expect(screen.queryByLabelText('4 stars')).not.toBeInTheDocument();
  });

  it('says when feedback has closed', async () => {
    mockFetch(base(studentUser, over(), state({ open: false })));
    renderApp('/events/e1');
    expect(await screen.findByText('Feedback for this event is closed.')).toBeInTheDocument();
  });

  it('shows nothing to someone who was not checked in', async () => {
    mockFetch(base(studentUser, over(), state({ eligible: false })));
    renderApp('/events/e1');
    await screen.findByRole('heading', { name: 'Tech Symposium' });
    expect(screen.queryByRole('heading', { name: 'Feedback' })).not.toBeInTheDocument();
  });

  it('does not ask about feedback while the event is still to come', async () => {
    const { calls } = mockFetch(
      base(studentUser, makeEvent({ status: 'published', workflow: null })),
    );
    renderApp('/events/e1');
    await screen.findByRole('heading', { name: 'Tech Symposium' });
    expect(calls.some((c) => c.key.includes('/feedback'))).toBe(false);
  });
});

describe('what staff see', () => {
  const results = {
    summary: { count: 5, average: 4, distribution: [0, 1, 0, 2, 2] },
    comments: [
      { rating: 5, comment: 'Loved it' },
      { rating: 2, comment: '<img src=x onerror=alert(1)>' },
    ],
  };

  it('shows the average, how the ratings are spread and the comments', async () => {
    mockFetch({
      ...base(
        organizerUser,
        over({ organizerId: organizerUser.id, workflow: { approvals: [], history: [] } }),
        state({ eligible: false }),
      ),
      'GET /api/events/e1/feedback': () => json(200, { data: results }),
    });
    const { container } = renderApp('/events/e1');
    expect(await screen.findByText(/Average 4.0 out of 5/)).toBeInTheDocument();
    expect(screen.getByText(/from 5 responses/)).toBeInTheDocument();
    expect(screen.getByText('5 stars: 2')).toBeInTheDocument();
    expect(screen.getByText('2 stars: 1')).toBeInTheDocument();
    const comments = screen.getByRole('list', { name: 'Comments' });
    expect(within(comments).getByText(/Loved it/)).toBeInTheDocument();
    expect(within(comments).getByText(/onerror=alert/)).toBeInTheDocument(); // as text
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByLabelText('4 stars')).not.toBeInTheDocument(); // staff who were not checked in get no form
  });

  it('says when nobody has answered yet', async () => {
    mockFetch({
      ...base(
        adminUser,
        over({ workflow: { approvals: [], history: [] } }),
        state({ eligible: false }),
      ),
    });
    renderApp('/events/e1');
    expect(await screen.findByText('No feedback yet.')).toBeInTheDocument();
  });

  it('never asks for the results when the viewer is not staff', async () => {
    const { calls } = mockFetch(base(studentUser, over()));
    renderApp('/events/e1');
    await screen.findByLabelText('4 stars');
    expect(calls.some((c) => c.key === 'GET /api/events/e1/feedback')).toBe(false);
  });
});
