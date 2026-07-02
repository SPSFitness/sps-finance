-- 1. How much money is tagged REVENUE by Starling, but where did it actually end up categorised?
SELECT c.name as our_category, c.type, c.hmrc_group,
       COUNT(*) as txn_count, SUM(t.amount) as total
FROM transactions t
LEFT JOIN categories c ON c.id = t.category_id
WHERE t.starling_spending_category = 'REVENUE'
GROUP BY c.name, c.type, c.hmrc_group
ORDER BY total DESC;

-- 2. Any transactions with no category at all (these get silently excluded from every total)
SELECT COUNT(*) as uncategorized_count, SUM(t.amount) as uncategorized_total
FROM transactions t
WHERE t.category_id IS NULL
  AND t.txn_date >= (CURRENT_DATE - INTERVAL '12 months');

-- 3. Total REVENUE-tagged money regardless of how it got categorised, for the rolling 12 months
SELECT COUNT(*) as revenue_txn_count, SUM(t.amount) as revenue_total
FROM transactions t
WHERE t.starling_spending_category = 'REVENUE'
  AND t.txn_date >= (CURRENT_DATE - INTERVAL '12 months');
