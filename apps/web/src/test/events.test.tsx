import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import { formatDateTime, isoToLocalInput, localInputToIso } from '../lib/datetime';
import {
  adminUser,
  facultyUser,
  json,
  makeEvent,
  mockFetch,
  organizerUser,
  renderApp,
  session,
  studentUser,
  withActions,
} from './utils';

beforeEach(() => setAccessToken(null));
afterEach(() => vi.unstubAllGlobals());

const list = (events: object[]) => () =>
  json(200, { data: events, page: { limit: 100, offset: 0, total: events.length } });

describe('India-time helpers', () => {
  it('turns form input into an ISO instant with an explicit +05:30 offset', () => {
    expect(localInputToIso('2031-03-01T10:00')).toBe('2031-03-01T10:00:00+05:30');
    expect(new Date(localInputToIso('2031-03-01T10:00')).toISOString()).toBe(
      '2031-03-01T04:30:00.000Z',
    );
  });
  it('shows stored instants in India time, round-tripping through the form format', () => {
    expect(isoToLocalInput('2031-03-01T04:30:00.000Z')).toBe('2031-03-01T10:00');
    expect(isoToLocalInput('2031-03-01T18:45:00.000Z')).toBe('2031-03-02T00:15'); // crosses midnight in IST
    expect(formatDateTime('2031-03-01T04:30:00.000Z')).toMatch(/10:00/);
  });
});

describe('events list', () => {
  it('shows students only upcoming events and no creation button', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/events?scope=published&limit=100': list([makeEvent({ status: 'published' })]),
    });
    renderApp('/events');
    expect(await screen.findByRole('link', { name: 'Tech Symposium' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Upcoming events' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Approval queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'My events' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New event' })).not.toBeInTheDocument();
  });

  it('gives student heads their own events and a New event button', async () => {
    mockFetch({
      ...session(organizerUser),
      'GET /api/events?scope=published&limit=100': list([]),
      'GET /api/events?scope=mine&limit=100': list([makeEvent({ title: 'My draft' })]),
    });
    renderApp('/events');
    expect(await screen.findByRole('link', { name: 'New event' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'My events' }));
    expect(await screen.findByRole('link', { name: 'My draft' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Approval queue' })).not.toBeInTheDocument();
  });

  it('shows approvers a queue with the level each event waits at', async () => {
    mockFetch({
      ...session(facultyUser),
      'GET /api/events?scope=approvals&limit=100': list([
        makeEvent({ status: 'pending_approval', approvalLevel: 'faculty' }),
      ]),
    });
    renderApp('/approvals');
    expect(await screen.findByText('Pending approval: awaiting Faculty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Approvals' })).toBeInTheDocument();
  });

  it('says so when the queue is empty and when loading fails', async () => {
    mockFetch({ ...session(facultyUser), 'GET /api/events?scope=approvals&limit=100': list([]) });
    renderApp('/approvals');
    expect(await screen.findByText('Nothing is waiting for your decision.')).toBeInTheDocument();
    vi.unstubAllGlobals();
    mockFetch({
      ...session(studentUser),
      'GET /api/events?scope=published&limit=100': () =>
        json(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } }),
    });
    renderApp('/events');
    expect(await screen.findByText('Could not load events.')).toBeInTheDocument();
  });

  it('keeps students away from the creation and approval pages', async () => {
    mockFetch(session(studentUser));
    renderApp('/events/new');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
    renderApp('/approvals');
    expect(
      (await screen.findAllByText('You do not have access to this page.')).length,
    ).toBeGreaterThan(0);
  });
});

