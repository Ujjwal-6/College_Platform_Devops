import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import {
  adminUser,
  facultyUser,
  hall,
  json,
  makeBooking,
  makeEvent,
  mockFetch,
  organizerUser,
  renderApp,
  session,
  studentUser,
  withActions,
  withBookingActions,
} from './utils';

beforeEach(() => setAccessToken(null));
afterEach(() => vi.unstubAllGlobals());

const page = (rows: object[]) => () =>
  json(200, { data: rows, page: { limit: 100, offset: 0, total: rows.length } });
const body = (calls: { key: string; init?: RequestInit }[], key: string) =>
  JSON.parse(String(calls.find((c) => c.key === key)!.init?.body));

describe('halls page', () => {
  it('lists halls for everyone and offers management only to admins', async () => {
    mockFetch({ ...session(studentUser), 'GET /api/halls': () => json(200, { data: [hall()] }) });
    renderApp('/halls');
    expect(await screen.findByRole('cell', { name: 'Main Hall' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'projector, ac' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add hall' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Main Hall' })).not.toBeInTheDocument();
  });

  it('shows which halls are free, who holds the others, and what does not fit', async () => {
    const { calls } = mockFetch({
      ...session(studentUser),
      'GET /api/halls': () => json(200, { data: [hall()] }),
      'GET /api/bookings/availability?startAt=2031-03-01T10%3A00%3A00%2B05%3A30&endAt=2031-03-01T12%3A00%3A00%2B05%3A30&attendance=300&facilities=stage':
        () =>
          json(200, {
            data: [
              {
                hall: hall(),
                available: false,
                capacityOk: false,
                missingFacilities: ['stage'],
                conflicts: [
                  {
                    bookingId: 'b9',
                    startAt: '2031-03-01T04:30:00Z',
                    endAt: '2031-03-01T06:30:00Z',
                    status: 'confirmed',
                    eventTitle: null,
                  },
                ],
              },
              {
                hall: hall({ id: 'h2', name: 'Seminar Room', capacity: 40 }),
                available: true,
                capacityOk: false,
                missingFacilities: [],
                conflicts: [],
              },
            ],
          }),
    });
    renderApp('/halls');
    const form = await screen.findByRole('form', { name: 'Hall availability search' });
    await userEvent.type(within(form).getByLabelText('From (India time)'), '2031-03-01T10:00');
    await userEvent.type(within(form).getByLabelText('To (India time)'), '2031-03-01T12:00');
    await userEvent.type(within(form).getByLabelText('People expected (optional)'), '300');
    await userEvent.type(within(form).getByLabelText(/Facilities needed/), 'stage');
    await userEvent.click(within(form).getByRole('button', { name: 'Search' }));

    const results = await screen.findByRole('table', { name: 'Availability results' });
    expect(within(results).getByText('Booked')).toBeInTheDocument();
    expect(within(results).getByText(/Reserved:/)).toBeInTheDocument(); // someone else's draft: title hidden
    expect(within(results).getByText('Free')).toBeInTheDocument();
    expect(within(results).getByText(/missing: stage/)).toBeInTheDocument();
    expect(within(results).getAllByText(/smaller than expected/)).toHaveLength(2);
    expect(calls.some((c) => c.key.includes('/availability?'))).toBe(true);
  });

  it('lets an admin add a hall with facilities as tags, and shows server errors', async () => {
    let created = false;
    const { calls } = mockFetch({
      ...session(adminUser),
      'GET /api/halls?includeInactive=true': () =>
        json(200, { data: created ? [hall({ name: 'Lab 1' })] : [] }),
      'POST /api/halls': () => {
        if (!created) {
          created = true;
          return json(409, {
            error: { code: 'HALL_NAME_TAKEN', message: 'A hall with this name already exists' },
          });
        }
        return json(201, { data: hall() });
      },
    });
    renderApp('/halls');
    const form = await screen.findByRole('form', { name: 'Add hall' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Lab 1');
    await userEvent.type(within(form).getByLabelText('Capacity'), '40');
    await userEvent.type(within(form).getByLabelText(/Facilities/), 'projector, ac ,');
    await userEvent.click(within(form).getByRole('button', { name: 'Add hall' }));
    expect(await screen.findByText('A hall with this name already exists')).toBeInTheDocument();
    expect(body(calls, 'POST /api/halls')).toMatchObject({
      name: 'Lab 1',
      capacity: 40,
      facilities: ['projector', 'ac'],
      isActive: true,
    });
  });
});

describe('resources page', () => {
  const projector = {
    id: 'r1',
    name: 'Projector',
    category: 'av',
    quantity: 5,
    description: '',
    status: 'available',
  };

  it('shows free units for a time window', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/resources': () => json(200, { data: [projector] }),
      'GET /api/resources/availability?startAt=2031-03-01T10%3A00%3A00%2B05%3A30&endAt=2031-03-01T12%3A00%3A00%2B05%3A30':
        () =>
          json(200, {
            data: [
              { resource: projector, inUse: 3, available: 2 },
              {
                resource: { ...projector, id: 'r2', name: 'Mixer', status: 'maintenance' },
                inUse: 0,
                available: 0,
              },
            ],
          }),
    });
    renderApp('/resources');
    const form = await screen.findByRole('form', { name: 'Resource availability' });
    await userEvent.type(within(form).getByLabelText('From (India time)'), '2031-03-01T10:00');
    await userEvent.type(within(form).getByLabelText('To (India time)'), '2031-03-01T12:00');
    await userEvent.click(within(form).getByRole('button', { name: 'Check availability' }));
    const table = await screen.findByRole('table', { name: 'Availability results' });
    expect(within(table).getByText('2')).toBeInTheDocument();
    expect(within(table).getByText('maintenance')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add resource' })).not.toBeInTheDocument();
  });

  it('lets an admin add a resource', async () => {
    const { calls } = mockFetch({
      ...session(adminUser),
      'GET /api/resources': () => json(200, { data: [] }),
      'POST /api/resources': () => json(201, { data: projector }),
    });
    renderApp('/resources');
    const form = await screen.findByRole('form', { name: 'Add resource' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Projector');
    await userEvent.type(within(form).getByLabelText('Category'), 'av');
    await userEvent.type(within(form).getByLabelText('Total units'), '5');
    await userEvent.click(within(form).getByRole('button', { name: 'Add resource' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /api/resources')).toBe(true));
    expect(body(calls, 'POST /api/resources')).toEqual({
      name: 'Projector',
      category: 'av',
      quantity: 5,
      description: '',
      status: 'available',
    });
  });
});

describe('bookings list', () => {
  it('shows organizers their bookings and no approval queue', async () => {
    mockFetch({
      ...session(organizerUser),
      'GET /api/bookings?scope=mine&limit=100': page([makeBooking()]),
    });
    renderApp('/bookings');
    expect(await screen.findByRole('link', { name: 'Main Hall' })).toBeInTheDocument();
    expect(screen.getByText('Pending approval: awaiting Faculty')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Approval queue' })).not.toBeInTheDocument();
  });

  it('gives approvers a queue', async () => {
    mockFetch({
      ...session(facultyUser),
      'GET /api/bookings?scope=mine&limit=100': page([]),
      'GET /api/bookings?scope=approvals&limit=100': page([
        makeBooking({ approvalLevel: 'hod_admin' }),
      ]),
    });
    renderApp('/bookings');
    await userEvent.click(await screen.findByRole('tab', { name: 'Approval queue' }));
    expect(await screen.findByText('Pending approval: awaiting HOD or Admin')).toBeInTheDocument();
  });

  it('keeps students out', async () => {
    mockFetch(session(studentUser));
    renderApp('/bookings');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Bookings' })).not.toBeInTheDocument();
  });
});

describe('booking form', () => {
  const eventRoutes = {
    'GET /api/events/e1': () => json(200, { data: makeEvent() }),
    'GET /api/halls': () => json(200, { data: [hall()] }),
  };

  it("starts from the event's own time and sends India-time instants", async () => {
    const { calls } = mockFetch({
      ...session(organizerUser),
      ...eventRoutes,
      'POST /api/bookings': () => json(201, { data: makeBooking() }),
      'GET /api/bookings/b1': () => json(200, { data: makeBooking() }),
    });
    renderApp('/events/e1/book');
    expect(await screen.findByLabelText('From (India time)')).toHaveValue('2031-03-01T10:00');
    expect(screen.getByLabelText('To (India time)')).toHaveValue('2031-03-01T12:00');
    await userEvent.selectOptions(screen.getByLabelText('Hall'), 'h1');
    await userEvent.type(screen.getByLabelText(/Facilities you need/), 'projector, stage');
    await userEvent.click(screen.getByRole('button', { name: 'Request booking' }));
    expect(await screen.findByRole('heading', { name: 'Main Hall' })).toBeInTheDocument();
    expect(body(calls, 'POST /api/bookings')).toMatchObject({
      eventId: 'e1',
      hallId: 'h1',
      startAt: '2031-03-01T10:00:00+05:30',
      endAt: '2031-03-01T12:00:00+05:30',
      requiredFacilities: ['projector', 'stage'],
      acknowledgeWarnings: false,
    });
  });

  it('shows warnings and books only after "Book anyway"', async () => {
    let attempts = 0;
    const { calls } = mockFetch({
      ...session(organizerUser),
      ...eventRoutes,
      'POST /api/bookings': () => {
        attempts++;
        return attempts === 1
          ? json(409, {
              error: {
                code: 'WARNINGS_NEED_ACKNOWLEDGEMENT',
                message: 'review',
                details: {
                  warnings: [
                    {
                      code: 'CAPACITY',
                      message: 'Main Hall seats 50, but 120 people are expected',
                    },
                    { code: 'CALENDAR', message: 'Overlaps "End-semester exams" (2031-03-01)' },
                  ],
                },
              },
            })
          : json(201, { data: makeBooking() });
      },
      'GET /api/bookings/b1': () => json(200, { data: makeBooking() }),
    });
    renderApp('/events/e1/book');
    await userEvent.selectOptions(await screen.findByLabelText('Hall'), 'h1');
    await userEvent.click(screen.getByRole('button', { name: 'Request booking' }));
    const box = await screen.findByRole('alert', { name: 'Warnings' });
    expect(box).toHaveTextContent('seats 50, but 120 people are expected');
    expect(box).toHaveTextContent('End-semester exams');
    expect(box).toHaveTextContent('suggestions only');
    expect(calls.filter((c) => c.key === 'POST /api/bookings')).toHaveLength(1); // nothing booked yet
    await userEvent.click(within(box).getByRole('button', { name: 'Book anyway' }));
    expect(await screen.findByRole('heading', { name: 'Main Hall' })).toBeInTheDocument();
    const sent = calls
      .filter((c) => c.key === 'POST /api/bookings')
      .map((c) => JSON.parse(String(c.init?.body)).acknowledgeWarnings);
    expect(sent).toEqual([false, true]);
  });

  it('explains a taken slot with the conflicting bookings, hiding private titles', async () => {
    mockFetch({
      ...session(organizerUser),
      ...eventRoutes,
      'POST /api/bookings': () =>
        json(409, {
          error: {
            code: 'HALL_UNAVAILABLE',
            message: 'The hall is already booked for part of this time',
            details: {
              conflicts: [
                {
                  bookingId: 'x1',
                  startAt: '2031-03-01T04:30:00Z',
                  endAt: '2031-03-01T06:30:00Z',
                  status: 'pending',
                  eventTitle: 'Robotics Expo',
                },
                {
                  bookingId: 'x2',
                  startAt: '2031-03-01T06:30:00Z',
                  endAt: '2031-03-01T07:30:00Z',
                  status: 'confirmed',
                  eventTitle: null,
                },
              ],
            },
          },
        }),
    });
    renderApp('/events/e1/book');
    await userEvent.selectOptions(await screen.findByLabelText('Hall'), 'h1');
    await userEvent.click(screen.getByRole('button', { name: 'Request booking' }));
    expect(
      await screen.findByText('The hall is already booked for part of this time'),
    ).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Conflicting bookings' });
    expect(within(list).getByText(/Robotics Expo/)).toBeInTheDocument();
    expect(within(list).getByText(/Reserved:/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Book anyway' })).not.toBeInTheDocument(); // a conflict cannot be overridden
  });

  it('shows field errors from the server', async () => {
    mockFetch({
      ...session(organizerUser),
      ...eventRoutes,
      'POST /api/bookings': () =>
        json(400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'bad',
            details: [{ path: 'endAt', message: 'End must be after start' }],
          },
        }),
    });
    renderApp('/events/e1/book');
    await userEvent.selectOptions(await screen.findByLabelText('Hall'), 'h1');
    await userEvent.click(screen.getByRole('button', { name: 'Request booking' }));
    expect(await screen.findByText('End must be after start')).toBeInTheDocument();
    expect(screen.getByText('Please fix the highlighted fields.')).toBeInTheDocument();
  });

  it('edits an existing booking and warns that a new hall or time restarts approval', async () => {
    const { calls } = mockFetch({
      ...session(organizerUser),
      'GET /api/halls': () => json(200, { data: [hall()] }),
      'GET /api/bookings/b1': () =>
        json(200, { data: makeBooking({ requiredFacilities: ['projector'], notes: 'Two mics' }) }),
      'PATCH /api/bookings/b1': () => json(200, { data: makeBooking() }),
    });
    renderApp('/bookings/b1/edit');
    expect(await screen.findByText(/back to the first approval step/)).toBeInTheDocument();
    expect(screen.getByLabelText('Hall')).toHaveValue('h1');
    expect(screen.getByLabelText('Notes for the approvers')).toHaveValue('Two mics');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'PATCH /api/bookings/b1')).toBe(true));
  });
});

describe('booking page', () => {
  const open = (routes: Record<string, () => Promise<Response>>, user: object) => {
    const m = mockFetch({ ...session(user), ...routes });
    renderApp('/bookings/b1');
    return m;
  };

  it('offers the organizer change and cancel, but no approval buttons', async () => {
    open(
      {
        'GET /api/bookings/b1': () =>
          json(200, { data: withBookingActions({ canEdit: true, canCancel: true }) }),
      },
      organizerUser,
    );
    const bar = await screen.findByLabelText('Booking actions');
    expect(within(bar).getByRole('link', { name: 'Change' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Cancel booking' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('lets an approver approve at the step the booking is waiting for', async () => {
    const { calls } = open(
      {
        'GET /api/bookings/b1': () => json(200, { data: withBookingActions({ canApprove: true }) }),
        'POST /api/bookings/b1/approve': () => json(200, { data: {} }),
      },
      facultyUser,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await userEvent.type(screen.getByLabelText('Comment (optional)'), 'Fine');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'POST /api/bookings/b1/approve')).toBe(true),
    );
    expect(body(calls, 'POST /api/bookings/b1/approve')).toEqual({
      level: 'faculty',
      comment: 'Fine',
    });
  });

  it('will not reject without a reason', async () => {
    const { calls } = open(
      {
        'GET /api/bookings/b1': () => json(200, { data: withBookingActions({ canApprove: true }) }),
        'POST /api/bookings/b1/reject': () => json(200, { data: {} }),
      },
      facultyUser,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(
      await screen.findByText('Please explain why you are rejecting this booking.'),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.key.endsWith('/reject'))).toBe(false);
    await userEvent.type(screen.getByLabelText('Reason for rejecting (required)'), 'Exam hall');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(calls.some((c) => c.key.endsWith('/reject'))).toBe(true));
    expect(body(calls, 'POST /api/bookings/b1/reject')).toEqual({
      level: 'faculty',
      comment: 'Exam hall',
    });
  });

  it('shows accepted warnings, a time mismatch, and the history', async () => {
    open(
      {
        'GET /api/bookings/b1': () =>
          json(200, {
            data: makeBooking({
              coversEvent: false,
              warnings: [
                { code: 'CAPACITY', message: 'Main Hall seats 50, but 120 people are expected' },
              ],
              approvals: [
                {
                  id: 'a1',
                  round: 1,
                  level: 'faculty',
                  decision: 'approved',
                  approverName: 'Fay Faculty',
                  comment: 'OK',
                  decidedAt: '2031-01-02T00:00:00Z',
                },
              ],
            }),
          }),
      },
      organizerUser,
    );
    expect(await screen.findByText(/does not cover the whole event time/)).toBeInTheDocument();
    expect(screen.getByText(/Accepted warnings/)).toBeInTheDocument();
    expect(screen.getByText(/seats 50, but 120 people/)).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Fay Faculty' })).toBeInTheDocument();
    expect(screen.getByText('Requested')).toBeInTheDocument();
  });

  it('refreshes when the booking changed under the user (409)', async () => {
    let decided = false;
    open(
      {
        'GET /api/bookings/b1': () =>
          json(200, {
            data: decided
              ? makeBooking({ approvalLevel: 'hod_admin' })
              : withBookingActions({ canApprove: true }),
          }),
        'POST /api/bookings/b1/approve': () => {
          decided = true;
          return json(409, {
            error: {
              code: 'STALE_DECISION',
              message: 'This booking is now waiting for HOD or Admin approval, not Faculty',
            },
          });
        },
      },
      facultyUser,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'now waiting for HOD or Admin approval',
    );
    expect(await screen.findByText('Pending approval: awaiting HOD or Admin')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('says so when the booking is not visible', async () => {
    open(
      {
        'GET /api/bookings/b1': () =>
          json(404, { error: { code: 'NOT_FOUND', message: 'Booking not found' } }),
      },
      organizerUser,
    );
    expect(
      await screen.findByText('This booking does not exist or you cannot view it.'),
    ).toBeInTheDocument();
  });
});

describe('bookings and equipment on the event page', () => {
  const owned = (over: Record<string, unknown> = {}) =>
    withActions({ canEdit: true }, { status: 'approved', ...over });
  const open = (
    event: object,
    routes: Record<string, () => Promise<Response>>,
    user: object = organizerUser,
  ) => {
    const m = mockFetch({
      ...session(user),
      'GET /api/events/e1': () => json(200, { data: event }),
      ...routes,
    });
    renderApp('/events/e1');
    return m;
  };

  it('lists the hall bookings and offers "Book a hall" to the organizer of a live event', async () => {
    open(owned(), {
      'GET /api/bookings?scope=event&eventId=e1&limit=100': page([
        makeBooking({ status: 'confirmed', approvalLevel: null }),
      ]),
    });
    const table = await screen.findByRole('table', { name: 'Hall bookings' });
    expect(within(table).getByRole('link', { name: 'Main Hall' })).toBeInTheDocument();
    expect(within(table).getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Book a hall' })).toHaveAttribute(
      'href',
      '/events/e1/book',
    );
  });

  it("does not offer booking for events that are cancelled, started, or not the user's", async () => {
    open(owned({ status: 'cancelled' }), {});
    await screen.findByRole('heading', { name: 'Hall bookings' });
    expect(screen.queryByRole('link', { name: 'Book a hall' })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
    open(owned({ startAt: '2020-01-01T04:30:00.000Z', endAt: '2020-01-01T06:30:00.000Z' }), {});
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Hall bookings' }).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole('link', { name: 'Book a hall' })).not.toBeInTheDocument();
  });

  it('hides bookings and equipment from people who cannot see the workflow', async () => {
    open(makeEvent({ status: 'published', workflow: null }), {}, studentUser);
    await screen.findByRole('heading', { name: 'Tech Symposium' });
    expect(screen.queryByRole('heading', { name: 'Hall bookings' })).not.toBeInTheDocument();
  });

  it('lets the organizer reserve equipment for an approved event and shows when there is not enough', async () => {
    let tries = 0;
    const projector = {
      id: 'r1',
      name: 'Projector',
      category: 'av',
      quantity: 5,
      description: '',
      status: 'available',
    };
    const { calls } = open(owned(), {
      'GET /api/resources/availability?startAt=2031-03-01T04%3A30%3A00.000Z&endAt=2031-03-01T06%3A30%3A00.000Z':
        () => json(200, { data: [{ resource: projector, inUse: 3, available: 2 }] }),
      'POST /api/resource-reservations': () => {
        tries++;
        return tries === 1
          ? json(409, {
              error: {
                code: 'RESOURCE_EXHAUSTED',
                message: 'Only 2 of 5 Projector are free for that time',
              },
            })
          : json(201, { data: {} });
      },
    });
    const form = await screen.findByRole('form', { name: 'Reserve equipment' });
    expect(
      await within(form).findByRole('option', { name: 'Projector (2 free)' }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(within(form).getByLabelText('Resource'), 'r1');
    await userEvent.clear(within(form).getByLabelText('Units'));
    await userEvent.type(within(form).getByLabelText('Units'), '4');
    await userEvent.click(within(form).getByRole('button', { name: 'Reserve' }));
    expect(
      await within(form).findByText('Only 2 of 5 Projector are free for that time'),
    ).toBeInTheDocument();
    await userEvent.clear(within(form).getByLabelText('Units'));
    await userEvent.type(within(form).getByLabelText('Units'), '2');
    await userEvent.click(within(form).getByRole('button', { name: 'Reserve' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.key === 'POST /api/resource-reservations')).toHaveLength(2),
    );
    expect(body(calls, 'POST /api/resource-reservations')).toEqual({
      eventId: 'e1',
      resourceId: 'r1',
      quantity: 4,
    });
  });

  it('explains that equipment needs a fully approved event, and offers no form', async () => {
    open(withActions({ canEdit: true }, { status: 'draft' }), {});
    expect(await screen.findByText(/once the event is fully approved/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Reserve equipment' })).not.toBeInTheDocument();
  });

  it('lists reservations and lets the organizer release one', async () => {
    const reservation = {
      id: 'v1',
      resourceId: 'r1',
      resourceName: 'Projector',
      eventId: 'e1',
      quantity: 2,
      startAt: '2031-03-01T04:30:00.000Z',
      endAt: '2031-03-01T06:30:00.000Z',
      notes: '',
      status: 'confirmed',
      releaseReason: null,
    };
    const { calls } = open(owned(), {
      'GET /api/resource-reservations?eventId=e1': () => json(200, { data: [reservation] }),
      'POST /api/resource-reservations/v1/release': () => json(200, { data: {} }),
    });
    const table = await screen.findByRole('table', { name: 'Resource reservations' });
    expect(within(table).getByText('Reserved')).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: 'Release Projector' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'POST /api/resource-reservations/v1/release')).toBe(true),
    );
  });
});
