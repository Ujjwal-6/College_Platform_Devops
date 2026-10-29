import type { User } from './types';

export interface FieldIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// The access token lives only in memory. The refresh token is an httpOnly cookie the browser
// manages; scripts (and therefore XSS) can never read it.
let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;
let refreshInFlight: Promise<User | null> | null = null;

/** Field-level validation messages from the API's error format (empty when the error carries none). */
export function fieldIssues(err: unknown): FieldIssue[] {
  return err instanceof ApiError && Array.isArray(err.details) ? (err.details as FieldIssue[]) : [];
}

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const hasAccessToken = () => accessToken !== null;
export const setSessionLostHandler = (fn: (() => void) | null) => {
  onSessionLost = fn;
};

interface SessionResponse {
  accessToken: string;
  user: User;
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    return new ApiError(
      res.status,
      body.error?.code ?? 'ERROR',
      body.error?.message ?? res.statusText,
      body.error?.details,
    );
  } catch {
    return new ApiError(res.status, 'ERROR', res.statusText || 'Request failed');
  }
}

/** Exchanges the refresh cookie for a new access token. Concurrent callers share one request (token rotation allows each token once). */
export function refreshSession(): Promise<User | null> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const body = (await res.json()) as SessionResponse;
      accessToken = body.accessToken;
      return body.user;
    } catch {
      accessToken = null;
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  retry = true,
): Promise<T> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers,
    credentials: 'include',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    const user = await refreshSession();
    if (user) return api<T>(path, init, false);
    onSessionLost?.();
  }
  if (!res.ok) throw await parseError(res);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Downloads a file the API protects (it needs the access token, so a plain link cannot be used). */
export async function downloadFile(path: string, filename: string, retry = true): Promise<void> {
  const res = await fetch(`/api${path}`, {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    credentials: 'include',
  });
  if (res.status === 401 && retry) {
    if (await refreshSession()) return downloadFile(path, filename, false);
    onSessionLost?.();
  }
  if (!res.ok) throw await parseError(res);
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function login(email: string, password: string): Promise<User> {
  const body = await api<SessionResponse>(
    '/auth/login',
    { method: 'POST', body: { email, password } },
    false,
  );
  accessToken = body.accessToken;
  return body.user;
}

export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST' }, false);
  } finally {
    accessToken = null;
  }
}