describe('event form', () => {
  const fill = async () => {
    await userEvent.type(await screen.findByLabelText('Title'), 'Hack Night');
    await userEvent.type(screen.getByLabelText('Category'), 'technical');
    await userEvent.type(screen.getByLabelText('Starts (India time)'), '2031-03-01T10:00');
    await userEvent.type(screen.getByLabelText('Ends (India time)'), '2031-03-01T12:00');
    await userEvent.type(screen.getByLabelText('Expected attendance'), '80');
  };

  it('sends India-time instants and numbers, then opens the new event', async () => {
    const { calls } = mockFetch({
      ...session(organizerUser),
      'POST /api/events': () => json(201, { data: makeEvent({ id: 'new1', title: 'Hack Night' }) }),
      'GET /api/events/new1': () =>
        json(200, { data: makeEvent({ id: 'new1', title: 'Hack Night' }) }),
    });
    renderApp('/events/new');
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('heading', { name: 'Hack Night' })).toBeInTheDocument();
    const body = JSON.parse(String(calls.find((c) => c.key === 'POST /api/events')!.init?.body));
    expect(body).toMatchObject({
      title: 'Hack Night',
      category: 'technical',
      startAt: '2031-03-01T10:00:00+05:30',
      endAt: '2031-03-01T12:00:00+05:30',
      expectedAttendance: 80,
      capacity: null,
      registrationMode: 'individual',
      teamSizeMin: null,
      teamSizeMax: null,
      registrationDeadline: null,
      speakers: [],
    });
    expect(body).not.toHaveProperty('departmentId'); // non-admins always use their own department
  });

  it('shows server validation messages next to the fields', async () => {
    mockFetch({
      ...session(organizerUser),
      'POST /api/events': () =>
        json(400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'bad',
            details: [
              { path: 'endAt', message: 'End must be after start' },
              { path: 'title', message: 'Too short' },
            ],
          },
        }),
    });
    renderApp('/events/new');
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText('End must be after start')).toBeInTheDocument();
    expect(screen.getByText('Too short')).toBeInTheDocument();
    expect(screen.getByText('Please fix the highlighted fields.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New event' })).toBeInTheDocument(); // stays on the form
  });

  it('shows team size fields only for team events, and lets admins pick a department', async () => {
    mockFetch({
      ...session(adminUser),
      'GET /api/departments': () => json(200, { data: [{ id: 'd1', name: 'Computer Science' }] }),
    });
    renderApp('/events/new');
    expect(await screen.findByRole('option', { name: 'Computer Science' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Minimum team size')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Registration'), 'team');
    expect(screen.getByLabelText('Minimum team size')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximum team size')).toBeInTheDocument();
  });

  it('loads an approved event for editing with the approval-sensitive fields locked', async () => {
    mockFetch({
      ...session(organizerUser),
      'GET /api/events/e1': () =>
        json(200, { data: withActions({ canEdit: true }, { status: 'approved', capacity: 50 }) }),
    });
    renderApp('/events/e1/edit');
    const title = await screen.findByLabelText('Title');
    expect(title).toHaveValue('Tech Symposium');
    expect(title).toBeEnabled();
    expect(screen.getByLabelText('Starts (India time)')).toHaveValue('2031-03-01T10:00');
    expect(screen.getByLabelText('Starts (India time)')).toBeDisabled();
    expect(screen.getByLabelText('Registration capacity (optional)')).toBeDisabled();
    expect(screen.getByText(/use “Revise”/)).toBeInTheDocument();
  });
});

