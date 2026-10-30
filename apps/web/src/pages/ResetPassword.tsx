import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, fieldIssues } from '../api/client';

/** Chooses a new password with the link from the email (the token is in the address). */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) {
      setError('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(
        '/auth/reset-password',
        { method: 'POST', body: { token, newPassword: password } },
        false,
      );
      setDone(true);
    } catch (err) {
      const issues = fieldIssues(err);
      setError(
        issues.length
          ? issues.map((i) => i.message).join(' ')
          : err instanceof ApiError && err.status === 429
            ? 'Too many attempts. Please wait and try again.'
            : err instanceof ApiError && err.code === 'INVALID_RESET_TOKEN'
              ? 'This link is invalid, expired or already used. Ask for a new one.'
              : 'Could not change the password. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="card narrow">
        <h1>Password changed</h1>
        <p role="status">Your password was changed. Sign in with the new one.</p>
        <p>
          <Link to="/login">Sign in</Link>
        </p>
      </main>
    );
  }
  return (
    <main className="card narrow">
      <h1>Choose a new password</h1>
      {!token ? (
        <p role="alert" className="error">
          This page needs the link from the email.{' '}
          <Link to="/forgot-password">Ask for a new link</Link>
        </p>
      ) : (
        <form onSubmit={onSubmit}>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            New password again
            <input
              type="password"
              autoComplete="new-password"
              required
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
              {error.startsWith('This link') && (
                <>
                  {' '}
                  <Link to="/forgot-password">Ask for a new link</Link>
                </>
              )}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </form>
      )}
    </main>
  );
}
