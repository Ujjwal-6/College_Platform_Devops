import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fieldIssues } from '../api/client';
import {
  BUDGET_CATEGORIES,
  type BudgetItem,
  type BudgetKind,
  type BudgetView,
} from '../api/budgetTypes';
import type { EventDetail } from '../api/types';
import { formatMoney, minorToInput, parseRupees } from '../lib/money';

const label = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);

interface Draft {
  id: string | null;
  kind: BudgetKind;
  category: string;
  description: string;
  amount: string;
  spentOn: string;
}
const blank: Draft = {
  id: null,
  kind: 'estimate',
  category: 'venue',
  description: '',
  amount: '',
  spentOn: '',
};

/** The money side of one event: planned and actual costs, the totals, and a warning when spending is above the plan. */
export function EventBudget({ event }: { event: EventDetail }) {
  const [view, setView] = useState<BudgetView | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView((await api<{ data: BudgetView }>(`/events/${event.id}/budget`)).data);
    } catch (err) {
      // faculty and others without access simply do not get this section
      if (!(err instanceof ApiError && err.status === 403)) setError('Could not load the budget.');
    }
  }, [event.id]);
  useEffect(() => void load(), [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      const issues = fieldIssues(err);
      setError(
        issues.length
          ? issues.map((i) => i.message).join(' ')
          : err instanceof ApiError
            ? err.message
            : 'Something went wrong. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const amountMinor = parseRupees(draft.amount);
    if (amountMinor === null) {
      setError('Enter the amount in rupees, for example 1500 or 1500.50.');
      return;
    }
    const body = {
      kind: draft.kind,
      category: draft.category,
      description: draft.description,
      amountMinor,
      ...(draft.kind === 'actual' && draft.spentOn ? { spentOn: draft.spentOn } : {}),
    };
    void run(async () => {
      if (draft.id) {
        const { kind: _kind, ...changes } = body;
        await api(`/events/${event.id}/budget/items/${draft.id}`, {
          method: 'PATCH',
          body: { ...changes, spentOn: draft.kind === 'actual' ? draft.spentOn || null : null },
        });
      } else {
        await api(`/events/${event.id}/budget/items`, { method: 'POST', body });
      }
      setDraft(blank);
    });
  }

  if (!view) {
    return error ? (
      <p role="alert" className="error">
        {error}
      </p>
    ) : null;
  }
  const edit = (i: BudgetItem) =>
    setDraft({
      id: i.id,
      kind: i.kind,
      category: i.category,
      description: i.description,
      amount: minorToInput(i.amountMinor),
      spentOn: i.spentOn ?? '',
    });
  const { totals } = view;

  return (
    <>
      <h2>Budget</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p>
        Planned <strong>{formatMoney(totals.estimateMinor)}</strong> · Spent{' '}
        <strong>{formatMoney(totals.actualMinor)}</strong> · Difference{' '}
        <strong>{formatMoney(totals.differenceMinor)}</strong>
      </p>
      {totals.overBudget && (
        <p role="status" className="notice notice-error">
          Spending is {formatMoney(totals.differenceMinor)} above the planned amount.
        </p>
      )}
      {totals.byCategory.length > 0 && (
        <table aria-label="Budget by category">
          <thead>
            <tr>
              <th>Category</th>
              <th>Planned</th>
              <th>Spent</th>
            </tr>
          </thead>
          <tbody>
            {totals.byCategory.map((c) => (
              <tr key={c.category}>
                <td>{label(c.category)}</td>
                <td>{formatMoney(c.estimateMinor)}</td>
                <td>
                  {formatMoney(c.actualMinor)}
                  {c.overBudget ? ' (above plan)' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table aria-label="Budget items">
        <thead>
          <tr>
            <th>Type</th>
            <th>Category</th>
            <th>Description</th>
            <th>Amount</th>
            <th>Date</th>
            {view.can.edit && <th />}
          </tr>
        </thead>
        <tbody>
          {view.items.map((i) => (
            <tr key={i.id}>
              <td>{i.kind === 'estimate' ? 'Planned' : 'Spent'}</td>
              <td>{label(i.category)}</td>
              <td>{i.description}</td>
              <td>{formatMoney(i.amountMinor)}</td>
              <td>{i.spentOn ?? '—'}</td>
              {view.can.edit && (
                <td>
                  <button disabled={busy} onClick={() => edit(i)}>
                    Edit
                  </button>{' '}
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`/events/${event.id}/budget/items/${i.id}`, {
                          method: 'DELETE',
                        });
                      })
                    }
                  >
                    Remove
                  </button>
                </td>
              )}
            </tr>
          ))}
          {view.items.length === 0 && (
            <tr>
              <td colSpan={view.can.edit ? 6 : 5} className="muted">
                No budget items yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {view.can.edit && (
        <form onSubmit={save} aria-label={draft.id ? 'Edit budget item' : 'Add budget item'}>
          <div className="row">
            <label>
              Type
              <select
                value={draft.kind}
                disabled={draft.id !== null}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as BudgetKind })}
              >
                <option value="estimate">Planned</option>
                <option value="actual">Spent</option>
              </select>
            </label>
            <label>
              Category
              <select
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
              >
                {BUDGET_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {label(c)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Description
              <input
                value={draft.description}
                maxLength={200}
                required
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <label>
              Amount (₹)
              <input
                value={draft.amount}
                inputMode="decimal"
                required
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
              />
            </label>
            {draft.kind === 'actual' && (
              <label>
                Date spent
                <input
                  type="date"
                  value={draft.spentOn}
                  onChange={(e) => setDraft({ ...draft, spentOn: e.target.value })}
                />
              </label>
            )}
          </div>
          <button type="submit" disabled={busy}>
            {draft.id ? 'Save item' : 'Add item'}
          </button>
          {draft.id && (
            <button type="button" disabled={busy} onClick={() => setDraft(blank)}>
              Cancel
            </button>
          )}
        </form>
      )}
    </>
  );
}
