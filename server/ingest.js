const pool = require('./db');
const { refreshAccessToken, getTransactions } = require('./truelayer');
const { categorizeTransaction } = require('./categorize');

async function getValidAccessToken(account) {
  const expiresAt = new Date(account.token_expires_at);
  if (expiresAt > new Date(Date.now() + 60000)) {
    return account.access_token;
  }
  // Token expired or about to — refresh it
  const tokens = await refreshAccessToken(account.refresh_token);
  const newExpiry = new Date(Date.now() + tokens.expires_in * 1000);
  await pool.query(
    `UPDATE accounts SET access_token = $1, refresh_token = $2, token_expires_at = $3 WHERE id = $4`,
    [tokens.access_token, tokens.refresh_token || account.refresh_token, newExpiry, account.id]
  );
  return tokens.access_token;
}

// Pulls transactions for one account between from/to (YYYY-MM-DD), inserts new ones, categorises them.
async function ingestForAccount(account, from, to, syncType) {
  let pulled = 0;
  let inserted = 0;
  let status = 'success';
  let errorMessage = null;

  try {
    const accessToken = await getValidAccessToken(account);
    const txns = await getTransactions(accessToken, account.provider_account_id, from, to);
    pulled = txns.length;

    for (const t of txns) {
      const result = await pool.query(
        `INSERT INTO transactions (account_id, provider_txn_id, txn_date, amount, currency, description_raw, merchant_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id, provider_txn_id) DO NOTHING
         RETURNING id`,
        [
          account.id,
          t.transaction_id,
          t.timestamp.slice(0, 10),
          t.amount,
          t.currency || 'GBP',
          t.description || '',
          t.merchant_name || null
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
    [account.id, syncType, from, to, pulled, inserted, status, errorMessage]
  );

  return { pulled, inserted, status, errorMessage };
}

module.exports = { ingestForAccount };
