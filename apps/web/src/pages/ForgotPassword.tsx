import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';

/** Asks for a reset link. The answer is the same whether or not the address has an account. */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email } }, false);
      setSent(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Please wait and try again.'
          : 'Could not send the request. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="card narrow">
      <h1>Forgot your password?</h1>
      {sent ? (
        <p role="status">
          If that address has an account, we have emailed it a link to choose a new password. The
          link works once and expires soon.
        </p>
      ) : (
        <form onSubmit={onSubmit}>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
      <p>
        <Link to="/login">Back to sign in</Link>
      </p>
    </main>
  );
}
