const axios = require('axios');

const API_BASE = 'https://api.starlingbank.com';

function authHeader() {
  return { Authorization: `Bearer ${process.env.STARLING_ACCESS_TOKEN}` };
}

// Starling accounts each have an accountUid and a defaultCategory (categoryUid) —
// both are needed to pull transactions. Most business setups have just one account.
async function getAccounts() {
  const res = await axios.get(`${API_BASE}/api/v2/accounts`, { headers: authHeader() });
  return res.data.accounts; // [{ accountUid, defaultCategory, currency, name, createdAt }]
}

// from/to must be full ISO 8601 timestamps, e.g. 2026-04-06T00:00:00.000Z
// Starling's feed endpoint returns everything in one go — no pagination needed for
// typical volumes, but very long ranges should still be chunked to be safe.
async function getTransactions(accountUid, categoryUid, from, to) {
  const res = await axios.get(
    `${API_BASE}/api/v2/feed/account/${accountUid}/category/${categoryUid}/transactions-between`,
    {
      headers: authHeader(),
      params: { minTransactionTimestamp: from, maxTransactionTimestamp: to }
    }
  );
  return res.data.feedItems; // [{ feedItemUid, amount: {currency, minorUnits}, direction, transactionTime, counterPartyName, reference, status, ... }]
}

module.exports = { getAccounts, getTransactions };
