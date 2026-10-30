-- Up Migration
-- Event budgets: line items for the estimate and for the actual expenses. Money is stored as whole
-- paise (integer minor units of one currency, INR, ASM-3), never as a decimal or a float, so a total
-- is exactly the sum of its items.
CREATE TABLE budget_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events (id),
  kind         text NOT NULL,
  category     text NOT NULL,
  description  text NOT NULL,
  amount_minor bigint NOT NULL,
  -- when an actual expense was paid; estimates have no date
  spent_on     date,
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_items_kind_check CHECK (kind IN ('estimate', 'actual')),
  CONSTRAINT budget_items_category_check CHECK (
    category IN ('venue', 'equipment', 'catering', 'printing', 'speakers', 'prizes', 'travel', 'marketing', 'other')
  ),
  CONSTRAINT budget_items_description_check CHECK (char_length(description) BETWEEN 1 AND 200),
  -- up to 1,000,000,000.00 rupees per item: with at most 200 items an event's total fits a bigint and a JS number exactly
  CONSTRAINT budget_items_amount_check CHECK (amount_minor BETWEEN 0 AND 100000000000),
  CONSTRAINT budget_items_date_check CHECK (kind = 'actual' OR spent_on IS NULL)
);
CREATE INDEX budget_items_event_idx ON budget_items (event_id, kind);

-- Down Migration
DROP TABLE budget_items;
