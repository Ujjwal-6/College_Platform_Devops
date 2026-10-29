import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import {
  json,
  makeEvent,
  mockFetch,
  organizerUser,
  renderApp,
  session,
  studentUser,
} from './utils';

beforeEach(() => {
  setAccessToken(null);
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const published = (over: Record<string, unknown> = {}) =>
  makeEvent({ status: 'published', workflow: null, registrationEligible: true, ...over });
const mine = {
  id: 'r1',
  eventId: 'e1',
  status: 'registered',
  cancelReason: null,
  registeredAt: '2031-02-01T04:30:00.000Z',
  cancelledAt: null,
  waitlistPosition: null,
  team: null,
};
const summary = (over: Record<string, unknown> = {}) =>
  json(200, {
    data: {
      eventId: 'e1',
      registrationMode: 'individual',
      capacity: null,
      registered: 1,
      seatsLeft: null,
      open: true,
      full: false,
      waitlisted: 0,
      waitlistOpen: false,
      mine,
      ...over,
    },
  });
const pass = (over: Record<string, unknown> = {}) =>
  json(200, {
    data: {
      token: 'EQ1.payload.signature',
      expiresAt: '2031-03-01T06:30:00.000Z',
      qrImage: 'data:image/png;base64,AAAA',
      gatePassReady: true,
      checkedInAt: null,
      ...over,
    },
  });
const SUMMARY = 'GET /api/events/e1/registration-summary';
const QR = 'GET /api/registrations/r1/qr';

describe('my gate pass on the event page', () => {
  it('shows the QR code, its text form and a download button for a registered person', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/events/e1': () => json(200, { data: published() }),
      [SUMMARY]: () => summary(),
      [QR]: () => pass(),
    });
    renderApp('/events/e1');
    const image = await screen.findByAltText('Your check-in QR code');
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(screen.getByText('EQ1.payload.signature')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download gate pass (PDF)' })).toBeInTheDocument();
    expect(screen.getByText(/It works once/)).toBeInTheDocument();
  });

  it('says the PDF is being prepared until the worker has made it', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/events/e1': () => json(200, { data: published() }),
      [SUMMARY]: () => summary(),
      [QR]: () => pass({ gatePassReady: false }),
    });
    renderApp('/events/e1');
    expect(await screen.findByText(/PDF gate pass is being prepared/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Download gate pass (PDF)' }),
    ).not.toBeInTheDocument();
  });

  it('downloads the PDF with the sign-in token', async () => {
    const created = vi.fn(() => 'blob:fake');
    const revoked = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { calls } = mockFetch({
      ...session(studentUser),
      'GET /api/events/e1': () => json(200, { data: published() }),
      [SUMMARY]: () => summary(),
      [QR]: () => pass(),
      'GET /api/registrations/r1/gate-pass': () =>
        Promise.resolve(
          new Response(new Blob(['%PDF-1.3']), {
            status: 200,
            headers: { 'Content-Type': 'application/pdf' },
          }),
        ),
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByRole('button', { name: 'Download gate pass (PDF)' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(created).toHaveBeenCalled();
    expect(revoked).toHaveBeenCalledWith('blob:fake');
    const get = calls.find((c) => c.key === 'GET /api/registrations/r1/gate-pass')!;
    expect((get.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    click.mockRestore();
  });

  it('shows the server message when the download is refused', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/events/e1': () => json(200, { data: published() }),
      [SUMMARY]: () => summary(),
      [QR]: () => pass(),
      'GET /api/registrations/r1/gate-pass': () =>
        json(409, {
          error: {
            code: 'REGISTRATION_NOT_ACTIVE',
            message: 'Only a current registration has a pass',
          },
        }),
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByRole('button', { name: 'Download gate pass (PDF)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only a current registration has a pass',
    );
  });

  it('shows when the person was checked in', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/events/e1': () => json(200, { data: published() }),
      [SUMMARY]: () => summary(),
      [QR]: () => pass({ checkedInAt: '2031-03-01T04:40:00.000Z' }),
    });
    renderApp('/events/e1');
    expect(await screen.findByText('You were checked in')).toBeInTheDocument();
  });

  it('shows no pass to someone who is not registered', async () => {
    const { calls } = mockFetch({
      ...session(studentUser),
      'GET /api/events/e1': () => json(200, { data: published() }),
      [SUMMARY]: () => summary({ mine: null, registered: 0 }),
    });
    renderApp('/events/e1');
    await screen.findByRole('button', { name: 'Register' });
    expect(screen.queryByAltText('Your check-in QR code')).not.toBeInTheDocument();
    expect(calls.some((c) => c.key.endsWith('/qr'))).toBe(false);
  });

  it('shows the organizer a link to the gate screen, and nobody else', async () => {
    mockFetch({
      ...session(organizerUser),
      'GET /api/events/e1': () => json(200, { data: published({ organizerId: organizerUser.id }) }),
      [SUMMARY]: () => summary({ mine: null, registered: 0 }),
    });
    renderApp('/events/e1');
    expect(
      await screen.findByRole('link', { name: 'Open check-in for this event' }),
    ).toHaveAttribute('href', '/events/e1/check-in');
  });

  it('shows another student no gate link', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/events/e1': () => json(200, { data: published() }),
      [SUMMARY]: () => summary({ mine: null, registered: 0 }),
    });
    renderApp('/events/e1');
    await screen.findByRole('button', { name: 'Register' });
    expect(
      screen.queryByRole('link', { name: 'Open check-in for this event' }),
    ).not.toBeInTheDocument();
  });
});
