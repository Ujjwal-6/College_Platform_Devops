import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { as, buildOrg, buildTestApp, resetDb, type LoggedIn, type Org } from './helpers.js';
import { endedEvent } from './aftermath-helpers.js';
import { createPublishedEvent, post, register, students } from './registration-helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const give = (who: LoggedIn, ev: string, body: object) =>
  post(t, who, `/api/events/${ev}/feedback`, body);
const results = (who: LoggedIn, ev: string) => as(t, who).get(`/api/events/${ev}/feedback`);
const mine = (who: LoggedIn, ev: string) => as(t, who).get(`/api/events/${ev}/feedback/mine`);

describe('giving feedback (AC-8.3)', () => {
  it('lets a checked-in person rate the event once the event is over, and audits it without the content', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed']);
    const res = await give(people[0]!, ev, {
      rating: 4,
      comment: 'Great speakers, a bit crowded.',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ submitted: true });
    const [row] = await q('SELECT * FROM feedback WHERE event_id = $1', [ev]);
    expect(row).toMatchObject({
      rating: 4,
      comment: 'Great speakers, a bit crowded.',
      user_id: people[0]!.user.id,
    });
    const logged = await q("SELECT * FROM audit_log WHERE action = 'feedback.submitted'");
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).not.toContain('Great speakers');
    expect(JSON.stringify(logged[0].metadata)).not.toMatch(/rating|comment/);
  });

  it('allows only one per person, by the service and by the database', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed']);
    expect((await give(people[0]!, ev, { rating: 5 })).status).toBe(201);
    const again = await give(people[0]!, ev, { rating: 1, comment: 'Changed my mind' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SUBMITTED');
    expect(await q('SELECT rating FROM feedback')).toEqual([{ rating: 5 }]);
    await expect(
      q('INSERT INTO feedback (event_id, user_id, rating) VALUES ($1, $2, 3)', [
        ev,
        people[0]!.user.id,
      ]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'feedback_event_user_key' });
  });

  it('accepts exactly one when the same person submits many times at once', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed']);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => give(people[0]!, ev, { rating: (i % 5) + 1 })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status !== 201)
        .every((r) => r.body.error.code === 'ALREADY_SUBMITTED'),
    ).toBe(true);
    expect(await q('SELECT 1 FROM feedback')).toHaveLength(1);
  });

  it('is open to anyone who was checked in, even if they left early or never checked out', async () => {
    const { ev, people } = await endedEvent(t, org, ['left_early', 'inside']);
    expect((await give(people[0]!, ev, { rating: 3 })).status).toBe(201);
    expect((await give(people[1]!, ev, { rating: 2 })).status).toBe(201);
  });

  it('is refused (403) to people who were not checked in: absent, cancelled, not registered, waiting', async () => {
    const { ev, people } = await endedEvent(t, org, ['absent', 'cancelled']);
    for (const who of [people[0]!, people[1]!, org.student, org.organizer, org.admin]) {
      const res = await give(who, ev, { rating: 5 });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FEEDBACK_ATTENDEES_ONLY');
    }
    expect(await q('SELECT 1 FROM feedback')).toHaveLength(0);
  });

  it('needs a signed-in user and an event the person can see', async () => {
    const { ev } = await endedEvent(t, org, ['stayed']);
    expect(
      (await request(t.app).post(`/api/events/${ev}/feedback`).send({ rating: 5 })).status,
    ).toBe(401);
    expect((await request(t.app).get(`/api/events/${ev}/feedback/mine`)).status).toBe(401);
    const { createDraft } = await import('./helpers.js');
    const draft = await createDraft(t, org.organizer);
    expect((await give(org.student, draft, { rating: 5 })).status).toBe(404);
    expect(
      (await give(org.student, '11111111-1111-4111-8111-111111111111', { rating: 5 })).status,
    ).toBe(404);
    expect((await give(org.student, 'not-a-uuid', { rating: 5 })).status).toBe(400);
  });

  it('opens when the event ends and closes 14 days later', async () => {
    const ev = await createPublishedEvent(t, org);
    const [sam] = await students(t, 1);
    const reg = await register(t, sam!, ev);
    await q(
      "UPDATE events SET start_at = now() - interval '2 hours', end_at = now() + interval '1 hour' WHERE id = $1",
      [ev],
    );
    await q(
      "INSERT INTO attendance (registration_id, event_id, user_id, checked_in_by, method) VALUES ($1, $2, $3, $4, 'qr')",
      [reg.body.data.id, ev, sam!.user.id, org.organizer.user.id],
    );

    const early = await give(sam!, ev, { rating: 5 }); // the event is still on
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('FEEDBACK_CLOSED');
    expect(early.body.error.details.opensAt).toBeTruthy();
    expect((await mine(sam!, ev)).body.data).toMatchObject({
      eligible: true,
      submitted: false,
      open: false,
    });

    await q(
      "UPDATE events SET start_at = now() - interval '3 hours', end_at = now() - interval '1 minute' WHERE id = $1",
      [ev],
    );
    expect((await mine(sam!, ev)).body.data.open).toBe(true);

    await q(
      "UPDATE events SET start_at = now() - interval '15 days', end_at = now() - interval '14 days 1 minute' WHERE id = $1",
      [ev],
    );
    const late = await give(sam!, ev, { rating: 5 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('FEEDBACK_CLOSED');
  });

  it('is not available for a cancelled event (it is hidden from students)', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed']);
    await q("UPDATE events SET status = 'cancelled' WHERE id = $1", [ev]);
    expect((await give(people[0]!, ev, { rating: 5 })).status).toBe(404);
    expect(await q('SELECT 1 FROM feedback')).toHaveLength(0);
  });

  it('checks the rating and the comment (400)', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed']);
    const bad: object[] = [
      {},
      { rating: 0 },
      { rating: 6 },
      { rating: 3.5 },
      { rating: '4' },
      { rating: null },
      { rating: 4, comment: 'x'.repeat(1001) },
      { rating: 4, comment: 5 },
      { rating: 4, extra: true },
      { rating: 4, userId: 'someone-else' },
    ];
    for (const body of bad)
      expect((await give(people[0]!, ev, body)).status, JSON.stringify(body)).toBe(400);
    expect(await q('SELECT 1 FROM feedback')).toHaveLength(0);
  });

  it('trims the comment and stores no comment when it is empty, and treats it as text', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed', 'stayed']);
    await give(people[0]!, ev, { rating: 4, comment: '   ' });
    await give(people[1]!, ev, { rating: 4, comment: '  <img src=x onerror=alert(1)>  ' });
    const rows = await q('SELECT user_id, comment FROM feedback');
    expect(rows.find((r) => r.user_id === people[0]!.user.id).comment).toBeNull();
    expect(rows.find((r) => r.user_id === people[1]!.user.id).comment).toBe(
      '<img src=x onerror=alert(1)>',
    );
    await expect(
      q("INSERT INTO feedback (event_id, user_id, rating, comment) VALUES ($1, $2, 3, '')", [
        ev,
        org.student.user.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'feedback_comment_check' });
    await expect(
      q('INSERT INTO feedback (event_id, user_id, rating) VALUES ($1, $2, 9)', [
        ev,
        org.student.user.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'feedback_rating_check' });
  });

  it('tells a person whether they may give feedback and whether they already did', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed', 'absent']);
    expect((await mine(people[0]!, ev)).body.data).toMatchObject({
      eligible: true,
      submitted: false,
      open: true,
    });
    await give(people[0]!, ev, { rating: 5 });
    expect((await mine(people[0]!, ev)).body.data).toMatchObject({
      eligible: true,
      submitted: true,
    });
    expect((await mine(people[1]!, ev)).body.data).toMatchObject({
      eligible: false,
      submitted: false,
    });
  });
});

