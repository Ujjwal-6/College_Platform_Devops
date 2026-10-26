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

/** Replaces fetch with a handler keyed on "METHOD /path". Unmatched calls fail the test loudly. */
export function mockFetch(routes: Record<string, () => Promise<Response>>) {
  const calls: { key: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push({ key, init });
    const handler = routes[key];
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
