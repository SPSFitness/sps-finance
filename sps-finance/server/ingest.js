const pool = require('./db');
const { getTransactions } = require('./starling');
const { categorizeTransaction } = require('./categorize');

// Pulls transactions for one account between from/to (ISO 8601 timestamps), inserts new ones, categorises them.
async function ingestForAccount(account, from, to, syncType) {
  let pulled = 0;
  let inserted = 0;
  let status = 'success';
  let errorMessage = null;

  try {
    const items = await getTransactions(account.provider_account_id, account.starling_category_uid, from, to);
    pulled = items.length;

    for (const item of items) {
      // Starling includes pending/upcoming items — only ingest settled ones to keep totals accurate
      if (item.status !== 'SETTLED') continue;

      const amount = (item.amount.minorUnits / 100) * (item.direction === 'OUT' ? -1 : 1);
      const description = item.reference || item.counterPartyName || '';

      const result = await pool.query(
        `INSERT INTO transactions (account_id, provider_txn_id, txn_date, amount, currency, description_raw, merchant_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id, provider_txn_id) DO NOTHING
         RETURNING id`,
        [
          account.id,
          item.feedItemUid,
          item.transactionTime.slice(0, 10),
          amount,
          item.amount.currency,
          description,
          item.counterPartyName || null
        ]
      );
      if (result.rows.length > 0) {
        inserted++;
        await categorizeTransaction(result.rows[0].id);
      }
    }
  } catch (err) {
    status = pulled > 0 ? 'partial' : 'failed';
    errorMessage = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error(`Ingest failed for account ${account.id}:`, errorMessage);
  }

  await pool.query(
    `INSERT INTO sync_log (account_id, sync_type, from_date, to_date, txns_pulled, txns_new, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [account.id, syncType, from.slice(0, 10), to.slice(0, 10), pulled, inserted, status, errorMessage]
  );

  return { pulled, inserted, status, errorMessage };
}

module.exports = { ingestForAccount };
