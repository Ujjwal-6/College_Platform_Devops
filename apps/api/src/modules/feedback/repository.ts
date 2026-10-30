import type { Executor } from '../../platform/db.js';

/** Stores one person's feedback. The unique (event_id, user_id) constraint allows only one per person. */
export async function insert(
  db: Executor,
  v: { eventId: string; userId: string; rating: number; comment: string | null },
): Promise<void> {
  await db.query(
    'INSERT INTO feedback (event_id, user_id, rating, comment) VALUES ($1, $2, $3, $4)',
    [v.eventId, v.userId, v.rating, v.comment],
  );
}

export async function exists(db: Executor, eventId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM feedback WHERE event_id = $1 AND user_id = $2', [
    eventId,
    userId,
  ]);
  return rows.length > 0;
}

export interface FeedbackSummary {
  count: number;
  average: number | null;
  /** How many people gave each rating, index 0 = 1 star. */
  distribution: [number, number, number, number, number];
}

export async function summary(db: Executor, eventId: string): Promise<FeedbackSummary> {
  const { rows } = await db.query(
    'SELECT rating, count(*)::int AS n FROM feedback WHERE event_id = $1 GROUP BY rating',
    [eventId],
  );
  const distribution: FeedbackSummary['distribution'] = [0, 0, 0, 0, 0];
  let count = 0;
  let total = 0;
  for (const r of rows) {
    const rating = r.rating as number;
    distribution[rating - 1] = r.n as number;
    count += r.n as number;
    total += rating * (r.n as number);
  }
  return { count, average: count ? Math.round((total / count) * 100) / 100 : null, distribution };
}

/**
 * Comments without any identity. The order is a stable shuffle (by a hash of the row id), not the time
 * they were written, so the order cannot be used to work out who wrote what.
 */
export async function comments(
  db: Executor,
  eventId: string,
): Promise<{ rating: number; comment: string }[]> {
  const { rows } = await db.query(
    `SELECT rating, comment FROM feedback
      WHERE event_id = $1 AND comment IS NOT NULL ORDER BY md5(id::text)`,
    [eventId],
  );
  return rows.map((r) => ({ rating: r.rating as number, comment: r.comment as string }));
}
