require('dotenv').config();
const pool = require('./db');
const { ingestForAccount } = require('./ingest');

async function run() {
  const to = new Date().toISOString();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 7); // 7-day overlap catches anything that settled late
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
