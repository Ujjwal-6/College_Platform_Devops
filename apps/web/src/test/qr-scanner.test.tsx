import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const decode = vi.fn();
vi.mock('jsqr', () => ({ default: (...args: unknown[]) => decode(...args) }));

import { QrScanner } from '../components/QrScanner';

const stopTrack = vi.fn();
const getUserMedia = vi.fn();

beforeEach(() => {
  decode.mockReset();
  stopTrack.mockReset();
  getUserMedia.mockReset();
  getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  // jsdom has no camera or canvas: give the video a picture size and the canvas a pixel reader
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    get: () => 4,
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
    configurable: true,
    get: () => 64,
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
    configurable: true,
    get: () => 48,
  });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 64, height: 48 }),
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('QR scanner', () => {
  it('does nothing, and asks for no camera, until it is switched on', () => {
    render(<QrScanner active={false} onCode={() => {}} />);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Camera')).not.toBeInTheDocument();
  });

  it('reports a code it reads, once, even though it keeps seeing it', async () => {
    decode.mockReturnValue({ data: 'EQ1.payload.signature' });
    const onCode = vi.fn();
    render(<QrScanner active onCode={onCode} />);
    expect(await screen.findByLabelText('Camera')).toBeInTheDocument();
    await waitFor(() => expect(onCode).toHaveBeenCalledWith('EQ1.payload.signature'));
    await new Promise((r) => setTimeout(r, 900)); // several more frames showing the same pass
    expect(decode.mock.calls.length).toBeGreaterThan(2);
    expect(onCode).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: { facingMode: 'environment' }, audio: false }),
    );
  });

  it('reports a different code straight away', async () => {
    let n = 0;
    decode.mockImplementation(() => ({ data: n++ < 2 ? 'first' : 'second' }));
    const onCode = vi.fn();
    render(<QrScanner active onCode={onCode} />);
    await waitFor(() => expect(onCode).toHaveBeenCalledWith('second'));
    expect(onCode.mock.calls.map((c) => c[0])).toEqual(['first', 'second']);
  });

  it('ignores frames with no code in them', async () => {
    decode.mockReturnValue(null);
    const onCode = vi.fn();
    render(<QrScanner active onCode={onCode} />);
    await waitFor(() => expect(decode).toHaveBeenCalled());
    expect(onCode).not.toHaveBeenCalled();
  });

  it('switches the camera off when it is switched off or removed', async () => {
    decode.mockReturnValue(null);
    const { rerender, unmount } = render(<QrScanner active onCode={() => {}} />);
    await waitFor(() => expect(decode).toHaveBeenCalled());
    rerender(<QrScanner active={false} onCode={() => {}} />);
    expect(stopTrack).toHaveBeenCalledTimes(1);

    rerender(<QrScanner active onCode={() => {}} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(decode.mock.calls.length).toBeGreaterThan(0));
    unmount();
    expect(stopTrack).toHaveBeenCalledTimes(2);
  });

  it('tells the person when the camera is refused, and when there is none', async () => {
    getUserMedia.mockRejectedValue(new Error('denied'));
    const { unmount } = render(<QrScanner active onCode={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Allow camera access, or type the code/,
    );
    unmount();

    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    render(<QrScanner active onCode={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot use the camera/);
  });
});
