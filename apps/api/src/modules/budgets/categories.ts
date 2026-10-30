export const BUDGET_CATEGORIES = [
  'venue',
  'equipment',
  'catering',
  'printing',
  'speakers',
  'prizes',
  'travel',
  'marketing',
  'other',
] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];
export const BUDGET_KINDS = ['estimate', 'actual'] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];
