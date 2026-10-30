import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import {
  adminUser,
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

const finished = (o: Record<string, unknown> = {}) =>
  makeEvent({
    status: 'closed',
    organizerId: organizerUser.id,
    workflow: { approvals: [], history: [] },
    startAt: '2020-03-01T04:30:00.000Z',
    endAt: '2020-03-01T06:30:00.000Z',
    ...o,
  });
const row = (o: Record<string, unknown> = {}) => ({
  id: 'c1',
  eventId: 'e1',
  holderName: 'Priya Sharma',
  code: '7K2M-QX9D-4HT8-WB3N',
  status: 'ready',
  issuedAt: '2031-03-02T04:30:00.000Z',
  generatedAt: '2031-03-02T04:31:00.000Z',
  revokedAt: null,
  ...o,
});
/** A function so every request gets a fresh response (a body can only be read once). */
const listing =
  (rows: object[], summary: Record<string, unknown> = {}) =>
  () =>
    json(200, {
      summary: {
        eligible: 3,
        issued: rows.length,
        ready: rows.length,
        revoked: 0,
        canIssue: true,
        ...summary,
      },
      data: rows,
    });

describe('withdrawing and reinstating a certificate', () => {
  it('asks for a reason, then withdraws it', async () => {
    let rows = [row()];
    const { calls } = mockFetch({
      ...session(organizerUser),
      'GET /api/events/e1': () => json(200, { data: finished() }),
      'GET /api/events/e1/certificates': () =>
        listing(rows, { revoked: rows.some((r) => r.revokedAt) ? 1 : 0 })(),
      'POST /api/certificates/c1/revoke': () => {
        rows = [row({ revokedAt: '2031-03-03T04:30:00.000Z', revokeReason: 'Wrong person' })];
        return json(200, { data: rows[0] });
      },
    });
    renderApp('/events/e1');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Withdraw certificate for Priya Sharma' }),
    );
    expect(screen.getByText(/Its code will say/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Reason'), 'Wrong person');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'The certificate for Priya Sharma was withdrawn.',
    );
    expect(await screen.findByText('Withdrawn (Wrong person)')).toBeInTheDocument();
    expect(screen.getByText(/1 withdrawn/)).toBeInTheDocument();
    const post = calls.find((c) => c.key === 'POST /api/certificates/c1/revoke')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ reason: 'Wrong person' });
    expect(screen.queryByText(/Its code will say/)).not.toBeInTheDocument();
  });

  it('can be cancelled without sending anything', async () => {
    const { calls } = mockFetch({
      ...session(organizerUser),
      'GET /api/events/e1': () => json(200, { data: finished() }),
      'GET /api/events/e1/certificates': listing([row()]),
    });
    renderApp('/events/e1');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Withdraw certificate for Priya Sharma' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Its code will say/)).not.toBeInTheDocument();
    expect(calls.some((c) => c.key.includes('/revoke'))).toBe(false);
  });

  it('shows the server message when withdrawing is refused', async () => {
    mockFetch({
      ...session(organizerUser),
      'GET /api/events/e1': () => json(200, { data: finished() }),
      'GET /api/events/e1/certificates': listing([row()]),
      'POST /api/certificates/c1/revoke': () =>
        json(409, {
          error: { code: 'ALREADY_REVOKED', message: 'This certificate is already withdrawn' },
        }),
    });
    renderApp('/events/e1');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Withdraw certificate for Priya Sharma' }),
    );
    await userEvent.type(screen.getByLabelText('Reason'), 'Mistake');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already withdrawn');
  });

  it('reinstates a withdrawn certificate', async () => {
    let rows = [row({ revokedAt: '2031-03-03T04:30:00.000Z', revokeReason: 'Wrong person' })];
    const { calls } = mockFetch({
      ...session(organizerUser),
      'GET /api/events/e1': () => json(200, { data: finished() }),
      'GET /api/events/e1/certificates': () => listing(rows)(),
      'POST /api/certificates/c1/reinstate': () => {
        rows = [row()];
        return json(200, { data: rows[0] });
      },
    });
    renderApp('/events/e1');
    expect(await screen.findByText('Withdrawn (Wrong person)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Redraw certificate/ })).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Reinstate certificate for Priya Sharma' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('was reinstated');
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(calls.map((c) => c.key)).toContain('POST /api/certificates/c1/reinstate');
  });

  it('offers department staff who are not the organizer no withdraw, reinstate or issue buttons', async () => {
    mockFetch({
      ...session({ ...organizerUser, id: 'someone-else', roles: ['faculty'] }),
      'GET /api/events/e1': () => json(200, { data: finished() }),
      'GET /api/events/e1/certificates': listing([row()]),
    });
    renderApp('/events/e1');
    await screen.findByText('Priya Sharma');
    for (const name of [
      /Withdraw certificate/,
      /Reinstate/,
      /Redraw/,
      'Issue certificates',
      'Redraw all certificates',
    ]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });
});

describe('redrawing all certificates (admin)', () => {
  it('redraws every certificate of the event', async () => {
    const { calls } = mockFetch({
      ...session(adminUser),
      'GET /api/events/e1': () => json(200, { data: finished() }),
      'GET /api/events/e1/certificates': listing([row()]),
      'POST /api/events/e1/certificates/redraw': () => json(202, { data: { queued: 1 } }),
    });
    renderApp('/events/e1');
    await userEvent.click(await screen.findByRole('button', { name: 'Redraw all certificates' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'being redrawn with the current design',
    );
    expect(calls.map((c) => c.key)).toContain('POST /api/events/e1/certificates/redraw');
  });

  it('is not offered to the organizer', async () => {
    mockFetch({
      ...session(organizerUser),
      'GET /api/events/e1': () => json(200, { data: finished() }),
      'GET /api/events/e1/certificates': listing([row()]),
    });
    renderApp('/events/e1');
    await screen.findByText('Priya Sharma');
    expect(
      screen.queryByRole('button', { name: 'Redraw all certificates' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue certificates' })).toBeInTheDocument();
  });
});

describe('withdrawn certificates for everyone else', () => {
  const noSession = {
    'POST /api/auth/refresh': () =>
      json(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'x' } }),
  };

  it('says on the verification page that the certificate was withdrawn, without a name', async () => {
    mockFetch({
      ...noSession,
      'GET /api/certificates/verify/7K2M-QX9D-4HT8-WB3N': () =>
        json(200, { data: { valid: false, revoked: true, code: '7K2M-QX9D-4HT8-WB3N' } }),
    });
    renderApp('/verify/7K2M-QX9D-4HT8-WB3N');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'was withdrawn and is no longer valid',
    );
    expect(screen.queryByText('This certificate is genuine.')).not.toBeInTheDocument();
  });

  it('shows the holder "Withdrawn" and no download', async () => {
    mockFetch({
      ...session(studentUser),
      'GET /api/certificates': () =>
        json(200, {
          data: [
            {
              ...row({ revokedAt: '2031-03-03T04:30:00.000Z' }),
              event: {
                id: 'e1',
                title: 'Tech Symposium',
                startAt: '2031-03-01T04:30:00.000Z',
                endAt: '2031-03-01T06:30:00.000Z',
              },
            },
          ],
        }),
    });
    renderApp('/certificates');
    expect(await screen.findByText('Withdrawn')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download certificate/ })).not.toBeInTheDocument();
  });
});

describe('the certificate design page (admin)', () => {
  const design = (o: Record<string, unknown> = {}) => ({
    organizationName: null,
    signatoryName: null,
    signatoryTitle: null,
    hasLogo: false,
    hasSignature: false,
    updatedAt: null,
    ...o,
  });

  it('shows what is set and what is still missing', async () => {
    mockFetch({
      ...session(adminUser),
      'GET /api/certificate-template': () =>
        json(200, { data: design({ organizationName: 'Sunrise College', hasLogo: true }) }),
    });
    renderApp('/admin/certificate-design');
    expect(await screen.findByLabelText('College or organisation name')).toHaveValue(
      'Sunrise College',
    );
    expect(screen.getByText(/Logo:/).closest('p')).toHaveTextContent('uploaded');
    expect(screen.getByText(/Signature image:/).closest('p')).toHaveTextContent('not uploaded yet');
    expect(screen.getByRole('button', { name: 'Remove logo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove signature' })).not.toBeInTheDocument();
  });

  it('saves the names', async () => {
    const { calls } = mockFetch({
      ...session(adminUser),
      'GET /api/certificate-template': () => json(200, { data: design() }),
      'PUT /api/certificate-template': () =>
        json(200, {
          data: design({
            organizationName: 'Sunrise College',
            signatoryName: 'Dr A. Rao',
            signatoryTitle: 'Principal',
          }),
        }),
    });
    renderApp('/admin/certificate-design');
    await userEvent.type(
      await screen.findByLabelText('College or organisation name'),
      'Sunrise College',
    );
    await userEvent.type(screen.getByLabelText('Signatory name'), 'Dr A. Rao');
    await userEvent.type(screen.getByLabelText('Signatory title'), 'Principal');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    const put = calls.find((c) => c.key === 'PUT /api/certificate-template')!;
    expect(JSON.parse(String(put.init?.body))).toEqual({
      organizationName: 'Sunrise College',
      signatoryName: 'Dr A. Rao',
      signatoryTitle: 'Principal',
    });
  });

  it('uploads a logo as the raw image with its own type', async () => {
    const { calls } = mockFetch({
      ...session(adminUser),
      'GET /api/certificate-template': () => json(200, { data: design() }),
      'PUT /api/certificate-template/logo': () => json(200, { data: design({ hasLogo: true }) }),
    });
    renderApp('/admin/certificate-design');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', {
      type: 'image/png',
    });
    await userEvent.upload(await screen.findByLabelText(/Upload logo/), file);
    expect(await screen.findByRole('status')).toHaveTextContent('The logo was uploaded');
    const put = calls.find((c) => c.key === 'PUT /api/certificate-template/logo')!;
    expect((put.init?.headers as Record<string, string>)['Content-Type']).toBe('image/png');
    expect(put.init?.body).toBe(file);
    expect((put.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(await screen.findByRole('button', { name: 'Remove logo' })).toBeInTheDocument();
  });

  it('shows the server message when an image is refused', async () => {
    mockFetch({
      ...session(adminUser),
      'GET /api/certificate-template': () => json(200, { data: design() }),
      'PUT /api/certificate-template/signature': () =>
        json(422, {
          error: { code: 'INVALID_FILE', message: 'Unsupported file type; allowed: png, jpeg' },
        }),
    });
    renderApp('/admin/certificate-design');
    await userEvent.upload(
      await screen.findByLabelText(/Upload signature/),
      new File(['x'], 'sig.png', { type: 'image/png' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported file type');
  });

  it('removes an image', async () => {
    let hasSignature = true;
    const { calls } = mockFetch({
      ...session(adminUser),
      'GET /api/certificate-template': () => json(200, { data: design({ hasSignature }) }),
      'DELETE /api/certificate-template/signature': () => {
        hasSignature = false;
        return json(200, { data: design() });
      },
    });
    renderApp('/admin/certificate-design');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove signature' }));
    expect(await screen.findByRole('status')).toHaveTextContent('The signature was removed');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove signature' })).not.toBeInTheDocument(),
    );
    expect(calls.map((c) => c.key)).toContain('DELETE /api/certificate-template/signature');
  });

  it('is only for admins', async () => {
    const { calls } = mockFetch({ ...session(organizerUser) });
    renderApp('/admin/certificate-design');
    expect(await screen.findByRole('alert')).toHaveTextContent('do not have access');
    expect(calls.some((c) => c.key.includes('/certificate-template'))).toBe(false);
    expect(screen.queryByRole('link', { name: 'Certificate design' })).not.toBeInTheDocument();
  });
});
