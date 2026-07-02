-- 1. Everything currently counted as taxable trading income, broken down by description pattern.
-- Scan this list for anything that looks like an internal transfer, loan movement, or pot-to-pot
-- shuffle rather than genuine sales/services income.
SELECT description_raw, starling_spending_category, categorized_by,
       COUNT(*) as txn_count, SUM(amount) as total
FROM transactions t
JOIN categories c ON c.id = t.category_id
WHERE c.type = 'income' AND c.hmrc_group = 'trading_income'
  AND t.txn_date >= (CURRENT_DATE - INTERVAL '12 months')
GROUP BY description_raw, starling_spending_category, categorized_by
ORDER BY total DESC
LIMIT 40;

-- 2. Specifically: where do "Loan repayments" and "Truck money" transactions currently sit?
-- These should NEVER be trading income — check whether any have leaked into it.
SELECT t.description_raw, c.name as current_category, c.type, c.hmrc_group,
       t.starling_spending_category, COUNT(*) as txn_count, SUM(t.amount) as total
FROM transactions t
JOIN categories c ON c.id = t.category_id
WHERE (t.description_raw ILIKE '%loan repayment%' OR t.description_raw ILIKE '%truck money%')
  AND t.txn_date >= (CURRENT_DATE - INTERVAL '12 months')
GROUP BY t.description_raw, c.name, c.type, c.hmrc_group, t.starling_spending_category
ORDER BY t.description_raw, total DESC;

-- 3. Total contamination check: how much of the £86k figure is currently made up of
-- "Loan repayments" or "Truck money" specifically sitting in a trading_income category
SELECT COUNT(*) as contaminated_count, SUM(t.amount) as contaminated_total
FROM transactions t
JOIN categories c ON c.id = t.category_id
WHERE (t.description_raw ILIKE '%loan repayment%' OR t.description_raw ILIKE '%truck money%')
  AND c.type = 'income' AND c.hmrc_group = 'trading_income'
  AND t.txn_date >= (CURRENT_DATE - INTERVAL '12 months');
