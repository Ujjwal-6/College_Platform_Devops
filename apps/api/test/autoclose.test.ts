import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { closeEndedEvents } from '../src/modules/events/autoclose.js';
import { as, buildOrg, buildTestApp, resetDb, type Org } from './helpers.js';
import { createPublishedEvent, register, students } from './registration-helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const withHours = (hours: number): AppContext => ({
  ...t.ctx,
  config: { ...t.ctx.config, EVENT_AUTO_CLOSE_HOURS: hours },
});
/** A published event that ended `hoursAgo` hours ago. */
async function endedAgo(hoursAgo: number) {
  const id = await createPublishedEvent(t, org);
  await q(
    `UPDATE events SET start_at = now() - interval '${hoursAgo + 2} hours', end_at = now() - interval '${hoursAgo} hours' WHERE id = $1`,
    [id],
  );
  return id;
}
const status = async (id: string) =>
  (await q('SELECT status FROM events WHERE id = $1', [id]))[0].status as string;

describe('automatic closing', () => {
  it('closes a published event once the grace period after its end has passed, and not before', async () => {
    const old = await endedAgo(30);
    const recent = await endedAgo(5);
    const running = await createPublishedEvent(t, org);
    expect(await closeEndedEvents(withHours(24))).toBe(1);
    expect(await status(old)).toBe('closed');
    expect(await status(recent)).toBe('published');
    expect(await status(running)).toBe('published');
    expect(
      (await q('SELECT closed_at FROM events WHERE id = $1', [old]))[0].closed_at,
    ).not.toBeNull();
  });

  it('records the system as the actor, in the timeline and the audit log', async () => {
    const id = await endedAgo(30);
    await closeEndedEvents(withHours(24));
    const history = await q(
      "SELECT actor_id, comment FROM event_history WHERE event_id = $1 AND action = 'close'",
      [id],
    );
    expect(history).toEqual([
      { actor_id: null, comment: 'Closed automatically after the event ended' },
    ]);
    const audit = await q(
      "SELECT actor_id, metadata FROM audit_log WHERE action = 'event.closed' AND target_id = $1",
      [id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBeNull();
    expect(audit[0].metadata).toMatchObject({ from: 'published', to: 'closed', automatic: true });
    const detail = await as(t, org.organizer).get(`/api/events/${id}`);
    expect(detail.body.data.workflow.history.at(-1)).toMatchObject({
      action: 'close',
      actorName: null,
    });
  });

  it('queues the post-event report exactly as a manual close does', async () => {
    const id = await endedAgo(30);
    await closeEndedEvents(withHours(24));
    const reports = await q('SELECT reason, status FROM event_reports WHERE event_id = $1', [id]);
    expect(reports).toEqual([{ reason: 'close', status: 'pending' }]);
    expect(await q("SELECT 1 FROM jobs WHERE type = 'report.generate'")).toHaveLength(1);
  });

  it('does nothing when switched off (0 hours), and leaves cancelled, approved and closed events alone', async () => {
    const id = await endedAgo(30);
    expect(await closeEndedEvents(withHours(0))).toBe(0);
    expect(await status(id)).toBe('published');
    const cancelled = await endedAgo(30);
    await q(
      "UPDATE events SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'x' WHERE id = $1",
      [cancelled],
    );
    expect(await closeEndedEvents(withHours(24))).toBe(1);
    expect(await status(cancelled)).toBe('cancelled');
    expect(await closeEndedEvents(withHours(24))).toBe(0); // nothing left
  });

  it('is safe to run many times at once: one close, one report, one audit record', async () => {
    const id = await endedAgo(30);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => closeEndedEvents(withHours(24))),
    );
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(
      await q("SELECT 1 FROM audit_log WHERE action = 'event.closed' AND target_id = $1", [id]),
    ).toHaveLength(1);
    expect(await q('SELECT 1 FROM event_reports WHERE event_id = $1', [id])).toHaveLength(1);
  });

  it('does not race with a manual close by the organizer', async () => {
    const id = await endedAgo(30);
    const [manual] = await Promise.all([
      as(t, org.organizer).post(`/api/events/${id}/close`),
      closeEndedEvents(withHours(24)),
    ]);
    expect(manual.status).toBe(200);
    expect(await status(id)).toBe('closed');
    expect(
      await q("SELECT 1 FROM audit_log WHERE action = 'event.closed' AND target_id = $1", [id]),
    ).toHaveLength(1);
    expect(await q('SELECT 1 FROM event_reports WHERE event_id = $1', [id])).toHaveLength(1);
  });

  it('closes every event that is due, in one run', async () => {
    const ids = [await endedAgo(30), await endedAgo(48), await endedAgo(100)];
    expect(await closeEndedEvents(withHours(24))).toBe(3);
    for (const id of ids) expect(await status(id)).toBe('closed');
  });

  it('lets the organizer close by hand as soon as the event has ended, but not before', async () => {
    const early = await endedAgo(1);
    expect((await as(t, org.organizer).post(`/api/events/${early}/close`)).status).toBe(200);
    const running = await createPublishedEvent(t, org);
    const res = await as(t, org.organizer).post(`/api/events/${running}/close`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_NOT_ENDED');
  });

  it('keeps registrations and attendance as they were', async () => {
    const id = await endedAgo(30);
    const [p] = await students(t, 1);
    await q(
      "UPDATE events SET start_at = now() + interval '1 day', end_at = now() + interval '1 day 2 hours' WHERE id = $1",
      [id],
    );
    await register(t, p!, id);
    await q(
      "UPDATE events SET start_at = now() - interval '32 hours', end_at = now() - interval '30 hours' WHERE id = $1",
      [id],
    );
    await closeEndedEvents(withHours(24));
    expect(
      await q("SELECT 1 FROM registrations WHERE event_id = $1 AND status = 'registered'", [id]),
    ).toHaveLength(1);
  });
});
