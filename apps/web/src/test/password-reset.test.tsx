import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import { json, mockFetch, renderApp } from './utils';

beforeEach(() => {
  setAccessToken(null);
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const noSession = {
  'POST /api/auth/refresh': () =>
    json(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'Session expired' } }),
};
const body = (calls: { key: string; init?: RequestInit }[], key: string) =>
  JSON.parse(String(calls.find((c) => c.key === key)!.init?.body));

describe('asking for a link', () => {
  it('is reachable from the sign-in page', async () => {
    mockFetch(noSession);
    renderApp('/login');
    await userEvent.click(await screen.findByRole('link', { name: 'Forgot your password?' }));
    expect(
      await screen.findByRole('heading', { name: 'Forgot your password?' }),
    ).toBeInTheDocument();
  });

  it('sends the address and says the same thing whatever the answer was', async () => {
    const { calls } = mockFetch({
      ...noSession,
      'POST /api/auth/forgot-password': () =>
        json(202, { message: 'If that address has an account, a reset link has been sent.' }),
    });
    renderApp('/forgot-password');
    await userEvent.type(await screen.findByLabelText('Email'), 'sam@college.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('If that address has an account');
    expect(body(calls, 'POST /api/auth/forgot-password')).toEqual({ email: 'sam@college.test' });
  });

  it('says when it is rate limited', async () => {
    mockFetch({
      ...noSession,
      'POST /api/auth/forgot-password': () =>
        json(429, { error: { code: 'RATE_LIMITED', message: 'Too many' } }),
    });
    renderApp('/forgot-password');
    await userEvent.type(await screen.findByLabelText('Email'), 'sam@college.test');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
  });
});

describe('choosing a new password', () => {
  it('sends the token from the link with the new password, then offers sign-in', async () => {
    const { calls } = mockFetch({
      ...noSession,
      'POST /api/auth/reset-password': () => Promise.resolve(new Response(null, { status: 204 })),
    });
    renderApp('/reset-password?token=abc_DEF-123');
    await userEvent.type(
      await screen.findByLabelText('New password'),
      'a-brand-new-long-passphrase',
    );
    await userEvent.type(
      screen.getByLabelText('New password again'),
      'a-brand-new-long-passphrase',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(body(calls, 'POST /api/auth/reset-password')).toEqual({
      token: 'abc_DEF-123',
      newPassword: 'a-brand-new-long-passphrase',
    });
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('does not send anything when the two passwords differ', async () => {
    const { calls } = mockFetch(noSession);
    renderApp('/reset-password?token=abc');
    await userEvent.type(await screen.findByLabelText('New password'), 'one-long-passphrase-aaa');
    await userEvent.type(screen.getByLabelText('New password again'), 'another-long-passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not the same');
    expect(calls.some((c) => c.key === 'POST /api/auth/reset-password')).toBe(false);
  });

  it('explains an invalid or used link and offers a new one', async () => {
    mockFetch({
      ...noSession,
      'POST /api/auth/reset-password': () =>
        json(400, { error: { code: 'INVALID_RESET_TOKEN', message: 'invalid' } }),
    });
    renderApp('/reset-password?token=abc');
    await userEvent.type(
      await screen.findByLabelText('New password'),
      'a-brand-new-long-passphrase',
    );
    await userEvent.type(
      screen.getByLabelText('New password again'),
      'a-brand-new-long-passphrase',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid, expired or already used');
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('shows the password rule that was broken', async () => {
    mockFetch({
      ...noSession,
      'POST /api/auth/reset-password': () =>
        json(400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'bad',
            details: [{ path: 'newPassword', message: 'Password must be at least 12 characters' }],
          },
        }),
    });
    renderApp('/reset-password?token=abc');
    await userEvent.type(await screen.findByLabelText('New password'), 'short');
    await userEvent.type(screen.getByLabelText('New password again'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 12 characters');
  });

  it('asks for a new link when the address has no token', async () => {
    mockFetch(noSession);
    renderApp('/reset-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('needs the link from the email');
    await waitFor(() => expect(screen.queryByLabelText('New password')).not.toBeInTheDocument());
  });
});
