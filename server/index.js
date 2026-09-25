require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const pool = require('./db');
const { ingestForAccount } = require('./ingest');
const { exec } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Simple shared-secret check for anything sensitive.
function requireAuth(req, res, next) {
  const key = req.query.key || req.headers['x-app-secret'];
  if (key !== process.env.APP_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// How many days each sync re-pulls. Widened from 7 to 45 so a missed/failed run still gets
// caught on the next successful sync rather than the transaction being permanently skipped
// once it ages out of a narrow window.
const SYNC_DAYS = Number(process.env.SYNC_DAYS) || 45;

const { getPaidInvoiceLineItems } = require('./goteamup');

// Shared GoTeamUp refresh logic, used by both the normal sync and the deep catch-up.
async function refreshGoTeamUp() {
  if (!process.env.GOTEAMUP_API_TOKEN) return null;
  try {
    const gtuRows = await getPaidInvoiceLineItems();
    let gtuInserted = 0;
    for (const row of gtuRows) {
      const gtuPaymentId = `api-${row.id}`;
      const planName = (row.billed_item && row.billed_item.membership && row.billed_item.membership.name)
        || row.description || row.type;
      const amount = row.amount ? row.amount.decimal : 0;
      const chargedAt = row.invoice.paid_at.slice(0, 10);
      const insertResult = await pool.query(
        `INSERT INTO gtu_payments (gtu_payment_id, plan_name, category, amount, payment_method, charged_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (gtu_payment_id) DO NOTHING
         RETURNING id`,
        [gtuPaymentId, planName, row.type || 'other', amount, 'api', chargedAt, JSON.stringify(row)]
      );
      if (insertResult.rows.length > 0) gtuInserted++;
    }
    return { checked: gtuRows.length, inserted: gtuInserted };
  } catch (gtuErr) {
    return { error: gtuErr.message };
  }
}

// Normal "Sync Now" — re-pulls the last SYNC_DAYS (45) of bank transactions plus GoTeamUp.
app.post('/api/sync-now', requireAuth, async (req, res) => {
  try {
    const { rows: accounts } = await pool.query(`SELECT * FROM accounts`);
    const to = new Date().toISOString();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - SYNC_DAYS);
    const from = fromDate.toISOString();

    const results = [];
    for (const account of accounts) {
      const result = await ingestForAccount(account, from, to, 'daily');
      results.push({ account: account.display_name, ...result });
    }

    const gtuResult = await refreshGoTeamUp();
    res.json({ ok: true, results, gtuResult });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Deep catch-up — re-pulls a much wider window (default 90 days, overridable via ?days=N up to
// 400) to recover transactions that were permanently missed during past sync failures. Safe to
// run any time: existing transactions are skipped, only genuinely-missing ones get inserted.
// Uses app.all so it can be triggered by simply visiting the URL in a browser (GET) as well as POST.
app.all('/api/catch-up', requireAuth, async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 90, 400);
    const { rows: accounts } = await pool.query(`SELECT * FROM accounts`);
    const to = new Date().toISOString();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    const from = fromDate.toISOString();

    const results = [];
    for (const account of accounts) {
      const result = await ingestForAccount(account, from, to, 'catchup');
      results.push({ account: account.display_name, ...result });
    }

    const gtuResult = await refreshGoTeamUp();
    res.json({ ok: true, daysScanned: days, results, gtuResult });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// VAT threshold check — always the true rolling 12 months from today, independent of
// whatever date range the dashboard is currently showing. This is what HMRC actually checks.
app.get('/api/vat-check', requireAuth, async (req, res) => {
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date();
  fromDate.setFullYear(fromDate.getFullYear() - 1);
  const from = fromDate.toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(t.amount), 0) as total
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE c.type = 'income' AND c.hmrc_group = 'trading_income'
       AND t.txn_date BETWEEN $1 AND $2`,
    [from, to]
  );

  const threshold = 90000;
  const total = Number(rows[0].total);

  const { rows: monthlyRows } = await pool.query(
    `SELECT to_char(date_trunc('month', t.txn_date), 'YYYY-MM') as month, SUM(t.amount) as total
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE c.type = 'income' AND c.hmrc_group = 'trading_income'
       AND t.txn_date >= (CURRENT_DATE - INTERVAL '16 months')
       AND date_trunc('month', t.txn_date) < date_trunc('month', CURRENT_DATE)
     GROUP BY month
     ORDER BY month ASC`
  );

  let projection = null;
  if (monthlyRows.length >= 13) {
    const monthTotals = monthlyRows.map(r => Number(r.total));
    const recent3 = monthTotals.slice(-3);
    const rollingOff3 = monthTotals.slice(-13, -10);
    const avgRecent = recent3.reduce((a, b) => a + b, 0) / recent3.length;
    const avgRollingOff = rollingOff3.length === 3 ? rollingOff3.reduce((a, b) => a + b, 0) / rollingOff3.length : null;

    if (avgRollingOff !== null) {
      const netMonthlyChange = avgRecent - avgRollingOff;
      if (netMonthlyChange > 0 && total < threshold) {
        const monthsToThreshold = Math.ceil((threshold - total) / netMonthlyChange);
        const projectedDate = new Date();
        projectedDate.setMonth(projectedDate.getMonth() + monthsToThreshold);
        projection = {
          trending: 'up',
          netMonthlyChange,
          monthsToThreshold,
          projectedDate: projectedDate.toISOString().slice(0, 10)
        };
      } else if (netMonthlyChange <= 0) {
        projection = { trending: total >= threshold ? 'over' : 'flat-or-down', netMonthlyChange };
      }
    }
  }

  const now = new Date();
  const daysElapsedInMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const currentMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const { rows: currentMonthRows } = await pool.query(
    `SELECT COALESCE(SUM(t.amount), 0) as total
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE c.type = 'income' AND c.hmrc_group = 'trading_income'
       AND t.txn_date >= $1`,
    [currentMonthStart]
  );

  const monthActualSoFar = Number(currentMonthRows[0].total);

  let monthGtuActual = null;
  try {
    const { rows: gtuMonthRows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM gtu_payments WHERE charged_at >= $1`,
      [currentMonthStart]
    );
    monthGtuActual = Number(gtuMonthRows[0].total);
  } catch (err) {
    monthGtuActual = null;
  }

  const projectionBasis = (monthGtuActual !== null && monthGtuActual > monthActualSoFar) ? monthGtuActual : monthActualSoFar;
  const usingGtuBasis = projectionBasis === monthGtuActual && monthGtuActual > monthActualSoFar;

  const dailyRate = daysElapsedInMonth > 0 ? projectionBasis / daysElapsedInMonth : 0;
  const projectedMonthTotal = dailyRate * daysInMonth;
  const projectedRollingTotal = total - monthActualSoFar + projectedMonthTotal;

  const currentMonthProjection = {
    daysElapsedInMonth,
    daysInMonth,
    monthActualSoFar,
    monthGtuActual,
    usingGtuBasis,
    projectedMonthTotal,
    projectedRollingTotal,
    projectedOverThreshold: projectedRollingTotal >= threshold,
    lowConfidence: daysElapsedInMonth < 7
  };

  let gtuComparison = null;
  try {
    const { rows: gtuRows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as txn_count,
              MIN(charged_at) as earliest, MAX(charged_at) as latest
       FROM gtu_payments
       WHERE charged_at BETWEEN $1 AND $2`,
      [from, to]
    );
    const gtuTotal = Number(gtuRows[0].total);
    gtuComparison = {
      gtuTotal,
      txnCount: Number(gtuRows[0].txn_count),
      earliest: gtuRows[0].earliest,
      latest: gtuRows[0].latest,
      differenceFromBank: gtuTotal - total,
      gtuOverThreshold: gtuTotal >= threshold
    };
  } catch (err) {
    gtuComparison = null;
  }

  res.json({
    rollingTotal: total,
    threshold,
    remaining: threshold - total,
    periodFrom: from,
    periodTo: to,
    projection,
    currentMonthProjection,
    gtuComparison
  });
});

app.get('/api/monthly-summary', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  const { rows } = await pool.query(
    `SELECT
       to_char(date_trunc('month', t.txn_date), 'YYYY-MM') as month,
       c.id as category_id, c.name, c.type, SUM(t.amount) as total, COUNT(*) as txn_count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.txn_date BETWEEN $1 AND $2
     GROUP BY month, c.id, c.name, c.type
     ORDER BY month DESC, c.type, total DESC`,
    [from, to]
  );
  res.json(rows);
});

app.get('/api/summary', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  const { rows } = await pool.query(
    `SELECT c.id as category_id, c.name, c.type, SUM(t.amount) as total, COUNT(*) as txn_count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.txn_date BETWEEN $1 AND $2
     GROUP BY c.id, c.name, c.type
     ORDER BY c.type, total DESC`,
    [from, to]
  );
  res.json(rows);
});

app.get('/api/transactions-by-category', requireAuth, async (req, res) => {
  const { category_id, from, to } = req.query;
  const { rows } = await pool.query(
    `SELECT id, txn_date, description_raw, merchant_name, amount, category_id, categorized_by, category_confidence, starling_spending_category
     FROM transactions
     WHERE category_id = $1 AND txn_date BETWEEN $2 AND $3
     ORDER BY txn_date DESC`,
    [category_id, from, to]
  );
  res.json(rows);
});

app.get('/api/review', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, c.name as category_name FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.needs_review = true
     ORDER BY t.txn_date DESC`
  );
  res.json(rows);
});

app.post('/api/review/accept-all', requireAuth, async (req, res) => {
  const result = await pool.query(
    `UPDATE transactions SET needs_review = false WHERE needs_review = true RETURNING id`
  );
  res.json({ ok: true, cleared: result.rows.length });
});

app.post('/api/transactions/:id/category', requireAuth, async (req, res) => {
  const { category_id, create_rule, apply_to_similar } = req.body;

  const { rows: txnRows } = await pool.query(`SELECT * FROM transactions WHERE id = $1`, [req.params.id]);
  const txn = txnRows[0];
  if (!txn) return res.status(404).json({ error: 'not found' });

  await pool.query(
    `UPDATE transactions SET category_id = $1, categorized_by = 'manual', needs_review = false WHERE id = $2`,
    [category_id, req.params.id]
  );

  if (apply_to_similar && txn.description_raw) {
    await pool.query(
      `UPDATE transactions SET category_id = $1, categorized_by = 'manual', needs_review = false
       WHERE description_raw = $2 AND id != $3`,
      [category_id, txn.description_raw, req.params.id]
    );
  }

  if (create_rule && txn.description_raw) {
    await pool.query(
      `INSERT INTO category_rules (category_id, match_type, match_value, priority)
       VALUES ($1, 'description_contains', $2, 20)`,
      [category_id, txn.description_raw.toLowerCase()]
    );
  }

  res.json({ ok: true });
});

app.get('/report/profit-loss', async (req, res) => {
  const { from, to, key } = req.query;
  if (key !== process.env.APP_SECRET) return res.status(401).send('Unauthorized');

  const { rows } = await pool.query(
    `SELECT c.name, c.type, SUM(t.amount) as total, COUNT(*) as txn_count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.txn_date BETWEEN $1 AND $2
     GROUP BY c.name, c.type
     ORDER BY c.type, total DESC`,
    [from, to]
  );

  const income = rows.filter(r => r.type === 'income');
  const expenses = rows.filter(r => r.type === 'expense');
  const totalIncome = income.reduce((s, r) => s + Number(r.total), 0);
  const totalExpense = expenses.reduce((s, r) => s + Math.abs(Number(r.total)), 0);
  const net = totalIncome - totalExpense;
  const fmt = (n) => (n < 0 ? '-£' : '£') + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rowsHtml = (arr, isExpense) => arr.map(r =>
    `<tr><td>${r.name}</td><td style="text-align:right">${r.txn_count}</td><td style="text-align:right">${fmt(isExpense ? Math.abs(Number(r.total)) : Number(r.total))}</td></tr>`
  ).join('');

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Profit & Loss — SPS Fitness</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; max-width: 800px; margin: 40px auto; color: #0b0b0f; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 30px; }
  h2 { font-size: 15px; border-bottom: 2px solid #0b0b0f; padding-bottom: 6px; margin-top: 30px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #6b7280; padding: 6px 4px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 6px 4px; border-bottom: 1px solid #f1f3f5; }
  .total-row td { font-weight: 700; border-top: 2px solid #0b0b0f; border-bottom: none; padding-top: 10px; }
  .net-row td { font-weight: 700; font-size: 16px; padding-top: 16px; }
  .print-btn { position: fixed; top: 20px; right: 20px; background: #1a4dff; color: white; border: none; padding: 10px 18px; border-radius: 6px; font-weight: 600; cursor: pointer; }
  @media print { .print-btn { display: none; } }
</style></head>
<body>
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <h1>SPS Fitness — Profit & Loss</h1>
  <div class="sub">Period: ${from} to ${to} · Generated ${new Date().toLocaleDateString('en-GB')}</div>

  <h2>Income</h2>
  <table><thead><tr><th>Category</th><th style="text-align:right">Transactions</th><th style="text-align:right">Amount</th></tr></thead>
  <tbody>${rowsHtml(income, false)}<tr class="total-row"><td>Total Income</td><td></td><td style="text-align:right">${fmt(totalIncome)}</td></tr></tbody></table>

  <h2>Expenses</h2>
  <table><thead><tr><th>Category</th><th style="text-align:right">Transactions</th><th style="text-align:right">Amount</th></tr></thead>
  <tbody>${rowsHtml(expenses, true)}<tr class="total-row"><td>Total Expenses</td><td></td><td style="text-align:right">${fmt(totalExpense)}</td></tr></tbody></table>

  <table><tbody><tr class="net-row"><td>Net Profit</td><td></td><td style="text-align:right; color:${net >= 0 ? '#0f9d58' : '#d93025'}">${fmt(net)}</td></tr></tbody></table>
</body></html>`);
});

// VAT estimate report (Flat Rate Scheme). Bank-deposit basis — money actually received, matching
// the previous QuickBooks / cash-accounting setup. Shows gross trading income per month with the
// flat-rate VAT at BOTH 8.5% and 16.5% side by side, plus a running total, so whichever rate the
// accountant confirms the figure is ready. Set ?from= to the effective registration date for the
// true "set aside" figure. Optional ?rate= (e.g. 0.075) overrides the headline 8.5% rate.
app.get('/report/vat', async (req, res) => {
  const { from, to, key, rate } = req.query;
  if (key !== process.env.APP_SECRET) return res.status(401).send('Unauthorized');

  const fromDate = from || '2026-04-06';
  const toDate = to || new Date().toISOString().slice(0, 10);
  const headlineRate = rate ? Number(rate) : 0.085;

  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', t.txn_date), 'YYYY-MM') as month,
            SUM(t.amount) as gross_income, COUNT(*) as txn_count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE c.type = 'income' AND c.hmrc_group = 'trading_income'
       AND t.txn_date BETWEEN $1 AND $2
     GROUP BY month
     ORDER BY month ASC`,
    [fromDate, toDate]
  );

  const fmt = (n) => (n < 0 ? '-£' : '£') + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (headlineRate * 100).toLocaleString('en-GB', { maximumFractionDigits: 2 });

  let totalGross = 0;
  let running = 0;
  const bodyRows = rows.map(r => {
    const gross = Number(r.gross_income);
    totalGross += gross;
    running += gross;
    return `<tr>
      <td>${r.month}</td>
      <td style="text-align:right">${r.txn_count}</td>
      <td style="text-align:right">${fmt(gross)}</td>
      <td style="text-align:right">${fmt(gross * headlineRate)}</td>
      <td style="text-align:right; color:#6b7280">${fmt(gross * 0.165)}</td>
      <td style="text-align:right; font-weight:600">${fmt(running * headlineRate)}</td>
    </tr>`;
  }).join('');

  const totalVatHeadline = totalGross * headlineRate;
  const totalVat165 = totalGross * 0.165;

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>VAT Estimate — SPS Fitness</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; max-width: 900px; margin: 40px auto; color: #0b0b0f; padding: 0 20px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; color: #6b7280; padding: 8px 6px; border-bottom: 2px solid #0b0b0f; }
  td { padding: 8px 6px; border-bottom: 1px solid #f1f3f5; }
  .total-row td { font-weight: 700; border-top: 2px solid #0b0b0f; border-bottom: none; padding-top: 12px; font-size: 14px; }
  .headline { background: #f8f9ff; border: 1px solid #dce3ff; border-radius: 10px; padding: 20px; margin: 20px 0; }
  .headline .big { font-size: 28px; font-weight: 800; color: #1a4dff; }
  .headline .lbl { font-size: 12px; text-transform: uppercase; color: #6b7280; font-weight: 600; letter-spacing: 0.04em; }
  .notes { font-size: 12px; color: #6b7280; line-height: 1.6; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 16px; }
  .notes strong { color: #0b0b0f; }
  .print-btn { position: fixed; top: 20px; right: 20px; background: #1a4dff; color: white; border: none; padding: 10px 18px; border-radius: 6px; font-weight: 600; cursor: pointer; }
  .warn { background: #fff4e5; border: 1px solid #ffd699; border-radius: 8px; padding: 12px 16px; font-size: 12px; color: #92600a; margin: 16px 0; line-height: 1.5; }
  @media print { .print-btn { display: none; } body { max-width: none; } }
</style></head>
<body>
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <h1>SPS Fitness — VAT Estimate (Flat Rate Scheme)</h1>
  <div class="sub">Period: ${fromDate} to ${toDate} · Generated ${new Date().toLocaleDateString('en-GB')} · Bank-deposit basis (money received)</div>

  <div class="headline">
    <div class="lbl">Estimated VAT to set aside at ${pct}% (flat rate, bank basis)</div>
    <div class="big">${fmt(totalVatHeadline)}</div>
    <div style="font-size:12px; color:#6b7280; margin-top:6px;">on gross trading income of ${fmt(totalGross)} · at 16.5% this would be ${fmt(totalVat165)}</div>
  </div>

  <div class="warn">
    <strong>For the accountant to confirm:</strong> this uses ${pct}% on a bank-deposit (cash) basis, matching the previous QuickBooks setup.
    If the Limited Cost Trader rule applies (low goods spend), the rate would be 16.5% — that column is shown alongside so the figure is ready either way.
    VAT is only owed from the effective registration date onward — set the "from" date to that date (once HMRC confirms it) to get the true set-aside figure.
  </div>

  <table>
    <thead><tr>
      <th>Month</th>
      <th style="text-align:right">Transactions</th>
      <th style="text-align:right">Gross Income (banked)</th>
      <th style="text-align:right">VAT @ ${pct}%</th>
      <th style="text-align:right">VAT @ 16.5%</th>
      <th style="text-align:right">Running VAT @ ${pct}%</th>
    </tr></thead>
    <tbody>
      ${bodyRows}
      <tr class="total-row">
        <td>TOTAL</td><td></td>
        <td style="text-align:right">${fmt(totalGross)}</td>
        <td style="text-align:right">${fmt(totalVatHeadline)}</td>
        <td style="text-align:right; color:#6b7280">${fmt(totalVat165)}</td>
        <td style="text-align:right">${fmt(totalVatHeadline)}</td>
      </tr>
    </tbody>
  </table>

  <div class="notes">
    <strong>Basis of this report:</strong><br>
    • <strong>Bank-deposit basis</strong> — counts income when it actually landed in the bank (net of Stripe/GoCardless fees), matching the previous QuickBooks / cash-accounting approach.<br>
    • <strong>Trading income only</strong> — memberships, PT, retreats, clothing, etc. Excludes owner drawings, transfers between accounts, and loan repayments, none of which are VAT-able turnover.<br>
    • <strong>Flat Rate Scheme</strong> — VAT owed is simply a flat percentage of gross turnover; you do not reclaim VAT on purchases (except single capital assets over £2,000).<br>
    • <strong>This is an estimate to aid setting funds aside and to hand to your accountant</strong> — not a filed VAT return. Your accountant confirms the correct rate, registration date, and quarter cycle.
  </div>
</body></html>`);
});


// Walks every month-end and computes the rolling 12-month trading-income total ending that
// month, on BOTH bank basis (transactions) and GoTeamUp basis (gtu_payments). Flags the first
// month each basis exceeds £90,000, and applies HMRC's registration rule: you must register by
// the 1st of the SECOND month after the month you breached, and that 1st is your effective date.
app.get('/report/vat-breach', async (req, res) => {
  const { key } = req.query;
  if (key !== process.env.APP_SECRET) return res.status(401).send('Unauthorized');

  const THRESHOLD = 90000;

  // Bank basis: trading income per calendar month
  const { rows: bankMonths } = await pool.query(
    `SELECT to_char(date_trunc('month', t.txn_date), 'YYYY-MM') as month, SUM(t.amount) as total
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE c.type = 'income' AND c.hmrc_group = 'trading_income'
     GROUP BY month ORDER BY month ASC`
  );

  // GoTeamUp basis: charges per calendar month (may not exist — handle gracefully)
  let gtuMonths = [];
  try {
    const r = await pool.query(
      `SELECT to_char(date_trunc('month', charged_at), 'YYYY-MM') as month, SUM(amount) as total
       FROM gtu_payments GROUP BY month ORDER BY month ASC`
    );
    gtuMonths = r.rows;
  } catch (e) { gtuMonths = []; }

  // Build a unified sorted list of all months present in either dataset
  const monthSet = new Set([...bankMonths.map(r => r.month), ...gtuMonths.map(r => r.month)]);
  const months = [...monthSet].sort();

  const bankMap = Object.fromEntries(bankMonths.map(r => [r.month, Number(r.total)]));
  const gtuMap = Object.fromEntries(gtuMonths.map(r => [r.month, Number(r.total)]));

  // Rolling 12-month total ending at each month (inclusive of that month and 11 before)
  function rolling12(map, endMonth) {
    const [y, m] = endMonth.split('-').map(Number);
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      let mm = m - i, yy = y;
      while (mm <= 0) { mm += 12; yy -= 1; }
      const key = `${yy}-${String(mm).padStart(2, '0')}`;
      sum += (map[key] || 0);
    }
    return sum;
  }

  // Effective registration date from a breach month: 1st of the 2nd month after it
  function effectiveDate(breachMonth) {
    const [y, m] = breachMonth.split('-').map(Number);
    let mm = m + 2, yy = y;
    while (mm > 12) { mm -= 12; yy += 1; }
    return `${yy}-${String(mm).padStart(2, '0')}-01`;
  }

  const fmt = (n) => (n < 0 ? '-£' : '£') + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let bankBreach = null, gtuBreach = null;
  const rowsHtml = months.map(month => {
    const bankRoll = rolling12(bankMap, month);
    const gtuRoll = rolling12(gtuMap, month);
    if (!bankBreach && bankRoll > THRESHOLD) bankBreach = month;
    if (!gtuBreach && gtuRoll > THRESHOLD) gtuBreach = month;
    const bankOver = bankRoll > THRESHOLD;
    const gtuOver = gtuRoll > THRESHOLD;
    const bankFirst = bankBreach === month;
    const gtuFirst = gtuBreach === month;
    return `<tr${(bankFirst || gtuFirst) ? ' style="background:#fff4e5"' : ''}>
      <td>${month}</td>
      <td style="text-align:right; ${bankOver ? 'color:#d93025;font-weight:700' : ''}">${fmt(bankRoll)}${bankFirst ? ' ⚠️' : ''}</td>
      <td style="text-align:right; ${gtuOver ? 'color:#d93025;font-weight:700' : 'color:#6b7280'}">${gtuRoll > 0 ? fmt(gtuRoll) : '—'}${gtuFirst ? ' ⚠️' : ''}</td>
    </tr>`;
  }).join('');

  const bankResult = bankBreach
    ? `Bank basis crossed £90k at end of <strong>${bankBreach}</strong> → register effective <strong>${effectiveDate(bankBreach)}</strong>`
    : `Bank basis has not crossed £90k in the data held.`;
  const gtuResult = gtuBreach
    ? `GoTeamUp basis crossed £90k at end of <strong>${gtuBreach}</strong> → register effective <strong>${effectiveDate(gtuBreach)}</strong>`
    : `GoTeamUp basis has not crossed £90k in the data held.`;

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>VAT Threshold Breach — SPS Fitness</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; max-width: 780px; margin: 40px auto; color: #0b0b0f; padding: 0 20px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; color: #6b7280; padding: 8px 6px; border-bottom: 2px solid #0b0b0f; }
  td { padding: 8px 6px; border-bottom: 1px solid #f1f3f5; }
  .result { background: #f8f9ff; border: 1px solid #dce3ff; border-radius: 10px; padding: 16px 20px; margin: 8px 0; font-size: 14px; line-height: 1.7; }
  .notes { font-size: 12px; color: #6b7280; line-height: 1.6; margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 16px; }
  .notes strong { color: #0b0b0f; }
  .print-btn { position: fixed; top: 20px; right: 20px; background: #1a4dff; color: white; border: none; padding: 10px 18px; border-radius: 6px; font-weight: 600; cursor: pointer; }
  @media print { .print-btn { display: none; } body { max-width: none; } }
</style></head>
<body>
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <h1>SPS Fitness — VAT Threshold Breach Analysis</h1>
  <div class="sub">Rolling 12-month trading income at each month-end · Generated ${new Date().toLocaleDateString('en-GB')} · Threshold £90,000</div>

  <div class="result">${bankResult}</div>
  <div class="result">${gtuResult}</div>

  <table>
    <thead><tr>
      <th>Month end</th>
      <th style="text-align:right">Rolling 12mth — Bank basis</th>
      <th style="text-align:right">Rolling 12mth — GoTeamUp basis</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>

  <div class="notes">
    <strong>How to read this:</strong> each row is the total trading income for the 12 months ending that month.
    The ⚠️ marks the first month each basis exceeded £90,000. Figures in red are over the threshold.<br><br>
    <strong>HMRC registration rule applied:</strong> if you breach at the end of a given month, you must register by the 1st of the second month after — and that date becomes your effective registration date (the date VAT liability starts).<br><br>
    <strong>Bank basis</strong> matches the previous QuickBooks / cash-accounting approach and is the more likely basis for assessment. <strong>GoTeamUp basis</strong> (charges) is shown alongside as a cross-check — it typically breaches earlier since it excludes fees and payout lag.<br><br>
    <strong>This is an analysis to hand to your accountant, not a filed determination.</strong> It's only as accurate as the categorised data behind it — confirm the breach month and effective date with your accountant before registering.
  </div>
</body></html>`);
});

app.get('/report/transactions-csv', async (req, res) => {
  const { from, to, key } = req.query;
  if (key !== process.env.APP_SECRET) return res.status(401).send('Unauthorized');

  const { rows } = await pool.query(
    `SELECT t.txn_date, t.description_raw, t.merchant_name, t.amount, c.name as category, c.type
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.txn_date BETWEEN $1 AND $2
     ORDER BY t.txn_date ASC`,
    [from, to]
  );

  const esc = (v) => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const header = 'Date,Description,Merchant,Amount,Category,Type\n';
  const body = rows.map(r =>
    [r.txn_date, esc(r.description_raw), esc(r.merchant_name), r.amount, esc(r.category), esc(r.type)].join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="sps-finance-${from}-to-${to}.csv"`);
  res.send(header + body);
});

app.post('/api/payslips', requireAuth, async (req, res) => {
  const { employee_name, pay_period_end, tax_code, ni_category, ni_number, student_loan_plan,
          gross_pay, income_tax, employee_ni, employer_ni, student_loan, net_pay } = req.body;

  try {
    const { rows } = await pool.query(
      `INSERT INTO payslips (employee_name, pay_period_end, tax_code, ni_category, ni_number, student_loan_plan,
         gross_pay, income_tax, employee_ni, employer_ni, student_loan, net_pay)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [employee_name, pay_period_end, tax_code, ni_category, ni_number, student_loan_plan,
       gross_pay, income_tax, employee_ni, employer_ni, student_loan, net_pay]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('Payslip save failed:', err.message);
    res.status(500).send(`Database error: ${err.message}`);
  }
});

app.get('/api/payslips', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM payslips ORDER BY pay_period_end DESC LIMIT 50`);
  res.json(rows);
});

app.get('/api/categories', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM categories ORDER BY type, name`);
  res.json(rows);
});

app.get('/api/sync-log', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM sync_log ORDER BY ran_at DESC LIMIT 20`);
  res.json(rows);
});

cron.schedule('0 6 * * *', () => {
  console.log('Running scheduled daily sync...');
  exec('node server/sync.js', (err, stdout, stderr) => {
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  });
  if (process.env.GOTEAMUP_API_TOKEN) {
    exec('node server/sync_goteamup.js', (err, stdout, stderr) => {
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SPS Finance running on port ${PORT}`));
