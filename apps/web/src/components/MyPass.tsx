import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, downloadFile } from '../api/client';
import type { MyPass as MyPassData } from '../api/attendanceTypes';
import { formatDateTime } from '../lib/datetime';

const POLL_MS = 5000;

/** A registrant's own gate pass: the QR code to show at the gate, and the PDF once the worker has made it. */
export function MyPass({ registrationId }: { registrationId: string }) {
  const [pass, setPass] = useState<MyPassData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPass((await api<{ data: MyPassData }>(`/registrations/${registrationId}/qr`)).data);
    } catch {
      setError('Could not load your gate pass.');
    }
  }, [registrationId]);
  useEffect(() => void load(), [load]);

  // The PDF is made in the background; check again until it is ready.
  useEffect(() => {
    if (!pass || pass.gatePassReady) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [pass, load]);

  async function download() {
    setError(null);
    try {
      await downloadFile(`/registrations/${registrationId}/gate-pass`, 'gate-pass.pdf');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not download the gate pass.');
    }
  }

  if (error && !pass) {
    return (
      <p role="alert" className="error">
        {error}
      </p>
    );
  }
  if (!pass) return null;
  return (
    <>
      <h3>Your gate pass</h3>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {pass.checkedInAt && (
        <p>
          <strong>You were checked in</strong> at {formatDateTime(pass.checkedInAt)}
          {pass.checkedOutAt ? `, and checked out at ${formatDateTime(pass.checkedOutAt)}` : ''}.
        </p>
      )}
      <img src={pass.qrImage} alt="Your check-in QR code" width={220} height={220} />
      <p className="muted">
        Show this QR code at the gate when you arrive and again when you leave. Please do not share
        it. Valid until {formatDateTime(pass.expiresAt)}.
      </p>
      {pass.gatePassReady ? (
        <button onClick={() => void download()}>Download gate pass (PDF)</button>
      ) : (
        <p className="muted">Your PDF gate pass is being prepared. This page will update.</p>
      )}
      <details>
        <summary>Code as text</summary>
        <code style={{ wordBreak: 'break-all' }}>{pass.token}</code>
      </details>
    </>
  );
}
