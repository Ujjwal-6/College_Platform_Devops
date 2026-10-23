import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, login, refreshSession, setAccessToken } from '../api/client';
import { json, mockFetch, studentUser } from './utils';

beforeEach(() => setAccessToken(null));
afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('sends the in-memory token as a Bearer header', async () => {
    const { calls } = mockFetch({
      'POST /api/auth/login': () => json(200, { accessToken: 'abc', user: studentUser }),
      'GET /api/users': () => json(200, { data: [] }),
    });
    await login('s@college.test', 'a-long-enough-passphrase');
    await api('/users');
    expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer abc');
  });

  it('on 401 refreshes once and retries the original request', async () => {
    let usersCalls = 0;
    const { calls } = mockFetch({
      'GET /api/users': () =>
        ++usersCalls === 1
          ? json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } })
          : json(200, { data: ['ok'] }),
      'POST /api/auth/refresh': () => json(200, { accessToken: 'fresh', user: studentUser }),
    });
    const res = await api<{ data: string[] }>('/users');
    expect(res.data).toEqual(['ok']);
    expect(calls.map((c) => c.key)).toEqual([
      'GET /api/users',
      'POST /api/auth/refresh',
      'GET /api/users',
    ]);
    expect((calls[2]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer fresh');
  });

  it('shares one refresh request between concurrent callers (rotation allows each token once)', async () => {
    let refreshes = 0;
    mockFetch({
      'POST /api/auth/refresh': async () => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { accessToken: 't', user: studentUser });
      },
    });
    await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(refreshes).toBe(1);
  });

  it('does not loop when the refresh fails: reports the session as lost', async () => {
    mockFetch({
      'GET /api/users': () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }),
      'POST /api/auth/refresh': () =>
        json(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'x' } }),
    });
    await expect(api('/users')).rejects.toBeInstanceOf(ApiError);
  });

  it('exposes validation details from the API error format', async () => {
    mockFetch({
      'POST /api/users': () =>
        json(400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'bad',
            details: [{ path: 'email', message: 'Invalid email' }],
          },
        }),
    });
    await expect(api('/users', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      details: [{ path: 'email' }],
    });
  });
});
