import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api/client';
import {
  adminUser,
  facultyUser,
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

const event = (o: Record<string, unknown> = {}) =>
  makeEvent({
    status: 'closed',
    organizerId: organizerUser.id,
    workflow: { approvals: [], history: [] },
    startAt: '2020-03-01T04:30:00.000Z',
    endAt: '2020-03-01T06:30:00.000Z',
    ...o,
  });
const version = (o: Record<string, unknown> = {}) => ({
  id: 'r1',
  version: 1,
  reason: 'close',
  status: 'ready',
  requestedBy: null,
  createdAt: '2031-03-02T04:30:00.000Z',
  generatedAt: '2031-03-02T04:31:00.000Z',
  ...o,
});
const overview = (o: Record<string, unknown> = {}) => ({
  inputs: { outcomes: null },
  photos: [],
  reports: [],
  limits: { photoMaxBytes: 2_000_000, photoMaxCount: 20 },
  can: { edit: true, generate: true },
  ...o,
});
/** A function, so each request gets a fresh response (a body can only be read once). */
const report =
  (o: Record<string, unknown> = {}) =>
  () =>
    json(200, { data: overview(o) });
const routes = (user: object, o: Record<string, unknown> = {}, ev = event()) => ({
  ...session(user),
  'GET /api/events/e1': () => json(200, { data: ev }),
  'GET /api/events/e1/report': report(o),
});

describe('outcomes', () => {
  it('shows what was written and saves a change', async () => {
    let outcomes: string | null = 'Six prototypes were built.';
    const { calls } = mockFetch({
      ...routes(organizerUser),
      'GET /api/events/e1/report': () => json(200, { data: overview({ inputs: { outcomes } }) }),
      'PUT /api/events/e1/report/outcomes': () => {
        outcomes = 'Forty teams took part.';
        return json(200, { data: { outcomes } });
      },
    });
    renderApp('/events/e1');
    const box = await screen.findByLabelText('What the event achieved');
    expect(box).toHaveValue('Six prototypes were built.');
    await userEvent.clear(box);
    await userEvent.type(box, 'Forty teams took part.');
    await userEvent.click(screen.getByRole('button', { name: 'Save outcomes' }));
    expect(await screen.findByRole('status')).toHaveTextContent('The outcomes were saved.');
    const put = calls.find((c) => c.key === 'PUT /api/events/e1/report/outcomes')!;
    expect(JSON.parse(String(put.init?.body))).toEqual({ outcomes: 'Forty teams took part.' });
  });

  it('sends nothing but null when the text is cleared', async () => {
    const { calls } = mockFetch({
      ...routes(organizerUser, { inputs: { outcomes: 'Old text' } }),
      'PUT /api/events/e1/report/outcomes': () => json(200, { data: { outcomes: null } }),
    });
    renderApp('/events/e1');
    await userEvent.clear(await screen.findByLabelText('What the event achieved'));
    await userEvent.click(screen.getByRole('button', { name: 'Save outcomes' }));
    await screen.findByText('The outcomes were saved.');
    expect(
      JSON.parse(
        String(calls.find((c) => c.key === 'PUT /api/events/e1/report/outcomes')!.init?.body),
      ),
    ).toEqual({ outcomes: null });
  });

  it('shows the server message when saving is refused', async () => {
    mockFetch({
      ...routes(organizerUser),
      'PUT /api/events/e1/report/outcomes': () =>
        json(409, {
          error: {
            code: 'EVENT_NOT_ACTIVE',
            message: 'Outcomes can be added once the event is published',
          },
        }),
    });
    renderApp('/events/e1');
    await userEvent.type(await screen.findByLabelText('What the event achieved'), 'Something');
    await userEvent.click(screen.getByRole('button', { name: 'Save outcomes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('once the event is published');
  });
});

describe('photographs', () => {
  const photo = (o: Record<string, unknown> = {}) => ({
    id: 'p1',
    caption: 'Opening session',
    createdAt: '2031-03-02T04:30:00.000Z',
    ...o,
  });

  it('adds one with a caption, sending the raw file with its own type', async () => {
    let photos: object[] = [];
    const { calls } = mockFetch({
      ...routes(organizerUser),
      'GET /api/events/e1/report': () => json(200, { data: overview({ photos }) }),
      'POST /api/events/e1/report/photos?caption=Backstage%20crew': () => {
        photos = [photo({ caption: 'Backstage crew' })];
        return json(201, { data: photo({ caption: 'Backstage crew' }) });
      },
      'GET /api/events/e1/report/photos/p1': () =>
        Promise.resolve(new Response('x', { status: 200 })),
    });
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() }),
    );
    renderApp('/events/e1');
    await userEvent.type(
      await screen.findByLabelText(/Caption for the next photograph/),
      'Backstage crew',
    );
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'p.png', {
      type: 'image/png',
    });
    await userEvent.upload(screen.getByLabelText(/Add a photograph/), file);
    expect(await screen.findByRole('status')).toHaveTextContent('The photograph was added.');
    const post = calls.find((c) => c.key.startsWith('POST /api/events/e1/report/photos'))!;
    expect(post.init?.body).toBe(file);
    expect((post.init?.headers as Record<string, string>)['Content-Type']).toBe('image/png');
    expect((post.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(await screen.findByText(/Photographs \(1 of 20\)/)).toBeInTheDocument();
  });

  it('shows the server message when a photograph is refused', async () => {
    mockFetch({
      ...routes(organizerUser),
      'POST /api/events/e1/report/photos': () =>
        json(422, {
          error: { code: 'INVALID_FILE', message: 'Unsupported file type; allowed: png, jpeg' },
        }),
    });
    renderApp('/events/e1');
    await userEvent.upload(
      await screen.findByLabelText(/Add a photograph/),
      new File(['x'], 'p.png', { type: 'image/png' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported file type');
  });

  it('tells the organizer the size limit it was given by the server', async () => {
    mockFetch(routes(organizerUser));
    renderApp('/events/e1');
    expect(
      await screen.findByLabelText(/Add a photograph \(JPEG or PNG, up to 2 MB\)/),
    ).toBeInTheDocument();
  });

  it('shows the photographs, loading each with the sign-in token, and removes one', async () => {
    let photos = [photo()];
    const created = vi.fn(() => 'blob:photo');
    const revoked = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked }),
    );
    const { calls } = mockFetch({
      ...routes(organizerUser),
      'GET /api/events/e1/report': () => json(200, { data: overview({ photos }) }),
      'GET /api/events/e1/report/photos/p1': () =>
        Promise.resolve(new Response('x', { status: 200 })),
      'DELETE /api/events/e1/report/photos/p1': () => {
        photos = [];
        return json(200, { data: { removed: true } });
      },
    });
    renderApp('/events/e1');
    const image = await screen.findByAltText('Opening session');
    expect(image).toHaveAttribute('src', 'blob:photo');
    const get = calls.find((c) => c.key === 'GET /api/events/e1/report/photos/p1')!;
    expect((get.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');

    await userEvent.click(
      screen.getByRole('button', { name: 'Remove photograph Opening session' }),
    );
    expect(await screen.findByText('No photographs provided yet.')).toBeInTheDocument();
    await waitFor(() => expect(revoked).toHaveBeenCalledWith('blob:photo'));
  });

  it('offers no upload once the limit is reached', async () => {
    const full = Array.from({ length: 20 }, (_, i) =>
      photo({ id: `p${i}`, caption: `Photo ${i}` }),
    );
    mockFetch({
      ...routes(organizerUser, { photos: full }),
      ...Object.fromEntries(
        full.map((p) => [
          `GET /api/events/e1/report/photos/${p.id}`,
          () => Promise.resolve(new Response('x', { status: 200 })),
        ]),
      ),
    });
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }),
    );
    renderApp('/events/e1');
    expect(await screen.findByText(/Photographs \(20 of 20\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Add a photograph/)).not.toBeInTheDocument();
  });
});

describe('versions of the report', () => {
  it('lists the versions with their state, and downloads a ready one with the sign-in token', async () => {
    const created = vi.fn(() => 'blob:pdf');
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { calls } = mockFetch({
      ...routes(organizerUser, {
        reports: [
          version({
            id: 'r3',
            version: 3,
            reason: 'manual',
            status: 'pending',
            requestedBy: 'Olive Organizer',
            generatedAt: null,
          }),
          version({
            id: 'r2',
            version: 2,
            reason: 'manual',
            status: 'failed',
            requestedBy: 'Ada Admin',
            generatedAt: null,
          }),
          version({ id: 'r1', version: 1 }),
        ],
        can: { edit: true, generate: false },
      }),
      'GET /api/event-reports/r1/download': () =>
        Promise.resolve(new Response('%PDF-1.3', { status: 200 })),
    });
    renderApp('/events/e1');
    expect(await screen.findByText('Being prepared…')).toBeInTheDocument();
    expect(screen.getByText('Could not be made')).toBeInTheDocument();
    expect(screen.getByText(/When the event closed/)).toBeInTheDocument();
    expect(screen.getByText(/Asked for by Ada Admin/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Download report version/ })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Download report version 1' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const get = calls.find((c) => c.key === 'GET /api/event-reports/r1/download')!;
    expect((get.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    click.mockRestore();
  });

  it('asks for a new version', async () => {
    const { calls } = mockFetch({
      ...routes(organizerUser, { reports: [version()] }),
      'POST /api/events/e1/reports': () =>
        json(202, {
          data: version({ id: 'r2', version: 2, status: 'pending', generatedAt: null }),
        }),
    });
    renderApp('/events/e1');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Make a new version of the report' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'A new version of the report is being prepared',
    );
    expect(calls.map((c) => c.key)).toContain('POST /api/events/e1/reports');
  });

  it('offers no new version while one is being made, and shows the server message when refused', async () => {
    mockFetch({
      ...routes(organizerUser, { reports: [version()] }),
      'POST /api/events/e1/reports': () =>
        json(409, {
          error: {
            code: 'REPORT_IN_PROGRESS',
            message: 'A report is already being made for this event',
          },
        }),
    });
    renderApp('/events/e1');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Make a new version of the report' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('already being made');
  });

  it('says the report is made when the event closes, while it is still published, but still takes inputs', async () => {
    mockFetch(
      routes(
        organizerUser,
        { can: { edit: true, generate: false } },
        event({ status: 'published' }),
      ),
    );
    renderApp('/events/e1');
    expect(
      await screen.findByText('The report will be made when the event is closed.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('What the event achieved')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Make a new version of the report' }),
    ).not.toBeInTheDocument();
  });
});

describe('who sees what', () => {
  it('lets department staff read the outcomes and download, but not change anything', async () => {
    mockFetch(
      routes(
        { ...facultyUser, id: 'someone-else' },
        {
          inputs: { outcomes: 'Six prototypes were built.' },
          reports: [version()],
          can: { edit: false, generate: false },
        },
      ),
    );
    renderApp('/events/e1');
    expect(await screen.findByText('Six prototypes were built.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download report version 1' })).toBeInTheDocument();
    for (const name of ['Save outcomes', 'Make a new version of the report', /Remove photograph/]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByLabelText('What the event achieved')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Add a photograph/)).not.toBeInTheDocument();
  });

  it('shows an admin the controls', async () => {
    mockFetch(routes(adminUser));
    renderApp('/events/e1');
    expect(await screen.findByLabelText('What the event achieved')).toBeInTheDocument();
  });

  it('shows nothing, and asks for nothing, to someone who is not staff', async () => {
    const { calls } = mockFetch({
      ...session(studentUser),
      'GET /api/events/e1': () => json(200, { data: event({ workflow: null }) }),
    });
    renderApp('/events/e1');
    await screen.findByRole('heading', { name: 'Tech Symposium' });
    expect(screen.queryByRole('heading', { name: 'Post-event report' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.key.endsWith('/report'))).toBe(false);
  });

  it('shows the report section only once the event is published', async () => {
    const { calls } = mockFetch({
      ...session(organizerUser),
      'GET /api/events/e1': () => json(200, { data: event({ status: 'approved' }) }),
    });
    renderApp('/events/e1');
    await screen.findByRole('heading', { name: 'Tech Symposium' });
    expect(screen.queryByRole('heading', { name: 'Post-event report' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.key.endsWith('/report'))).toBe(false);
  });
});