describe('event page', () => {
  const open = (events: Record<string, () => Promise<Response>>, user: object) => {
    const m = mockFetch({ ...session(user), ...events });
    renderApp('/events/e1');
    return m;
  };

  it('offers the organizer of a draft submit, edit and cancel, but no approval buttons', async () => {
    open(
      {
        'GET /api/events/e1': () =>
          json(200, { data: withActions({ canEdit: true, canSubmit: true, canCancel: true }) }),
      },
      organizerUser,
    );
    const bar = await screen.findByLabelText('Event actions');
    expect(within(bar).getByRole('button', { name: 'Submit for approval' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Cancel event' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('submits and then shows the new state', async () => {
    let status = 'draft';
    const { calls } = open(
      {
        'GET /api/events/e1': () =>
          json(200, {
            data: withActions(status === 'draft' ? { canSubmit: true } : { canWithdraw: true }, {
              status,
              approvalLevel: status === 'draft' ? null : 'faculty',
            }),
          }),
        'POST /api/events/e1/submit': () => {
          status = 'pending_approval';
          return json(200, { data: {} });
        },
      },
      organizerUser,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for approval' }));
    expect(await screen.findByText('Pending approval: awaiting Faculty')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'POST /api/events/e1/submit')).toBe(true);
  });

  it('lets the approver approve at the level the event is waiting for', async () => {
    const { calls } = open(
      {
        'GET /api/events/e1': () =>
          json(200, {
            data: withActions(
              { canApprove: true },
              { status: 'pending_approval', approvalLevel: 'faculty', organizerId: '9' },
            ),
          }),
        'POST /api/events/e1/approve': () => json(200, { data: {} }),
      },
      facultyUser,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await userEvent.type(screen.getByLabelText('Comment (optional)'), 'Good plan');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'POST /api/events/e1/approve')).toBe(true),
    );
    expect(
      JSON.parse(String(calls.find((c) => c.key === 'POST /api/events/e1/approve')!.init?.body)),
    ).toEqual({ level: 'faculty', comment: 'Good plan' });
  });

  it('will not reject without a reason, and sends it once given', async () => {
    const { calls } = open(
      {
        'GET /api/events/e1': () =>
          json(200, {
            data: withActions(
              { canApprove: true },
              { status: 'pending_approval', approvalLevel: 'faculty' },
            ),
          }),
        'POST /api/events/e1/reject': () => json(200, { data: {} }),
      },
      facultyUser,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(
      await screen.findByText('Please explain why you are rejecting this event.'),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.key === 'POST /api/events/e1/reject')).toBe(false);

    await userEvent.type(
      screen.getByLabelText('Reason for rejecting (required)'),
      'Clashes with labs',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'POST /api/events/e1/reject')).toBe(true),
    );
    expect(
      JSON.parse(String(calls.find((c) => c.key === 'POST /api/events/e1/reject')!.init?.body)),
    ).toEqual({ level: 'faculty', comment: 'Clashes with labs' });
  });

  it('requires a reason to cancel', async () => {
    const { calls } = open(
      {
        'GET /api/events/e1': () =>
          json(200, { data: withActions({ canCancel: true }, { status: 'approved' }) }),
        'POST /api/events/e1/cancel': () => json(200, { data: {} }),
      },
      organizerUser,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel event' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(await screen.findByText('Please give a reason for cancelling.')).toBeInTheDocument();
    expect(calls.some((c) => c.key.endsWith('/cancel'))).toBe(false);
  });

  it('explains a revision before doing it', async () => {
    open(
      {
        'GET /api/events/e1': () =>
          json(200, { data: withActions({ canRevise: true }, { status: 'published' }) }),
      },
      organizerUser,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Revise' }));
    expect(screen.getByText(/unpublishes it/)).toBeInTheDocument();
    expect(screen.getByText(/approved again/)).toBeInTheDocument();
  });

  it('lists the restricted dates when submission is refused by the calendar', async () => {
    open(
      {
        'GET /api/events/e1': () => json(200, { data: withActions({ canSubmit: true }) }),
        'POST /api/events/e1/submit': () =>
          json(422, {
            error: {
              code: 'CALENDAR_BLOCKED',
              message: 'The event dates fall on restricted academic dates',
              details: {
                entries: [
                  { title: 'End-semester exams', startDate: '2031-03-01', endDate: '2031-03-10' },
                ],
              },
            },
          }),
      },
      organizerUser,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for approval' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('restricted academic dates');
    expect(alert).toHaveTextContent('End-semester exams');
  });

  it('warns about blocked and soft calendar conflicts before submission', async () => {
    const blocks = [
      {
        id: 'c1',
        title: 'Exams',
        startDate: '2031-03-01',
        endDate: '2031-03-05',
        type: 'exam_period',
        severity: 'block',
        departmentId: null,
        isActive: true,
      },
    ];
    const warnings = [
      {
        id: 'c2',
        title: 'Annual Fest',
        startDate: '2031-03-01',
        endDate: '2031-03-01',
        type: 'major_fest',
        severity: 'warn',
        departmentId: null,
        isActive: true,
      },
    ];
    open(
      {
        'GET /api/events/e1': () =>
          json(200, { data: withActions({ canSubmit: true }, { calendar: { blocks, warnings } }) }),
      },
      organizerUser,
    );
    expect(
      await screen.findByText(/cannot be submitted until the dates change/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Approvers will see this/)).toBeInTheDocument();
  });

  it('shows why a draft came back, and the approval history to people allowed to see it', async () => {
    open(
      {
        'GET /api/events/e1': () =>
          json(200, {
            data: withActions(
              { canEdit: true, canSubmit: true },
              {
                lastRejection: {
                  level: 'hod',
                  comment: 'Please shorten it',
                  by: '5',
                  at: '2031-01-01T00:00:00Z',
                },
                workflow: {
                  approvals: [
                    {
                      id: 'a1',
                      round: 1,
                      level: 'hod',
                      decision: 'rejected',
                      approverName: 'Hal HOD',
                      comment: 'Please shorten it',
                      decidedAt: '2031-01-01T00:00:00Z',
                    },
                  ],
                  history: [
                    {
                      id: 1,
                      action: 'create',
                      actorName: 'Olive Organizer',
                      fromStatus: null,
                      toStatus: 'draft',
                      level: null,
                      comment: null,
                      createdAt: '2030-12-01T00:00:00Z',
                    },
                  ],
                },
              },
            ),
          }),
      },
      organizerUser,
    );
    expect(await screen.findByText(/Rejected at the HOD level/)).toHaveTextContent(
      'Please shorten it',
    );
    expect(screen.getByRole('cell', { name: 'Hal HOD' })).toBeInTheDocument();
    expect(screen.getByText('Created')).toBeInTheDocument();
  });

  it('shows the public view without workflow details or action buttons', async () => {
    open(
      {
        'GET /api/events/e1': () =>
          json(200, {
            data: makeEvent({
              status: 'published',
              workflow: null,
              calendar: null,
              registrationEligible: true,
            }),
          }),
      },
      studentUser,
    );
    expect(await screen.findByRole('heading', { name: 'Tech Symposium' })).toBeInTheDocument();
    expect(screen.getByText(/\(open\)/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Approvals' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeInTheDocument(); // only "Sign out"
    expect(within(screen.getByLabelText('Event actions')).queryAllByRole('button')).toHaveLength(0);
  });

  it('refreshes and explains when the event changed under the user (409)', async () => {
    let approvals = 0;
    open(
      {
        'GET /api/events/e1': () =>
          json(200, {
            data: withActions(
              { canApprove: approvals === 0 },
              { status: 'pending_approval', approvalLevel: approvals === 0 ? 'faculty' : 'hod' },
            ),
          }),
        'POST /api/events/e1/approve': () => {
          approvals++;
          return json(409, {
            error: {
              code: 'STALE_DECISION',
              message: 'This event is now waiting for hod approval, not faculty',
            },
          });
        },
      },
      facultyUser,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('now waiting for hod approval');
    expect(await screen.findByText('Pending approval: awaiting HOD')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('says so when the event does not exist or is not visible', async () => {
    open(
      {
        'GET /api/events/e1': () =>
          json(404, { error: { code: 'NOT_FOUND', message: 'Event not found' } }),
      },
      studentUser,
    );
    expect(
      await screen.findByText('This event does not exist or you cannot view it.'),
    ).toBeInTheDocument();
  });
});

describe('academic calendar page', () => {
  const entries = [
    {
      id: 'c1',
      type: 'exam_period',
      title: 'End-semester exams',
      startDate: '2031-03-01',
      endDate: '2031-03-10',
      severity: 'block',
      departmentId: null,
      isActive: true,
    },
  ];

  it('is read-only for non-admins', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/calendar/entries': () => json(200, { data: entries }),
      'GET /api/departments': () => json(200, { data: [] }),
    });
    renderApp('/calendar');
    expect(await screen.findByText('End-semester exams')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add calendar entry' })).not.toBeInTheDocument();
  });

  it('lets an admin add an entry and tells them which existing events overlap it', async () => {
    const { calls } = mockFetch({
      ...session(adminUser),
      'GET /api/calendar/entries?includeInactive=true': () => json(200, { data: entries }),
      'GET /api/departments': () => json(200, { data: [] }),
      'POST /api/calendar/entries': () =>
        json(201, { data: entries[0], conflicts: [{ id: 'e9', title: 'Robotics Expo' }] }),
    });
    renderApp('/calendar');
    const form = await screen.findByRole('form', { name: 'Add calendar entry' });
    await userEvent.type(within(form).getByLabelText('Title'), 'Diwali holiday');
    await userEvent.selectOptions(within(form).getByLabelText('Type'), 'holiday');
    await userEvent.type(within(form).getByLabelText('From'), '2031-11-01');
    await userEvent.click(within(form).getByRole('button', { name: 'Add entry' }));
    expect(await screen.findByText(/Robotics Expo/)).toBeInTheDocument();
    const body = JSON.parse(
      String(calls.find((c) => c.key === 'POST /api/calendar/entries')!.init?.body),
    );
    expect(body).toEqual({
      type: 'holiday',
      title: 'Diwali holiday',
      startDate: '2031-11-01',
      endDate: '2031-11-01',
      departmentId: null,
    });
  });

  it('shows validation errors from the server', async () => {
    mockFetch({
      ...session(adminUser),
      'GET /api/calendar/entries?includeInactive=true': () => json(200, { data: [] }),
      'GET /api/departments': () => json(200, { data: [] }),
      'POST /api/calendar/entries': () =>
        json(400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'bad',
            details: [{ path: 'endDate', message: 'End date must not be before start date' }],
          },
        }),
    });
    renderApp('/calendar');
    const form = await screen.findByRole('form', { name: 'Add calendar entry' });
    await userEvent.type(within(form).getByLabelText('Title'), 'Exams');
    await userEvent.type(within(form).getByLabelText('From'), '2031-03-10');
    await userEvent.click(within(form).getByRole('button', { name: 'Add entry' }));
    expect(await screen.findByText('End date must not be before start date')).toBeInTheDocument();
  });
});