describe('what organizers see', () => {
  const people5 = async () => {
    const e = await endedEvent(t, org, ['stayed', 'stayed', 'stayed', 'stayed', 'stayed']);
    const ratings = [5, 4, 4, 2, 5];
    const comments = ['Loved it', 'Good', undefined, 'Too long', 'Brilliant'];
    for (let i = 0; i < 5; i++)
      await give(
        e.people[i]!,
        e.ev,
        comments[i] ? { rating: ratings[i], comment: comments[i] } : { rating: ratings[i] },
      );
    return e;
  };

  it('shows the count, the average and how the ratings are spread', async () => {
    const { ev } = await people5();
    const res = await results(org.organizer, ev);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ count: 5, average: 4, distribution: [0, 1, 0, 2, 2] });
  });

  it('shows the comments with their rating, and nothing about who wrote them', async () => {
    const { ev, people } = await people5();
    const res = await results(org.organizer, ev);
    const comments = res.body.data.comments as { rating: number; comment: string }[];
    expect(comments.map((c) => c.comment).sort()).toEqual([
      'Brilliant',
      'Good',
      'Loved it',
      'Too long',
    ]);
    expect(comments.find((c) => c.comment === 'Too long')!.rating).toBe(2);
    for (const c of comments) expect(Object.keys(c).sort()).toEqual(['comment', 'rating']);
    const text = JSON.stringify(res.body);
    for (const p of people) {
      expect(text).not.toContain(p.user.id);
      expect(text).not.toContain(p.user.email);
    }
    expect(text).not.toMatch(/created|createdAt|userId|user_id/);
  });

  it('keeps the comments in an order that does not reveal who wrote first', async () => {
    const { ev } = await people5();
    const a = (await results(org.organizer, ev)).body.data.comments;
    const b = (await results(org.admin, ev)).body.data.comments;
    expect(b).toEqual(a); // stable between requests and viewers
    const writtenOrder = (
      await q('SELECT comment FROM feedback WHERE comment IS NOT NULL ORDER BY created_at, id')
    ).map((r) => r.comment);
    expect(a.map((c: { comment: string }) => c.comment)).not.toEqual(
      writtenOrder.length > 1 ? writtenOrder : null,
    );
  });

  it('is for the organizer, the department staff and admins only', async () => {
    const { ev, people } = await people5();
    for (const who of [org.organizer, org.faculty, org.hod, org.admin])
      expect((await results(who, ev)).status).toBe(200);
    for (const who of [
      people[0]!,
      org.student,
      org.otherFaculty,
      org.otherHod,
      org.otherOrganizer,
    ]) {
      expect((await results(who, ev)).status).toBe(403);
    }
    expect((await request(t.app).get(`/api/events/${ev}/feedback`)).status).toBe(401);
  });

  it('shows an empty summary before anyone has answered', async () => {
    const { ev } = await endedEvent(t, org, ['stayed']);
    const res = await results(org.organizer, ev);
    expect(res.body.data).toEqual({
      summary: { count: 0, average: null, distribution: [0, 0, 0, 0, 0] },
      comments: [],
    });
  });
});
