-- Any transaction Starling itself tagged as REVENUE, but that ended up filed somewhere
-- that ISN'T a trading-income category — this is genuine sales income hiding in the wrong bucket.
SELECT c.name as ended_up_in, c.type, COUNT(*) as txn_count, SUM(t.amount) as total
FROM transactions t
JOIN categories c ON c.id = t.category_id
WHERE t.starling_spending_category = 'REVENUE'
  AND NOT (c.type = 'income' AND c.hmrc_group = 'trading_income')
  AND t.txn_date >= (CURRENT_DATE - INTERVAL '12 months')
GROUP BY c.name, c.type
ORDER BY total DESC;
