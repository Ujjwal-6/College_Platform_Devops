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
export type BudgetKind = 'estimate' | 'actual';

export interface BudgetItem {
  id: string;
  kind: BudgetKind;
  category: BudgetCategory;
  description: string;
  amountMinor: number;
  spentOn: string | null;
}
export interface BudgetTotals {
  estimateMinor: number;
  actualMinor: number;
  differenceMinor: number;
  overBudget: boolean;
  byCategory: {
    category: BudgetCategory;
    estimateMinor: number;
    actualMinor: number;
    overBudget: boolean;
  }[];
}
export interface BudgetView {
  currency: 'INR';
  items: BudgetItem[];
  totals: BudgetTotals;
  can: { edit: boolean };
  limits: { maxItems: number; maxAmountMinor: number };
}
