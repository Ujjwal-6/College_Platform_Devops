/**
 * Public surface of the budgets module, for features that summarise money (analytics, reports).
 * Import from here, not from the module's internals. See docs/budget-analytics-design.md.
 */
export { totalsForEvents as budgetTotalsForEvents } from './repository.js';
export { canSeeBudget, summarize as summarizeBudget, type BudgetTotals } from './service.js';
