import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  as,
  buildOrg,
  buildTestApp,
  createDraft,
  resetDb,
  type LoggedIn,
  type Org,
} from './helpers.js';
import { endedEvent } from './aftermath-helpers.js';
import { createPublishedEvent } from './registration-helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const audit = (a: string) => q('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [a]);
const item = (o: Record<string, unknown> = {}) => ({
  kind: 'estimate',
  category: 'venue',
  description: 'Hall decoration',
  amountMinor: 150_000,
  ...o,
});
const add = (who: LoggedIn, ev: string, body: object) =>
  as(t, who).post(`/api/events/${ev}/budget/items`, body);
const budget = (who: LoggedIn, ev: string) => as(t, who).get(`/api/events/${ev}/budget`);

describe('adding items and the totals (AC-9.1)', () => {
  it('keeps estimates and actual expenses, and the totals are exactly the sum of the items', async () => {
    const ev = await createDraft(t, org.organizer);
    await add(org.organizer, ev, item({ amountMinor: 10 }));
    await add(
      org.organizer,
      ev,
      item({ amountMinor: 20, category: 'catering', description: 'Snacks' }),
    );
    const spent = await add(
      org.organizer,
      ev,
      item({ kind: 'actual', amountMinor: 25, spentOn: '2031-03-01' }),
    );
    expect(spent.status).toBe(201);
    expect(spent.body.data.item).toMatchObject({
      kind: 'actual',
      amountMinor: 25,
      spentOn: '2031-03-01',
    });

    const res = await budget(org.organizer, ev);
    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('INR');
    expect(res.body.data.items).toHaveLength(3);
    // 10 + 20 paise is exactly 30, with no 0.30000000000000004 anywhere
    expect(res.body.data.totals).toMatchObject({
      estimateMinor: 30,
      actualMinor: 25,
      differenceMinor: -5,
      overBudget: false,
    });
    expect(res.body.data.totals.byCategory).toEqual([
      { category: 'venue', estimateMinor: 10, actualMinor: 25, overBudget: true },
      { category: 'catering', estimateMinor: 20, actualMinor: 0, overBudget: false },
    ]);
  });

  it('adds up large amounts exactly', async () => {
    const ev = await createDraft(t, org.organizer);
    const big = 100_000_000_000; // the largest single item: 1,000,000,000.00 rupees
    for (let i = 0; i < 3; i++)
      await add(org.organizer, ev, item({ amountMinor: big, description: `Big ${i}` }));
    await add(org.organizer, ev, item({ amountMinor: 1, description: 'One paisa' }));
    const totals = (await budget(org.organizer, ev)).body.data.totals;
    expect(totals.estimateMinor).toBe(300_000_000_001);
    expect(Number.isSafeInteger(totals.estimateMinor)).toBe(true);
  });

  it('adds many small amounts exactly (no floating-point drift)', async () => {
    const ev = await createDraft(t, org.organizer);
    for (let i = 0; i < 100; i++)
      await add(org.organizer, ev, item({ amountMinor: 10, description: `Tenth ${i}` }));
    expect((await budget(org.organizer, ev)).body.data.totals.estimateMinor).toBe(1000);
  });

  it('flags spending above the estimate, as a warning only: nothing is refused', async () => {
    const ev = await createDraft(t, org.organizer);
    await add(org.organizer, ev, item({ amountMinor: 100_000 }));
    const over = await add(org.organizer, ev, item({ kind: 'actual', amountMinor: 250_000 }));
    expect(over.status).toBe(201); // the expense is recorded even though it is above the estimate
    const totals = (await budget(org.organizer, ev)).body.data.totals;
    expect(totals).toMatchObject({
      estimateMinor: 100_000,
      actualMinor: 250_000,
      differenceMinor: 150_000,
      overBudget: true,
    });
    expect(totals.byCategory[0].overBudget).toBe(true);
  });

  it('treats spending in a category with no estimate as over budget', async () => {
    const ev = await createDraft(t, org.organizer);
    await add(
      org.organizer,
      ev,
      item({ kind: 'actual', category: 'prizes', amountMinor: 5_000, description: 'Trophies' }),
    );
    const totals = (await budget(org.organizer, ev)).body.data.totals;
    expect(totals.byCategory).toEqual([
      { category: 'prizes', estimateMinor: 0, actualMinor: 5_000, overBudget: true },
    ]);
    expect(totals.overBudget).toBe(true);
  });

  it('shows an empty budget as zeros', async () => {
    const ev = await createDraft(t, org.organizer);
    expect((await budget(org.organizer, ev)).body.data.totals).toEqual({
      estimateMinor: 0,
      actualMinor: 0,
      differenceMinor: 0,
      overBudget: false,
      byCategory: [],
    });
  });

  it('accepts a zero amount, and trims the description', async () => {
    const ev = await createDraft(t, org.organizer);
    const res = await add(
      org.organizer,
      ev,
      item({ amountMinor: 0, description: '  Sponsored banner  ' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.item.description).toBe('Sponsored banner');
  });
});

describe('who may see and change a budget (AC-9.2)', () => {
  it('lets only the organizer and admins change it, and the department HOD read it', async () => {
    const ev = await createPublishedEvent(t, org);
    await add(org.organizer, ev, item());
    for (const who of [org.organizer, org.admin, org.hod, org.faculty, org.faculty2])
      expect((await budget(who, ev)).status).toBe(200);
    expect((await add(org.admin, ev, item({ description: 'Added by an admin' }))).status).toBe(201);
    for (const who of [
      org.hod,
      org.faculty,
      org.student,
      org.otherOrganizer,
      org.otherHod,
      org.otherFaculty,
    ]) {
      expect((await add(who, ev, item())).status).toBe(403);
    }
    expect((await budget(org.hod, ev)).body.data.can.edit).toBe(false);
    expect((await budget(org.faculty, ev)).body.data.can.edit).toBe(false);
    expect((await budget(org.organizer, ev)).body.data.can.edit).toBe(true);
  });

  it("refuses another organizer's budget (403), and students and other departments' staff", async () => {
    const ev = await createPublishedEvent(t, org);
    await add(org.organizer, ev, item());
    for (const who of [org.otherOrganizer, org.student, org.otherHod, org.otherFaculty]) {
      const res = await budget(who, ev);
      expect(res.status, who.user.email).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('Hall decoration');
    }
    expect((await request(t.app).get(`/api/events/${ev}/budget`)).status).toBe(401);
    expect((await request(t.app).post(`/api/events/${ev}/budget/items`).send(item())).status).toBe(
      401,
    );
  });

  it("is invisible (404) on someone else's draft event, and for an unknown event", async () => {
    const draft = await createDraft(t, org.organizer);
    expect((await budget(org.otherOrganizer, draft)).status).toBe(404);
    expect((await add(org.otherOrganizer, draft, item())).status).toBe(404);
    expect((await budget(org.admin, '11111111-1111-4111-8111-111111111111')).status).toBe(404);
    expect((await budget(org.admin, 'not-a-uuid')).status).toBe(400);
  });

  it('keeps one event’s items out of another event (404)', async () => {
    const a = await createPublishedEvent(t, org);
    const b = await createPublishedEvent(t, org);
    const made = await add(org.organizer, a, item());
    const id = made.body.data.item.id as string;
    expect(
      (await as(t, org.organizer).patch(`/api/events/${b}/budget/items/${id}`, { amountMinor: 1 }))
        .status,
    ).toBe(404);
    expect((await as(t, org.organizer).delete(`/api/events/${b}/budget/items/${id}`)).status).toBe(
      404,
    );
    expect((await budget(org.organizer, b)).body.data.items).toHaveLength(0);
  });
});

describe('checking what is sent', () => {
  it('rejects bad amounts: fractions, negatives, too large, text, missing (400)', async () => {
    const ev = await createDraft(t, org.organizer);
    for (const amountMinor of [10.5, -1, 100_000_000_001, '1500', null, undefined, Number.NaN]) {
      const body = item({ amountMinor });
      if (amountMinor === undefined) delete (body as Record<string, unknown>).amountMinor;
      expect((await add(org.organizer, ev, body)).status, String(amountMinor)).toBe(400);
    }
    expect(await q('SELECT 1 FROM budget_items')).toHaveLength(0);
  });

  it('rejects bad kinds, categories, descriptions, dates and unknown fields (400)', async () => {
    const ev = await createDraft(t, org.organizer);
    const bad: object[] = [
      item({ kind: 'forecast' }),
      item({ category: 'yachts' }),
      item({ description: '' }),
      item({ description: '   ' }),
      item({ description: 'x'.repeat(201) }),
      item({ kind: 'actual', spentOn: '2031-02-30' }),
      item({ kind: 'actual', spentOn: '01/03/2031' }),
      item({ kind: 'estimate', spentOn: '2031-03-01' }),
      { ...item(), extra: 1 },
      { ...item(), createdBy: 'someone-else' },
    ];
    for (const body of bad)
      expect((await add(org.organizer, ev, body)).status, JSON.stringify(body)).toBe(400);
  });

  it('refuses an empty change, a change of kind, and an unknown field (400)', async () => {
    const ev = await createDraft(t, org.organizer);
    const id = (await add(org.organizer, ev, item())).body.data.item.id as string;
    for (const body of [{}, { kind: 'actual' }, { eventId: ev }, { amountMinor: 10.5 }]) {
      expect(
        (await as(t, org.organizer).patch(`/api/events/${ev}/budget/items/${id}`, body)).status,
      ).toBe(400);
    }
  });

  it('stores the text as text', async () => {
    const ev = await createDraft(t, org.organizer);
    const res = await add(
      org.organizer,
      ev,
      item({ description: "<img src=x onerror=alert(1)> ' OR 1=1; --" }),
    );
    expect(res.status).toBe(201);
    expect((await q('SELECT description FROM budget_items'))[0].description).toBe(
      "<img src=x onerror=alert(1)> ' OR 1=1; --",
    );
  });
});

describe('changing and removing items, audited', () => {
  it('updates an item and records exactly what it was and what it became', async () => {
    const ev = await createDraft(t, org.organizer);
    const id = (await add(org.organizer, ev, item({ amountMinor: 50_000 }))).body.data.item
      .id as string;
    const res = await as(t, org.organizer).patch(`/api/events/${ev}/budget/items/${id}`, {
      amountMinor: 75_000,
      category: 'equipment',
      description: 'Projector hire',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.item).toMatchObject({
      amountMinor: 75_000,
      category: 'equipment',
      description: 'Projector hire',
    });
    expect(res.body.data.totals.estimateMinor).toBe(75_000);
    const [log] = await audit('budget.item_updated');
    expect(log.metadata).toMatchObject({
      before: { category: 'venue', amountMinor: 50_000 },
      after: { category: 'equipment', amountMinor: 75_000 },
      afterClose: false,
    });
    expect(log.actor_id).toBe(org.organizer.user.id);
  });

  it('records additions and removals too, with the amount', async () => {
    const ev = await createDraft(t, org.organizer);
    const id = (await add(org.organizer, ev, item({ amountMinor: 123_456 }))).body.data.item
      .id as string;
    expect((await audit('budget.item_added'))[0].metadata).toMatchObject({
      amountMinor: 123_456,
      kind: 'estimate',
      category: 'venue',
    });
    const gone = await as(t, org.organizer).delete(`/api/events/${ev}/budget/items/${id}`);
    expect(gone.status).toBe(200);
    expect(gone.body.data.items).toHaveLength(0);
    expect(gone.body.data.totals.estimateMinor).toBe(0);
    expect((await audit('budget.item_removed'))[0].metadata).toMatchObject({
      amountMinor: 123_456,
    });
    expect((await as(t, org.organizer).delete(`/api/events/${ev}/budget/items/${id}`)).status).toBe(
      404,
    );
  });

  it('changes the date of an expense or clears it, but never puts one on an estimate', async () => {
    const ev = await createDraft(t, org.organizer);
    const actual = (await add(org.organizer, ev, item({ kind: 'actual', spentOn: '2031-03-01' })))
      .body.data.item.id as string;
    const estimate = (await add(org.organizer, ev, item())).body.data.item.id as string;
    const patch = (id: string, body: object) =>
      as(t, org.organizer).patch(`/api/events/${ev}/budget/items/${id}`, body);
    expect((await patch(actual, { spentOn: '2031-03-02' })).body.data.item.spentOn).toBe(
      '2031-03-02',
    );
    expect((await patch(actual, { spentOn: null })).body.data.item.spentOn).toBeNull();
    expect((await patch(estimate, { spentOn: '2031-03-02' })).status).toBe(400);
  });

  it('only the organizer and admins may change or remove', async () => {
    const ev = await createPublishedEvent(t, org);
    const id = (await add(org.organizer, ev, item())).body.data.item.id as string;
    for (const who of [org.hod, org.faculty, org.student, org.otherOrganizer]) {
      expect(
        (await as(t, who).patch(`/api/events/${ev}/budget/items/${id}`, { amountMinor: 1 })).status,
      ).toBe(403);
      expect((await as(t, who).delete(`/api/events/${ev}/budget/items/${id}`)).status).toBe(403);
    }
    expect(
      (await as(t, org.admin).patch(`/api/events/${ev}/budget/items/${id}`, { amountMinor: 1 }))
        .status,
    ).toBe(200);
    expect((await budget(org.organizer, ev)).body.data.totals.estimateMinor).toBe(1);
  });
});

describe('after the event', () => {
  it('still takes expenses once the event is closed, and marks those changes in the audit log', async () => {
    const { ev } = await endedEvent(t, org, ['stayed']);
    await as(t, org.organizer).post(`/api/events/${ev}/close`);
    const res = await add(
      org.organizer,
      ev,
      item({
        kind: 'actual',
        amountMinor: 9_900,
        description: 'Late invoice',
        spentOn: '2031-03-05',
      }),
    );
    expect(res.status).toBe(201);
    expect((await audit('budget.item_added'))[0].metadata).toMatchObject({ afterClose: true });
    const id = res.body.data.item.id as string;
    await as(t, org.organizer).patch(`/api/events/${ev}/budget/items/${id}`, {
      amountMinor: 9_950,
    });
    expect((await audit('budget.item_updated'))[0].metadata).toMatchObject({ afterClose: true });
  });

  it('makes a cancelled event’s budget read-only', async () => {
    const ev = await createPublishedEvent(t, org);
    const id = (await add(org.organizer, ev, item())).body.data.item.id as string;
    await as(t, org.organizer).post(`/api/events/${ev}/cancel`, { comment: 'Called off' });
    const view = await budget(org.organizer, ev);
    expect(view.status).toBe(200);
    expect(view.body.data.can.edit).toBe(false);
    for (const res of [
      await add(org.organizer, ev, item()),
      await as(t, org.organizer).patch(`/api/events/${ev}/budget/items/${id}`, { amountMinor: 1 }),
      await as(t, org.admin).delete(`/api/events/${ev}/budget/items/${id}`),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EVENT_CANCELLED');
    }
    expect(view.body.data.items).toHaveLength(1);
  });
});

describe('limits and the database', () => {
  it('allows at most 200 items per event, even when many arrive at once', async () => {
    const ev = await createDraft(t, org.organizer);
    await q(
      `INSERT INTO budget_items (event_id, kind, category, description, amount_minor, created_by)
       SELECT $1, 'estimate', 'other', 'Filler ' || g, 1, $2 FROM generate_series(1, 195) g`,
      [ev, org.organizer.user.id],
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        add(org.organizer, ev, item({ description: `Late ${i}` })),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(
      results
        .filter((r) => r.status !== 201)
        .every((r) => r.status === 409 && r.body.error.code === 'TOO_MANY_ITEMS'),
    ).toBe(true);
    expect(await q('SELECT 1 FROM budget_items')).toHaveLength(200);
  });

  it('refuses invalid rows however they are written', async () => {
    const ev = await createDraft(t, org.organizer);
    const insert = (
      kind: string,
      category: string,
      description: string,
      amount: number,
      spentOn: string | null = null,
    ) =>
      q(
        'INSERT INTO budget_items (event_id, kind, category, description, amount_minor, spent_on, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [ev, kind, category, description, amount, spentOn, org.organizer.user.id],
      );
    await expect(insert('estimate', 'venue', 'x', -1)).rejects.toMatchObject({
      constraint: 'budget_items_amount_check',
    });
    await expect(insert('estimate', 'venue', 'x', 100_000_000_001)).rejects.toMatchObject({
      constraint: 'budget_items_amount_check',
    });
    await expect(insert('forecast', 'venue', 'x', 1)).rejects.toMatchObject({
      constraint: 'budget_items_kind_check',
    });
    await expect(insert('estimate', 'yachts', 'x', 1)).rejects.toMatchObject({
      constraint: 'budget_items_category_check',
    });
    await expect(insert('estimate', 'venue', '', 1)).rejects.toMatchObject({
      constraint: 'budget_items_description_check',
    });
    await expect(insert('estimate', 'venue', 'x', 1, '2031-03-01')).rejects.toMatchObject({
      constraint: 'budget_items_date_check',
    });
    await insert('actual', 'venue', 'x', 1, '2031-03-01');
  });
});
