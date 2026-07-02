const axios = require('axios');

const API_BASE = 'https://goteamup.com/api/v2';

function authHeader() {
  // GoTeamUp's docs specify the "Token " prefix, not the more common "Bearer " —
  // confirmed by testing directly, since the wrong prefix fails silently with an
  // "expired or invalid" error that looks identical to a genuinely bad token.
  return { Authorization: `Token ${process.env.GOTEAMUP_API_TOKEN}` };
}

// Pulls every invoice line item, following pagination automatically, then filters down
// to only genuinely paid invoices — the raw feed includes Open/Voided/Upcoming Skipped
// rows with £0.00 amounts that aren't real income.
async function getPaidInvoiceLineItems() {
  const columns = 'id,invoice_id,paid_at,amount,type,billed_item,description,customer_name,invoice_status';
  let url = `${API_BASE}/reports/invoice_line_items/data?format=json&columns=${columns}&page_size=100`;
  const allRows = [];

  while (url) {
    const res = await axios.get(url, { headers: authHeader() });
    allRows.push(...res.data.rows);
    url = res.data.next || null;
  }

  return allRows.filter(row => row.invoice && row.invoice.status === 'Paid' && row.invoice.paid_at);
}

module.exports = { getPaidInvoiceLineItems };
