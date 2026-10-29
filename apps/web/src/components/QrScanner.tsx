import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

/** The same code is not reported again for this long, so holding a pass in view does not scan it repeatedly. */
const REPEAT_MS = 3000;
const SCAN_EVERY_MS = 250;

/**
 * Shows the camera and reports each QR code it reads. The camera starts only when `active` is true
 * (the browser asks the person for permission then) and is always switched off again afterwards.
 * Decoding happens on the device; nothing from the camera is sent anywhere.
 */
export function QrScanner({ active, onCode }: { active: boolean; onCode: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    if (!active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot use the camera. Type or paste the code instead.');
      return;
    }
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    let last = { text: '', at: 0 };
    const canvas = document.createElement('canvas');

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const el = video.current;
        if (!el) return;
        el.srcObject = s;
        await el.play().catch(() => undefined);
        timer = setInterval(() => {
          if (el.readyState < 2 || !el.videoWidth) return;
          canvas.width = el.videoWidth;
          canvas.height = el.videoHeight;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const found = jsQR(image.data, image.width, image.height, {
            inversionAttempts: 'dontInvert',
          });
          if (!found?.data) return;
          const now = Date.now();
          if (found.data === last.text && now - last.at < REPEAT_MS) return;
          last = { text: found.data, at: now };
          onCodeRef.current(found.data);
        }, SCAN_EVERY_MS);
      })
      .catch(() =>
        setError('The camera could not be started. Allow camera access, or type the code instead.'),
      );

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active]);

  if (!active) return null;
  return (
    <div>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : (
        <video
          ref={video}
          muted
          playsInline
          aria-label="Camera"
          style={{ width: '100%', maxWidth: 420 }}
        />
      )}
    </div>
  );
}
