require('dotenv').config();
const pool = require('./db');
const { categorizeTransaction } = require('./categorize');

async function run() {
  const { rows } = await pool.query(
    `SELECT id FROM transactions WHERE needs_review = true OR category_id IS NULL ORDER BY txn_date`
  );

  console.log(`Found ${rows.length} transaction(s) to (re)categorise...`);

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
