import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';

export const adminUser = {
  id: '1',
  email: 'admin@college.test',
  name: 'Ada Admin',
  roles: ['admin'],
  departmentId: null,
};
export const studentUser = {
  id: '2',
  email: 's@college.test',
  name: 'Sam Student',
  roles: ['student'],
  departmentId: null,
};

export const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );

export type Handler = (url: string, init?: RequestInit) => Promise<Response>;

/** Calls the event page makes on its own (bookings, reservations, resource availability): empty unless a test says otherwise. */
function defaultHandler(key: string): (() => Promise<Response>) | undefined {
  if (key === 'GET /api/events?scope=published&limit=5')
    return () => json(200, { data: [], page: { limit: 5, offset: 0, total: 0 } });
  if (key === 'GET /api/events?scope=approvals&limit=1')
    return () => json(200, { data: [], page: { limit: 1, offset: 0, total: 0 } });
  if (key.startsWith('GET /api/bookings?scope=event'))
    return () => json(200, { data: [], page: { limit: 100, offset: 0, total: 0 } });
  if (key.startsWith('GET /api/resource-reservations?')) return () => json(200, { data: [] });
  if (key.startsWith('GET /api/resources/availability?')) return () => json(200, { data: [] });
  if (/^GET \/api\/events\/[^/?]+\/registration-summary$/.test(key))
    return () =>
      json(200, {
        data: {
          eventId: 'e',
          registrationMode: 'individual',
          capacity: null,
          registered: 0,
          seatsLeft: null,
          open: false,
          full: false,
          mine: null,
        },
      });
  if (/^GET \/api\/events\/[^/?]+\/feedback\/mine$/.test(key))
    return () =>
      json(200, {
        data: {
          eligible: false,
          submitted: false,
          open: false,
          opensAt: '2020-01-01T00:00:00.000Z',
          closesAt: '2020-01-15T00:00:00.000Z',
        },
      });
  if (/^GET \/api\/events\/[^/?]+\/feedback$/.test(key))
    return () =>
      json(200, {
        data: { summary: { count: 0, average: null, distribution: [0, 0, 0, 0, 0] }, comments: [] },
      });
  if (/^GET \/api\/events\/[^/?]+\/report$/.test(key))
    return () =>
      json(200, {
        data: {
          inputs: { outcomes: null },
          photos: [],
          reports: [],
          limits: { photoMaxBytes: 2_000_000, photoMaxCount: 20 },
          can: { edit: false, generate: false },
        },
      });
  if (/^GET \/api\/events\/[^/?]+\/budget$/.test(key))
    return () =>
      json(200, {
        data: {
          currency: 'INR',
          items: [],
          totals: {
            estimateMinor: 0,
            actualMinor: 0,
            differenceMinor: 0,
            overBudget: false,
            byCategory: [],
          },
          can: { edit: false },
          limits: { maxItems: 200, maxAmountMinor: 100_000_000_000 },
        },
      });
  if (/^GET \/api\/events\/[^/?]+\/analytics$/.test(key))
    return () =>
      json(200, {
        data: {
          registrations: { registered: 0, perDay: [] },
          attendance: { checkedIn: 0, ratePercent: null, noShows: null, completed: 0 },
          feedback: { count: 0, average: null, distribution: [0, 0, 0, 0, 0] },
          certificates: { issued: 0 },
          budget: null,
        },
      });
  if (/^GET \/api\/events\/[^/?]+\/certificates$/.test(key))
    return () =>
      json(200, { summary: { eligible: 0, issued: 0, ready: 0, canIssue: true }, data: [] });
  if (/^GET \/api\/registrations\/[^/?]+\/qr$/.test(key))
    return () =>
      json(200, {
        data: {
          token: 'EQ1.payload.signature',
          expiresAt: '2031-03-01T06:30:00.000Z',
          qrImage: 'data:image/png;base64,AAAA',
          gatePassReady: true,
          checkedInAt: null,
        },
      });
  if (key.includes('/registrations?status=registered'))
    return () => json(200, { data: [], page: { total: 0, limit: 100, offset: 0 } });
  return undefined;
}

