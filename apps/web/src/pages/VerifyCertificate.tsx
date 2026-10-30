import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { VerifiedCertificate, WithdrawnCertificate } from '../api/aftermathTypes';
import { formatDate } from '../lib/datetime';

type Result =
  | { kind: 'valid'; cert: VerifiedCertificate }
  | { kind: 'withdrawn'; code: string }
  | { kind: 'invalid' }
  | { kind: 'error'; text: string };

/** Public page: anyone can check that a certificate code is genuine. No sign-in needed. */
export function VerifyCertificate() {
  const { code: fromAddress } = useParams();
  const navigate = useNavigate();
  const [typed, setTyped] = useState(fromAddress ?? '');
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!fromAddress) {
      setResult(null);
      return;
    }
    setTyped(fromAddress);
    api<{ data: VerifiedCertificate | WithdrawnCertificate }>(
      `/certificates/verify/${encodeURIComponent(fromAddress)}`,
    )
      .then((r) =>
        setResult(
          r.data.valid ? { kind: 'valid', cert: r.data } : { kind: 'withdrawn', code: r.data.code },
        ),
      )
      .catch((err) =>
        setResult(
          err instanceof ApiError && err.status === 404
            ? { kind: 'invalid' }
            : {
                kind: 'error',
                text:
                  err instanceof ApiError && err.status === 429
                    ? 'Too many checks. Please try again later.'
                    : 'Could not check the code.',
              },
        ),
      );
  }, [fromAddress]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (typed.trim()) navigate(`/verify/${encodeURIComponent(typed.trim())}`);
  }

  return (
    <section className="card narrow">
      <h1>Verify a certificate</h1>
      <form onSubmit={submit}>
        <label>
          Certificate code
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
        <button type="submit">Check</button>
      </form>
      {result?.kind === 'valid' && (
        <div role="status" className="notice notice-ok">
          <p>
            <strong>This certificate is genuine.</strong>
          </p>
          <p>
            Awarded to <strong>{result.cert.holderName}</strong> for taking part in{' '}
            <strong>{result.cert.eventTitle}</strong> on{' '}
            {formatDate(result.cert.eventStartAt.slice(0, 10))}.
          </p>
          <p className="muted">Code {result.cert.code}</p>
        </div>
      )}
      {result?.kind === 'withdrawn' && (
        <p role="alert" className="error">
          This certificate (code {result.code}) was withdrawn and is no longer valid.
        </p>
      )}
      {result?.kind === 'invalid' && (
        <p role="alert" className="error">
          No certificate was found with this code. Check that it was typed correctly.
        </p>
      )}
      {result?.kind === 'error' && (
        <p role="alert" className="error">
          {result.text}
        </p>
      )}
    </section>
  );
}
