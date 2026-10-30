import type { Executor } from '../../platform/db.js';
import type { BudgetCategory, BudgetKind } from './categories.js';

export interface BudgetItem {
  id: string;
  eventId: string;
  kind: BudgetKind;
  category: BudgetCategory;
  description: string;
  /** Whole paise. */
  amountMinor: number;
  spentOn: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function map(r: Record<string, unknown>): BudgetItem {
  return {
    id: r.id as string,
    eventId: r.event_id as string,
    kind: r.kind as BudgetKind,
    category: r.category as BudgetCategory,
    description: r.description as string,
    // bigint comes back as a string; the table's check keeps every value far below 2^53
    amountMinor: Number(r.amount_minor),
    // read as text by the query: a date-only value must not pass through a JavaScript Date, which
    // would shift it by the machine's time zone
    spentOn: (r.spent_on_text as string | null) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

export async function insert(
  db: Executor,
  v: {
    eventId: string;
    kind: BudgetKind;
    category: BudgetCategory;
    description: string;
    amountMinor: number;
    spentOn: string | null;
    createdBy: string;
  },
): Promise<BudgetItem> {
  const { rows } = await db.query(
    `INSERT INTO budget_items (event_id, kind, category, description, amount_minor, spent_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *, spent_on::text AS spent_on_text`,
    [v.eventId, v.kind, v.category, v.description, v.amountMinor, v.spentOn, v.createdBy],
  );
  return map(rows[0]);
}

export async function findById(db: Executor, id: string): Promise<BudgetItem | null> {
  const { rows } = await db.query(
    'SELECT *, spent_on::text AS spent_on_text FROM budget_items WHERE id = $1',
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function update(
  db: Executor,
  id: string,
  v: {
    category: BudgetCategory;
    description: string;
    amountMinor: number;
    spentOn: string | null;
    updatedBy: string;
  },
): Promise<BudgetItem> {
  const { rows } = await db.query(
    `UPDATE budget_items SET category = $2, description = $3, amount_minor = $4, spent_on = $5,
            updated_by = $6, updated_at = now()
      WHERE id = $1 RETURNING *, spent_on::text AS spent_on_text`,
    [id, v.category, v.description, v.amountMinor, v.spentOn, v.updatedBy],
  );
  return map(rows[0]);
}

export async function remove(db: Executor, id: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM budget_items WHERE id = $1', [id]);
  return rowCount === 1;
}

export async function listForEvent(db: Executor, eventId: string): Promise<BudgetItem[]> {
  const { rows } = await db.query(
    'SELECT *, spent_on::text AS spent_on_text FROM budget_items WHERE event_id = $1 ORDER BY kind, category, created_at, id',
    [eventId],
  );
  return rows.map(map);
}

export async function countForEvent(db: Executor, eventId: string): Promise<number> {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM budget_items WHERE event_id = $1',
    [eventId],
  );
  return rows[0].n as number;
}

export interface TotalsRow {
  kind: BudgetKind;
  category: BudgetCategory;
  /** The exact sum of the items, in whole paise (summed in the database, not in floating point). */
  totalMinor: number;
}

/** Exact sums per kind and category, for one event or several. */
export async function totalsForEvents(
  db: Executor,
  eventIds: string[],
): Promise<Map<string, TotalsRow[]>> {
  const out = new Map<string, TotalsRow[]>();
  if (eventIds.length === 0) return out;
  const { rows } = await db.query(
    `SELECT event_id, kind, category, sum(amount_minor)::text AS total
       FROM budget_items WHERE event_id = ANY($1::uuid[]) GROUP BY event_id, kind, category`,
    [eventIds],
  );
  for (const r of rows) {
    const list = out.get(r.event_id as string) ?? [];
    list.push({
      kind: r.kind as BudgetKind,
      category: r.category as BudgetCategory,
      totalMinor: Number(r.total),
    });
    out.set(r.event_id as string, list);
  }
  return out;
}
