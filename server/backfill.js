require('dotenv').config();
const pool = require('./db');
const { getAccounts } = require('./starling');
const { ingestForAccount } = require('./ingest');

async function ensureAccountsSynced() {
  const accounts = await getAccounts();
  const saved = [];
  for (const acc of accounts) {
    const { rows } = await pool.query(
      `INSERT INTO accounts (provider_account_id, starling_category_uid, display_name, currency)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider_account_id) DO UPDATE
       SET starling_category_uid = $2, display_name = $3, currency = $4
       RETURNING *`,
      [acc.accountUid, acc.defaultCategory, acc.name || 'Starling Account', acc.currency]
    );
    saved.push(rows[0]);
  }
  return saved;
}

async function run() {
  const fromDate = process.env.TAX_YEAR_START || '2026-04-06';
  const from = `${fromDate}T00:00:00.000Z`;
  const to = new Date().toISOString();

  console.log('Fetching account list from Starling...');
  const accounts = await ensureAccountsSynced();
  console.log(`Found ${accounts.length} account(s): ${accounts.map(a => a.display_name).join(', ')}`);

  // Pull in ~30 day chunks — keeps each request small and makes partial failures easy to retry.
  function chunks(fromStr, toStr) {
    const result = [];
    let cursor = new Date(fromStr);
    const end = new Date(toStr);
    while (cursor < end) {
      const chunkStart = new Date(cursor);
      const chunkEnd = new Date(cursor);
      chunkEnd.setDate(chunkEnd.getDate() + 30);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());
      result.push([chunkStart.toISOString(), chunkEnd.toISOString()]);
      cursor.setDate(cursor.getDate() + 30);
    }
    return result;
  }

  for (const account of accounts) {
    console.log(`Backfilling ${account.display_name} from ${fromDate} to today...`);
    let totalPulled = 0, totalNew = 0, anyFailed = false;

    for (const [chunkFrom, chunkTo] of chunks(from, to)) {
      const result = await ingestForAccount(account, chunkFrom, chunkTo, 'backfill');
      totalPulled += result.pulled;
      totalNew += result.inserted;
      if (result.status === 'failed') anyFailed = true;
      console.log(`  ${chunkFrom.slice(0,10)} to ${chunkTo.slice(0,10)}: pulled ${result.pulled}, new ${result.inserted}, ${result.status}`);
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
  console.error('Backfill failed:', err.response ? err.response.data : err.message);
  process.exit(1);
});
