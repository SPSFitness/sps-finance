require('dotenv').config();
const pool = require('./db');
const { ingestForAccount } = require('./ingest');

async function run() {
  const from = process.env.TAX_YEAR_START || '2026-04-06';
  const to = new Date().toISOString().slice(0, 10);

  const { rows: accounts } = await pool.query(`SELECT * FROM accounts`);
  if (accounts.length === 0) {
    console.log('No accounts connected yet. Run the /auth flow first to connect Starling via TrueLayer.');
    process.exit(1);
  }

  // Pull in monthly chunks — some banks/Open Banking connections cap how much history
  // a single request returns, so chunking is the safe way to guarantee full coverage back to 6 April.
  function monthChunks(fromStr, toStr) {
    const chunks = [];
    let cursor = new Date(fromStr);
    const end = new Date(toStr);
    while (cursor < end) {
      const chunkStart = new Date(cursor);
      const chunkEnd = new Date(cursor);
      chunkEnd.setDate(chunkEnd.getDate() + 30);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());
      chunks.push([chunkStart.toISOString().slice(0, 10), chunkEnd.toISOString().slice(0, 10)]);
      cursor.setDate(cursor.getDate() + 30);
    }
    return chunks;
  }

  for (const account of accounts) {
    console.log(`Backfilling ${account.display_name} from ${from} to ${to}...`);
    let totalPulled = 0, totalNew = 0, anyFailed = false;

    for (const [chunkFrom, chunkTo] of monthChunks(from, to)) {
      const result = await ingestForAccount(account, chunkFrom, chunkTo, 'backfill');
      totalPulled += result.pulled;
      totalNew += result.inserted;
      if (result.status === 'failed') anyFailed = true;
      console.log(`  ${chunkFrom} to ${chunkTo}: pulled ${result.pulled}, new ${result.inserted}, ${result.status}`);
      if (result.errorMessage) console.log(`    Error: ${result.errorMessage}`);
    }

    console.log(`  Totals for ${account.display_name}: pulled ${totalPulled}, new ${totalNew}${anyFailed ? ' (some chunks failed — check sync_log)' : ''}`);
  }

  const { rows: reviewCount } = await pool.query(
    `SELECT COUNT(*) FROM transactions WHERE needs_review = true`
  );
  console.log(`\nDone. ${reviewCount[0].count} transactions flagged for manual review — check the dashboard.`);
  process.exit(0);
}

run().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