/** Replaces fetch with a handler keyed on "METHOD /path". Unmatched calls fail the test loudly. */
export function mockFetch(routes: Record<string, () => Promise<Response>>) {
  const calls: { key: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push({ key, init });
    const handler = routes[key] ?? defaultHandler(key);
    if (!handler) throw new Error(`Unexpected request: ${key}`);
    return handler();
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

export function renderApp(path = '/', children?: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>{children ?? <App />}</AuthProvider>
    </MemoryRouter>,
  );
}

export const organizerUser = {
  id: '3',
  email: 'o@college.test',
  name: 'Olive Organizer',
  roles: ['organizer'],
  departmentId: 'd1',
};
export const facultyUser = {
  id: '4',
  email: 'f@college.test',
  name: 'Fay Faculty',
  roles: ['faculty'],
  departmentId: 'd1',
};

export const session = (user: object) => ({
  'POST /api/auth/refresh': () => json(200, { accessToken: 'tok', user }),
});

export function makeEvent(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    title: 'Tech Symposium',
    description: 'Talks and demos',
    category: 'technical',
    departmentId: 'd1',
    organizerId: '3',
    organizerName: 'Olive Organizer',
    status: 'draft',
    approvalLevel: null,
    submissionRound: 0,
    startAt: '2031-03-01T04:30:00.000Z',
    endAt: '2031-03-01T06:30:00.000Z',
    expectedAttendance: 120,
    capacity: null,
    registrationMode: 'individual',
    teamSizeMin: null,
    teamSizeMax: null,
    registrationDeadline: null,
    lastRejection: null,
    cancelReason: null,
    registrationEligible: false,
    calendarWarnings: [],
    speakers: [],
    calendar: { blocks: [], warnings: [] },
    workflow: { approvals: [], history: [] },
    materialFields: [
      'startAt',
      'endAt',
      'capacity',
      'category',
      'expectedAttendance',
      'departmentId',
      'registrationMode',
      'teamSizeMin',
      'teamSizeMax',
    ],
    actions: {
      canEdit: false,
      canSubmit: false,
      canWithdraw: false,
      canRevise: false,
      canPublish: false,
      canUnpublish: false,
      canCancel: false,
      canClose: false,
      canApprove: false,
    },
    ...over,
  };
}
export const withActions = (
  actions: Record<string, boolean>,
  over: Record<string, unknown> = {},
) => {
  const base = makeEvent();
  return makeEvent({ actions: { ...base.actions, ...actions }, ...over });
};

export function makeBooking(over: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    eventId: 'e1',
    hallId: 'h1',
    hallName: 'Main Hall',
    eventTitle: 'Tech Symposium',
    startAt: '2031-03-01T04:30:00.000Z',
    endAt: '2031-03-01T06:30:00.000Z',
    status: 'pending',
    approvalLevel: 'faculty',
    requiredFacilities: [],
    notes: '',
    warnings: [],
    requestedByName: 'Olive Organizer',
    closingComment: null,
    coversEvent: true,
    hall: {
      id: 'h1',
      name: 'Main Hall',
      location: 'Block A',
      capacity: 200,
      facilities: ['projector'],
      isActive: true,
    },
    event: {
      id: 'e1',
      title: 'Tech Symposium',
      status: 'draft',
      startAt: '2031-03-01T04:30:00.000Z',
      endAt: '2031-03-01T06:30:00.000Z',
      expectedAttendance: 120,
    },
    approvals: [],
    history: [
      {
        id: 1,
        action: 'request',
        actorName: 'Olive Organizer',
        level: 'faculty',
        comment: null,
        createdAt: '2031-01-01T00:00:00Z',
      },
    ],
    actions: { canEdit: false, canCancel: false, canApprove: false },
    ...over,
  };
}
export const withBookingActions = (
  actions: Record<string, boolean>,
  over: Record<string, unknown> = {},
) =>
  makeBooking({
    actions: { canEdit: false, canCancel: false, canApprove: false, ...actions },
    ...over,
  });

export const hall = (over: Record<string, unknown> = {}) => ({
  id: 'h1',
  name: 'Main Hall',
  location: 'Block A',
  capacity: 200,
  facilities: ['projector', 'ac'],
  description: '',
  isActive: true,
  ...over,
});
