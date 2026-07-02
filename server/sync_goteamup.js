require('dotenv').config();
const pool = require('./db');
const { getPaidInvoiceLineItems } = require('./goteamup');

async function run() {
  console.log('Fetching paid invoice line items from GoTeamUp...');
  const rows = await getPaidInvoiceLineItems();
  console.log(`Found ${rows.length} genuinely paid line items (after filtering out Open/Voided/Upcoming).`);

  let inserted = 0;
  for (const row of rows) {
    // Prefixed "api-" to distinguish from the earlier one-off "seed-" manual import —
    // both can coexist safely since they're keyed by different, non-overlapping IDs.
    const gtuPaymentId = `api-${row.id}`;
    const planName = (row.billed_item && row.billed_item.membership && row.billed_item.membership.name)
      || row.description || row.type;
    const amount = row.amount ? row.amount.decimal : 0;
    const chargedAt = row.invoice.paid_at.slice(0, 10);

    const result = await pool.query(
      `INSERT INTO gtu_payments (gtu_payment_id, plan_name, category, amount, payment_method, charged_at, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (gtu_payment_id) DO NOTHING
       RETURNING id`,
      [gtuPaymentId, planName, row.type || 'other', amount, 'api', chargedAt, JSON.stringify(row)]
    );
    if (result.rows.length > 0) inserted++;
  }

  console.log(`\nDone. ${inserted} new payment record(s) added (duplicates safely skipped).`);
  process.exit(0);
}

run().catch(err => {
  console.error('GoTeamUp sync failed:', err.response ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});
