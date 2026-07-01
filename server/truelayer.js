const axios = require('axios');

const ENV = process.env.TRUELAYER_ENV === 'sandbox' ? 'sandbox' : 'live';
const AUTH_BASE = ENV === 'sandbox' ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com';
const API_BASE = ENV === 'sandbox' ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';

// Step 1: send Sam here to authenticate with Starling and grant consent.
// scopes: info (account details), accounts, balance, transactions, offline_access (refresh token)
function buildAuthUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.TRUELAYER_CLIENT_ID,
    redirect_uri: process.env.TRUELAYER_REDIRECT_URI,
    scope: 'info accounts balance transactions offline_access',
    providers: 'uk-ob-all uk-oauth-all' // covers Starling via Open Banking
  });
  return `${AUTH_BASE}/?${params.toString()}`;
}

// Step 2: exchange the ?code=... from the callback for tokens
async function exchangeCodeForTokens(code) {
  const res = await axios.post(`${AUTH_BASE}/connect/token`, new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.TRUELAYER_CLIENT_ID,
    client_secret: process.env.TRUELAYER_CLIENT_SECRET,
    redirect_uri: process.env.TRUELAYER_REDIRECT_URI,
    code
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return res.data; // { access_token, refresh_token, expires_in, ... }
}

async function refreshAccessToken(refreshToken) {
  const res = await axios.post(`${AUTH_BASE}/connect/token`, new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.TRUELAYER_CLIENT_ID,
    client_secret: process.env.TRUELAYER_CLIENT_SECRET,
    refresh_token: refreshToken
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return res.data;
}

async function getAccounts(accessToken) {
  const res = await axios.get(`${API_BASE}/data/v1/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return res.data.results; // array of { account_id, display_name, currency, ... }
}

// from/to as 'YYYY-MM-DD'. TrueLayer typically supports pulling back 12 months+ depending on the bank —
// Starling via Open Banking generally supports well over 90 days, sufficient for a backdate to 6 April.
async function getTransactions(accessToken, accountId, from, to) {
  const res = await axios.get(
    `${API_BASE}/data/v1/accounts/${accountId}/transactions`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { from, to }
    }
  );
  return res.data.results; // array of { transaction_id, amount, currency, description, timestamp, merchant_name, ... }
}

module.exports = { buildAuthUrl, exchangeCodeForTokens, refreshAccessToken, getAccounts, getTransactions };
