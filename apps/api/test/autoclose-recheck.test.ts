import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import type * as EventsRepo from '../src/modules/events/repository.js';
import { as, buildOrg, buildTestApp, resetDb, type Org } from './helpers.js';
import { createPublishedEvent } from './registration-helpers.js';

// The list of due events is read before each event is locked, so an event can change in between.
// Here the list is forced to contain events that must not be closed.
const forced: { ids: string[] } = { ids: [] };
vi.mock('../src/modules/events/repository.js', async (original) => {
  const real = await original<typeof EventsRepo>();
  return { ...real, listEndedPublished: async () => forced.ids };
});
const { closeEndedEvents } = await import('../src/modules/events/autoclose.js');

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const ctx24: AppContext = { ...t.ctx, config: { ...t.ctx.config, EVENT_AUTO_CLOSE_HOURS: 24 } };

describe('automatic closing re-checks each event once it holds the lock', () => {
  it('skips an event that was closed or cancelled after the list was read, and one not yet due', async () => {
    const closedByHand = await createPublishedEvent(t, org);
    await q(
      "UPDATE events SET start_at = now() - interval '40 hours', end_at = now() - interval '30 hours' WHERE id = $1",
      [closedByHand],
    );
    expect((await as(t, org.organizer).post(`/api/events/${closedByHand}/close`)).status).toBe(200);
    const cancelled = await createPublishedEvent(t, org);
    await q(
      "UPDATE events SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'x' WHERE id = $1",
      [cancelled],
    );
    const notDue = await createPublishedEvent(t, org);
    await q(
      "UPDATE events SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1",
      [notDue],
    );
    const due = await createPublishedEvent(t, org);
    await q(
      "UPDATE events SET start_at = now() - interval '40 hours', end_at = now() - interval '30 hours' WHERE id = $1",
      [due],
    );

    forced.ids = [closedByHand, cancelled, notDue, '11111111-1111-4111-8111-111111111111', due];
    expect(await closeEndedEvents(ctx24)).toBe(1);

    const status = async (id: string) =>
      (await q('SELECT status FROM events WHERE id = $1', [id]))[0].status;
    expect(await status(cancelled)).toBe('cancelled');
    expect(await status(notDue)).toBe('published');
    expect(await status(due)).toBe('closed');
    expect(
      await q("SELECT 1 FROM audit_log WHERE action = 'event.closed' AND target_id = $1", [
        closedByHand,
      ]),
    ).toHaveLength(1);
  });
});
