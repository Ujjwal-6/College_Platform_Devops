import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { withTx, type Executor } from '../../platform/db.js';
import { errors } from '../../platform/errors.js';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import type { AuthUser } from '../auth/types.js';
import { canView, getEventById, type EventRecord } from '../events/index.js';
import {
  BUDGET_CATEGORIES,
  BUDGET_KINDS,
  type BudgetCategory,
  type BudgetKind,
} from './categories.js';
import * as repo from './repository.js';

const MAX_ITEMS = 200;
export const MAX_AMOUNT_MINOR = 100_000_000_000;

const isoDate = z.string().refine((v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'Use a real date as YYYY-MM-DD');

const amount = z.number().int().min(0).max(MAX_AMOUNT_MINOR);
export const createSchema = z
  .object({
    kind: z.enum(BUDGET_KINDS),
    category: z.enum(BUDGET_CATEGORIES),
    description: z.string().trim().min(1).max(200),
    amountMinor: amount,
    spentOn: isoDate.nullable().optional(),
  })
  .strict();
export const patchSchema = z
  .object({
    category: z.enum(BUDGET_CATEGORIES).optional(),
    description: z.string().trim().min(1).max(200).optional(),
    amountMinor: amount.optional(),
    spentOn: isoDate.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');

const isAdmin = (u: AuthUser) => u.roles.includes('admin');
const isOwner = (u: AuthUser, e: Pick<EventRecord, 'organizerId'>) => e.organizerId === u.id;
/** The organizer and admins keep the budget; the HOD and faculty of the event's department may read it. Nobody else sees it. */
export const canSeeBudget = (u: AuthUser, e: EventRecord) =>
  isAdmin(u) ||
  isOwner(u, e) ||
  ((u.roles.includes('hod') || u.roles.includes('faculty')) &&
    u.departmentId !== null &&
    u.departmentId === e.departmentId);
export const canEditBudget = (u: AuthUser, e: EventRecord) => isAdmin(u) || isOwner(u, e);

async function loadEvent(
  db: Executor,
  user: AuthUser,
  eventId: string,
  lock = false,
): Promise<EventRecord> {
  const event = await getEventById(db, eventId, lock);
  if (!event || !canView(user, event)) throw errors.notFound('Event');
  return event;
}

// ---- totals ------------------------------------------------------------------------------------

export interface CategoryTotal {
  category: BudgetCategory;
  estimateMinor: number;
  actualMinor: number;
  overBudget: boolean;
}
export interface BudgetTotals {
  estimateMinor: number;
  actualMinor: number;
  /** actual minus estimate: positive means money spent above the estimate */
  differenceMinor: number;
  /** Spending is above the estimate. Only a warning: nothing is ever blocked. */
  overBudget: boolean;
  byCategory: CategoryTotal[];
}

/** Builds totals from exact per-category sums. All arithmetic is on integers (whole paise). */
export function summarize(rows: repo.TotalsRow[]): BudgetTotals {
  const by = new Map<BudgetCategory, { estimate: number; actual: number }>();
  for (const r of rows) {
    const cell = by.get(r.category) ?? { estimate: 0, actual: 0 };
    if (r.kind === 'estimate') cell.estimate += r.totalMinor;
    else cell.actual += r.totalMinor;
    by.set(r.category, cell);
  }
  const byCategory: CategoryTotal[] = BUDGET_CATEGORIES.filter((c) => by.has(c)).map((c) => {
    const v = by.get(c)!;
    return {
      category: c,
      estimateMinor: v.estimate,
      actualMinor: v.actual,
      // a category with spending but no estimate counts as over its (zero) estimate
      overBudget: v.actual > v.estimate,
    };
  });
  const estimateMinor = byCategory.reduce((n, c) => n + c.estimateMinor, 0);
  const actualMinor = byCategory.reduce((n, c) => n + c.actualMinor, 0);
  return {
    estimateMinor,
    actualMinor,
    differenceMinor: actualMinor - estimateMinor,
    overBudget: actualMinor > estimateMinor,
    byCategory,
  };
}

export interface ItemView {
  id: string;
  kind: BudgetKind;
  category: BudgetCategory;
  description: string;
  amountMinor: number;
  spentOn: string | null;
  createdAt: string;
  updatedAt: string;
}
const view = (i: repo.BudgetItem): ItemView => ({
  id: i.id,
  kind: i.kind,
  category: i.category,
  description: i.description,
  amountMinor: i.amountMinor,
  spentOn: i.spentOn,
  createdAt: i.createdAt.toISOString(),
  updatedAt: i.updatedAt.toISOString(),
});

async function budgetOf(db: Executor, event: EventRecord, user: AuthUser) {
  const items = await repo.listForEvent(db, event.id);
  const totals = summarize((await repo.totalsForEvents(db, [event.id])).get(event.id) ?? []);
  return {
    currency: 'INR',
    items: items.map(view),
    totals,
    can: { edit: canEditBudget(user, event) && event.status !== 'cancelled' },
    limits: { maxItems: MAX_ITEMS, maxAmountMinor: MAX_AMOUNT_MINOR },
  };
}

export async function getBudget(ctx: AppContext, user: AuthUser, eventId: string) {
  const event = await loadEvent(ctx.pool, user, eventId);
  if (!canSeeBudget(user, event)) throw errors.forbidden();
  return budgetOf(ctx.pool, event, user);
}

// ---- changing it -------------------------------------------------------------------------------

function assertEditable(user: AuthUser, event: EventRecord): void {
  if (!canEditBudget(user, event)) throw errors.forbidden();
  if (event.status === 'cancelled') {
    throw errors.conflict(
      'EVENT_CANCELLED',
      'The budget of a cancelled event can no longer be changed',
    );
  }
}

export async function addItem(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  input: z.infer<typeof createSchema>,
  meta: RequestMeta,
) {
  return withTx(ctx.pool, async (tx) => {
    const event = await loadEvent(tx, user, eventId, true);
    assertEditable(user, event);
    if (input.kind === 'estimate' && input.spentOn) {
      throw errors.validation([{ path: 'spentOn', message: 'An estimate has no date' }]);
    }
    if ((await repo.countForEvent(tx, eventId)) >= MAX_ITEMS) {
      throw errors.conflict('TOO_MANY_ITEMS', `A budget can have at most ${MAX_ITEMS} items`);
    }
    const item = await repo.insert(tx, {
      eventId,
      kind: input.kind,
      category: input.category,
      description: input.description,
      amountMinor: input.amountMinor,
      spentOn: input.spentOn ?? null,
      createdBy: user.id,
    });
    await recordAudit(tx, {
      actorId: user.id,
      action: 'budget.item_added',
      targetType: 'budget_item',
      targetId: item.id,
      metadata: {
        eventId,
        kind: item.kind,
        category: item.category,
        amountMinor: item.amountMinor,
        afterClose: event.status === 'closed',
      },
      ...meta,
    });
    return { item: view(item), ...(await budgetOf(tx, event, user)) };
  });
}

async function loadItem(tx: Executor, eventId: string, itemId: string): Promise<repo.BudgetItem> {
  const item = await repo.findById(tx, itemId);
  if (!item || item.eventId !== eventId) throw errors.notFound('Budget item');
  return item;
}

export async function updateItem(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  itemId: string,
  patch: z.infer<typeof patchSchema>,
  meta: RequestMeta,
) {
  return withTx(ctx.pool, async (tx) => {
    const event = await loadEvent(tx, user, eventId, true);
    assertEditable(user, event);
    const before = await loadItem(tx, eventId, itemId);
    if (before.kind === 'estimate' && patch.spentOn) {
      throw errors.validation([{ path: 'spentOn', message: 'An estimate has no date' }]);
    }
    const after = await repo.update(tx, itemId, {
      category: patch.category ?? before.category,
      description: patch.description ?? before.description,
      amountMinor: patch.amountMinor ?? before.amountMinor,
      spentOn: patch.spentOn === undefined ? before.spentOn : patch.spentOn,
      updatedBy: user.id,
    });
    // "before" and "after" let an auditor see exactly what a changed amount used to be.
    await recordAudit(tx, {
      actorId: user.id,
      action: 'budget.item_updated',
      targetType: 'budget_item',
      targetId: itemId,
      metadata: {
        eventId,
        kind: after.kind,
        before: { category: before.category, amountMinor: before.amountMinor },
        after: { category: after.category, amountMinor: after.amountMinor },
        afterClose: event.status === 'closed',
      },
      ...meta,
    });
    return { item: view(after), ...(await budgetOf(tx, event, user)) };
  });
}

export async function removeItem(
  ctx: AppContext,
  user: AuthUser,
  eventId: string,
  itemId: string,
  meta: RequestMeta,
) {
  return withTx(ctx.pool, async (tx) => {
    const event = await loadEvent(tx, user, eventId, true);
    assertEditable(user, event);
    const before = await loadItem(tx, eventId, itemId);
    await repo.remove(tx, itemId);
    await recordAudit(tx, {
      actorId: user.id,
      action: 'budget.item_removed',
      targetType: 'budget_item',
      targetId: itemId,
      metadata: {
        eventId,
        kind: before.kind,
        category: before.category,
        amountMinor: before.amountMinor,
        afterClose: event.status === 'closed',
      },
      ...meta,
    });
    return budgetOf(tx, event, user);
  });
}
