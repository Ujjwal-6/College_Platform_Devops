import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import { adminUser, json, mockFetch, renderApp, studentUser } from './utils';

beforeEach(() => {
  setAccessToken(null);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const noSession = {
  'POST /api/auth/refresh': () =>
    json(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'Session expired' } }),
};

describe('route protection', () => {
  it('sends signed-out visitors to the login page', async () => {
    mockFetch(noSession);
    renderApp('/users');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('restores a session from the refresh cookie on page load', async () => {
    mockFetch({
      'POST /api/auth/refresh': () => json(200, { accessToken: 'tok', user: studentUser }),
    });
    renderApp('/');
    expect(await screen.findByText(/Welcome, Sam Student/)).toBeInTheDocument();
  });
});

describe('role-aware UI', () => {
  it('shows the Users link and page to admins', async () => {
    mockFetch({
      'POST /api/auth/refresh': () => json(200, { accessToken: 'tok', user: adminUser }),
      'GET /api/users?limit=100': () =>
        json(200, {
          data: [{ ...adminUser, isActive: true, createdAt: '2026-01-01' }],
          page: { total: 1 },
        }),
      'GET /api/departments': () => json(200, { data: [] }),
    });
    renderApp('/users');
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Users' })).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'Create user' })).toBeInTheDocument();
  });

  it('hides the Users link and blocks the page for students', async () => {
    mockFetch({
      'POST /api/auth/refresh': () => json(200, { accessToken: 'tok', user: studentUser }),
    });
    renderApp('/users');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });
});

describe('login', () => {
  it('signs in, shows the dashboard, and keeps the token out of browser storage', async () => {
    const { calls } = mockFetch({
      ...noSession,
      'POST /api/auth/login': () =>
        json(200, { accessToken: 'super-secret-access-token', user: studentUser }),
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 's@college.test');
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-enough-passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Welcome, Sam Student/)).toBeInTheDocument();
    const login = calls.find((c) => c.key === 'POST /api/auth/login')!;
    expect(JSON.parse(String(login.init?.body))).toEqual({
      email: 's@college.test',
      password: 'a-long-enough-passphrase',
    });
    expect(login.init?.credentials).toBe('include');
    expect(JSON.stringify({ ...localStorage })).not.toContain('super-secret');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('super-secret');
  });

  it('shows a generic error for wrong credentials and stays on the page', async () => {
    mockFetch({
      ...noSession,
      'POST /api/auth/login': () =>
        json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }),
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 's@college.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('tells the user when they are rate limited', async () => {
    mockFetch({
      ...noSession,
      'POST /api/auth/login': () =>
        json(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }),
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 's@college.test');
    await userEvent.type(screen.getByLabelText('Password'), 'whatever-pass-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
  });
});

describe('sign out', () => {
  it('returns to the login page', async () => {
    mockFetch({
      'POST /api/auth/refresh': () => json(200, { accessToken: 'tok', user: studentUser }),
      'POST /api/auth/logout': () => Promise.resolve(new Response(null, { status: 204 })),
    });
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument(),
    );
  });
});
