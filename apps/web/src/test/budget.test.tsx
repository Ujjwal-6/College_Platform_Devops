import { screen, waitFor, within } from '@testing-library/react';
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
} from './utils';

beforeEach(() => {
  setAccessToken(null);
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const event = () =>
  makeEvent({
    status: 'published',
    organizerId: organizerUser.id,
    workflow: { approvals: [], history: [] },
  });
const item = (o: Record<string, unknown> = {}) => ({
  id: 'i1',
  kind: 'estimate',
  category: 'venue',
  description: 'Hall decoration',
  amountMinor: 150_050,
  spentOn: null,
  ...o,
});
const budget =
  (items: object[], o: Record<string, unknown> = {}) =>
  () =>
    json(200, {
      data: {
        currency: 'INR',
        items,
        totals: {
          estimateMinor: 150_050,
          actualMinor: 0,
          differenceMinor: -150_050,
          overBudget: false,
          byCategory: [
            { category: 'venue', estimateMinor: 150_050, actualMinor: 0, overBudget: false },
          ],
        },
        can: { edit: true },
        limits: { maxItems: 200, maxAmountMinor: 100_000_000_000 },
        ...o,
      },
    });
const routes = (user: object, get = budget([item()])) => ({
  ...session(user),
  'GET /api/events/e1': () => json(200, { data: event() }),
  'GET /api/events/e1/budget': get,
});

describe('budget section', () => {
  it('shows the items and totals in rupees', async () => {
    mockFetch(routes(organizerUser));
    renderApp('/events/e1');
    const table = await screen.findByRole('table', { name: 'Budget items' });
    expect(within(table).getByText('Hall decoration')).toBeInTheDocument();
    expect(within(table).getByText('₹1,500.50')).toBeInTheDocument();
    expect(screen.getByText(/Planned/, { selector: 'p' })).toHaveTextContent('₹1,500.50');
  });

  it('sends the amount as whole paise, not as a decimal', async () => {
    const { calls } = mockFetch({
      ...routes(organizerUser),
      'POST /api/events/e1/budget/items': () => json(201, { data: item() }),
    });
    renderApp('/events/e1');
    await screen.findByRole('table', { name: 'Budget items' });
    await userEvent.type(screen.getByLabelText('Description'), 'Banners');
    await userEvent.type(screen.getByLabelText('Amount (₹)'), '19.99');
    await userEvent.click(screen.getByRole('button', { name: 'Add item' }));
    await waitFor(() =>
      expect(calls.some((c) => c.key === 'POST /api/events/e1/budget/items')).toBe(true),
    );
    const post = calls.find((c) => c.key === 'POST /api/events/e1/budget/items')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({
      kind: 'estimate',
      category: 'venue',
      description: 'Banners',
      amountMinor: 1999,
    });
  });

  it('refuses an amount that is not rupees before asking the server', async () => {
    const { calls } = mockFetch(routes(organizerUser));
    renderApp('/events/e1');
    await screen.findByRole('table', { name: 'Budget items' });
    await userEvent.type(screen.getByLabelText('Description'), 'Banners');
    await userEvent.type(screen.getByLabelText('Amount (₹)'), '1.234');
    await userEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the amount in rupees');
    expect(calls.some((c) => c.key.startsWith('POST /api/events'))).toBe(false);
  });

  it('warns, without blocking, when spending is above the plan', async () => {
    mockFetch(
      routes(
        organizerUser,
        budget(
          [item(), item({ id: 'i2', kind: 'actual', amountMinor: 200_000, spentOn: '2031-02-20' })],
          {
            totals: {
              estimateMinor: 150_050,
              actualMinor: 200_000,
              differenceMinor: 49_950,
              overBudget: true,
              byCategory: [
                {
                  category: 'venue',
                  estimateMinor: 150_050,
                  actualMinor: 200_000,
                  overBudget: true,
                },
              ],
            },
          },
        ),
      ),
    );
    renderApp('/events/e1');
    expect(await screen.findByText(/₹499.50 above the planned amount/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add item' })).toBeEnabled();
  });

  it('edits and removes items', async () => {
    const { calls } = mockFetch({
      ...routes(organizerUser),
      'PATCH /api/events/e1/budget/items/i1': () => json(200, { data: item() }),
      'DELETE /api/events/e1/budget/items/i1': () => json(200, { data: { deleted: true } }),
    });
    renderApp('/events/e1');
    await screen.findByRole('table', { name: 'Budget items' });
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const amount = screen.getByLabelText('Amount (₹)');
    expect(amount).toHaveValue('1500.50');
    await userEvent.clear(amount);
    await userEvent.type(amount, '1600');
    await userEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() => expect(calls.some((c) => c.key.startsWith('PATCH'))).toBe(true));
    const patch = calls.find((c) => c.key.startsWith('PATCH'))!;
    expect(JSON.parse(String(patch.init?.body))).toMatchObject({
      amountMinor: 160_000,
      spentOn: null,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(true));
  });

  it('shows the API’s message when it refuses', async () => {
    const { calls } = mockFetch({
      ...routes(organizerUser),
      'POST /api/events/e1/budget/items': () =>
        json(409, {
          error: { code: 'TOO_MANY_ITEMS', message: 'An event can have at most 200 budget items' },
        }),
    });
    renderApp('/events/e1');
    await screen.findByRole('table', { name: 'Budget items' });
    await userEvent.type(screen.getByLabelText('Description'), 'x');
    await userEvent.type(screen.getByLabelText('Amount (₹)'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 200');
    expect(calls.filter((c) => c.key.startsWith('POST /api/events/e1/budget')).length).toBe(1);
  });

  it('is read-only when the person cannot edit', async () => {
    mockFetch(routes(adminUser, budget([item()], { can: { edit: false } })));
    renderApp('/events/e1');
    await screen.findByRole('table', { name: 'Budget items' });
    expect(screen.queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('shows no budget section when the server refuses access', async () => {
    mockFetch(
      routes(facultyUser, () =>
        json(403, { error: { code: 'FORBIDDEN', message: 'You do not have access' } }),
      ),
    );
    renderApp('/events/e1');
    await screen.findByRole('heading', { name: 'Tech Symposium' });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Budget' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
