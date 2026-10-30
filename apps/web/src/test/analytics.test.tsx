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

const hodUser = { ...adminUser, id: '9', name: 'Hal HOD', roles: ['hod'], departmentId: 'd1' };
const totals = {
  events: 2,
  registered: 15,
  checkedIn: 13,
  ratePercent: 86.7,
  feedbackCount: 4,
  feedbackAverage: 4.25,
  certificates: 9,
  budget: { estimateMinor: 150_000, actualMinor: 140_001, overBudgetEvents: 1 },
};
const summary =
  (o: Record<string, unknown> = {}) =>
  () =>
    json(200, {
      data: {
        period: { from: '2031-01-01', to: '2031-03-31', days: 90 },
        scope: { departmentId: null },
        truncated: false,
        totals,
        events: [
          {
            id: 'e1',
            title: 'Alpha',
            status: 'closed',
            startAt: '2031-02-01T04:30:00.000Z',
            department: { id: 'd1', name: 'Computer Science' },
            organizer: 'Olive',
            registered: 10,
            checkedIn: 8,
            ratePercent: 80,
            noShows: 2,
            feedbackCount: 3,
            feedbackAverage: 4.33,
            certificates: 8,
            budget: { estimateMinor: 100_000, actualMinor: 120_001, overBudget: true },
          },
        ],
        departments: [
          { id: 'd1', name: 'Computer Science', ...totals },
          { id: 'd2', name: 'Electronics', ...totals },
        ],
        registrationsPerDay: [
          { date: '2031-01-01', count: 3 },
          { date: '2031-01-02', count: 0 },
        ],
        halls: [
          {
            id: 'h1',
            name: 'Main Hall',
            capacity: 300,
            bookings: 4,
            bookedHours: 6.5,
            availableHours: 120,
            utilizationPercent: 5.4,
          },
        ],
        ...o,
      },
    });
const routes = (user: object, get = summary()) => ({
  ...session(user),
  'GET /api/analytics/summary': get,
  'GET /api/departments': () =>
    json(200, {
      data: [
        { id: 'd1', name: 'Computer Science' },
        { id: 'd2', name: 'Electronics' },
      ],
    }),
});

describe('analytics page', () => {
  it('shows totals, events, departments and hall utilization to an admin', async () => {
    mockFetch(routes(adminUser));
    renderApp('/analytics');
    const totalsList = await screen.findByRole('list', { name: 'Totals' });
    expect(within(totalsList).getByText(/attendance rate 86.7%/)).toBeInTheDocument();
    expect(
      within(totalsList).getByText(/planned ₹1,500.00, spent ₹1,400.01 · 1 above plan/),
    ).toBeInTheDocument();
    const events = screen.getByRole('table', { name: 'Events' });
    expect(within(events).getByRole('link', { name: 'Alpha' })).toHaveAttribute(
      'href',
      '/events/e1',
    );
    expect(within(events).getByText('₹1,000.00 / ₹1,200.01 (above plan)')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Departments' })).toBeInTheDocument();
    const halls = screen.getByRole('table', { name: 'Hall utilization' });
    expect(within(halls).getByText('5.4%')).toBeInTheDocument();
  });

  it('shows a HOD their own view, without halls or the department choice', async () => {
    mockFetch(routes(hodUser, summary({ halls: null, departments: [] })));
    renderApp('/analytics');
    await screen.findByRole('list', { name: 'Totals' });
    expect(screen.queryByRole('table', { name: 'Hall utilization' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Department')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download halls (CSV)' })).not.toBeInTheDocument();
  });

  it('asks for the chosen period and department', async () => {
    const { calls } = mockFetch(routes(adminUser));
    renderApp('/analytics');
    await screen.findByRole('list', { name: 'Totals' });
    await userEvent.type(screen.getByLabelText('From'), '2031-01-01');
    await userEvent.type(screen.getByLabelText('To'), '2031-01-31');
    await userEvent.selectOptions(await screen.findByLabelText('Department'), 'd2');
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.key === 'GET /api/analytics/summary?from=2031-01-01&to=2031-01-31&departmentId=d2',
        ),
      ).toBe(true),
    );
  });

  it('downloads the CSV for the period on screen', async () => {
    const created: string[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      created.push(this.download);
    });
    const { calls } = mockFetch({
      ...routes(adminUser),
      'GET /api/analytics/events.csv': () =>
        Promise.resolve(new Response('Event\r\n', { status: 200 })),
    });
    renderApp('/analytics');
    await userEvent.click(await screen.findByRole('button', { name: 'Download events (CSV)' }));
    await waitFor(() => expect(created).toEqual(['events.csv']));
    expect(calls.some((c) => c.key === 'GET /api/analytics/events.csv')).toBe(true);
    click.mockRestore();
  });

  it('shows the API message when the period is refused', async () => {
    mockFetch(
      routes(adminUser, () =>
        json(400, {
          error: { code: 'VALIDATION_ERROR', message: 'The period can be at most 366 days' },
        }),
      ),
    );
    renderApp('/analytics');
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 366 days');
  });

  it('warns when the list was cut short', async () => {
    mockFetch(routes(adminUser, summary({ truncated: true })));
    renderApp('/analytics');
    expect(await screen.findByText(/Only the first events/)).toBeInTheDocument();
  });

  it('is not offered to others', async () => {
    for (const user of [organizerUser, studentUser]) {
      mockFetch(routes(user));
      const { unmount } = renderApp('/analytics');
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Analytics' })).not.toBeInTheDocument(),
      );
      expect(screen.queryByRole('link', { name: 'Analytics' })).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('analytics on an event', () => {
  it('shows an organizer the numbers of their published event', async () => {
    mockFetch({
      ...session(organizerUser),
      'GET /api/events/e1': () =>
        json(200, {
          data: makeEvent({
            status: 'published',
            organizerId: organizerUser.id,
            workflow: { approvals: [], history: [] },
          }),
        }),
      'GET /api/events/e1/analytics': () =>
        json(200, {
          data: {
            registrations: {
              registered: 10,
              perDay: [{ date: '2031-02-01', count: 10, cumulative: 10 }],
            },
            attendance: { checkedIn: 8, ratePercent: 80, noShows: 2, completed: 7 },
            feedback: { count: 3, average: 4.33, distribution: [0, 0, 1, 0, 2] },
            certificates: { issued: 8 },
            budget: { estimateMinor: 100_000, actualMinor: 120_001, overBudget: true },
          },
        }),
    });
    renderApp('/events/e1');
    expect(await screen.findByText(/attendance rate 80%/)).toBeInTheDocument();
    expect(screen.getByText(/2 did not come/)).toBeInTheDocument();
    expect(screen.getByText(/4.33 out of 5 from 3 responses/)).toBeInTheDocument();
    expect(screen.getByText(/spent ₹1,200.01 \(above plan\)/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Registrations per day' })).toBeInTheDocument();
  });
});
