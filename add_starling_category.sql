-- Adds the column to store Starling's own spending category tag on each transaction,
-- and widens the categorized_by check to allow 'starling' as a source.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS starling_spending_category TEXT;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_categorized_by_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_categorized_by_check
  CHECK (categorized_by IN ('rule', 'ai', 'manual', 'starling'));
