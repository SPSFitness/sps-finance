require('dotenv').config();
const pool = require('./db');
const { categorizeTransaction } = require('./categorize');

async function run() {
  // Normally only re-checks transactions still flagged for review. Run with FORCE_ALL=true
  // to re-check literally everything — worth doing once after adding a new signal (like
  // Starling's own spending category) so already-categorised transactions can benefit too.
  const forceAll = process.env.FORCE_ALL === 'true';
  const query = forceAll
    ? `SELECT id FROM transactions ORDER BY txn_date`
    : `SELECT id FROM transactions WHERE needs_review = true OR category_id IS NULL ORDER BY txn_date`;

  const { rows } = await pool.query(query);

  console.log(`Found ${rows.length} transaction(s) to (re)categorise${forceAll ? ' (FORCE_ALL mode)' : ''}...`);

  let done = 0;
  for (const row of rows) {
    await categorizeTransaction(row.id);
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${rows.length}...`);
  }

  const { rows: reviewCount } = await pool.query(
    `SELECT COUNT(*) FROM transactions WHERE needs_review = true`
  );
  console.log(`\nDone. ${reviewCount[0].count} transaction(s) still flagged for manual review.`);
  process.exit(0);
}

run().catch(err => {
  console.error('Recategorise failed:', err.response ? err.response.data : err.message);
  process.exit(1);
});
