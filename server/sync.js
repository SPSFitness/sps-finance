require('dotenv').config();
const pool = require('./db');
const { ingestForAccount } = require('./ingest');

// Days of overlap to re-pull on each sync. Widened from 7 to 45 so that a missed or failed
// sync run (Render free-tier sleeping, dropped DB connection, etc) still gets caught on any
// subsequent successful run within the next six weeks — rather than the transaction being
// permanently skipped once it ages out of a narrow window. Can be overridden with SYNC_DAYS.
const SYNC_DAYS = Number(process.env.SYNC_DAYS) || 45;

async function run() {
  const to = new Date().toISOString();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - SYNC_DAYS);
  const from = fromDate.toISOString();
  const { rows: accounts } = await pool.query(`SELECT * FROM accounts`);
  for (const account of accounts) {
    const result = await ingestForAccount(account, from, to, 'daily');
    console.log(`[${new Date().toISOString()}] ${account.display_name}: pulled ${result.pulled}, new ${result.inserted}, ${result.status}`);
  }
  process.exit(0);
}
run().catch(err => {
  console.error('Daily sync failed:', err);
  process.exit(1);
});
