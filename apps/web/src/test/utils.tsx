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
