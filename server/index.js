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

// Manually trigger a sync right now — needed because the free Render tier spins the server
// down after inactivity, so the scheduled 6am cron below only fires if something happens to
// have woken the server up around that time. This button (and the Render Cron Job described
// in the README) are the reliable ways to actually get fresh data in.
app.post('/api/sync-now', requireAuth, async (req, res) => {
  try {
    const { rows: accounts } = await pool.query(`SELECT * FROM accounts`);
    const to = new Date().toISOString();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 7);
    const from = fromDate.toISOString();

    const results = [];
    for (const account of accounts) {
      const result = await ingestForAccount(account, from, to, 'daily');
      results.push({ account: account.display_name, ...result });
    }
    res.json({ ok: true, results });
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

  // Projection: compare the last 3 months' average trading income against the 3 months about
  // to drop off the back of the 12-month window (10-12 months ago). If income is trending up,
  // estimate how many months until the rolling total crosses the threshold. This is a rough
  // heads-up based on recent trend, not a certified forecast — treat it as a prompt to check
  // in with an accountant, not as the actual compliance figure.
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
    const rollingOff3 = monthTotals.slice(-13, -10); // the 3 oldest months still inside the current window
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

  // Current month trajectory — based on this month's actual pace so far, extrapolated to
  // month-end, then swapped into the rolling total to see where that would leave you.
  // Early in a month this is noisy (2 days of data tells you little) — flagged in the response
  // so the dashboard can show an appropriate caveat rather than present it as solid.
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
  const dailyRate = daysElapsedInMonth > 0 ? monthActualSoFar / daysElapsedInMonth : 0;
  const projectedMonthTotal = dailyRate * daysInMonth;
  const projectedRollingTotal = total - monthActualSoFar + projectedMonthTotal;

  const currentMonthProjection = {
    daysElapsedInMonth,
    daysInMonth,
    monthActualSoFar,
    projectedMonthTotal,
    projectedRollingTotal,
    projectedOverThreshold: projectedRollingTotal >= threshold,
    lowConfidence: daysElapsedInMonth < 7 // early in the month, extrapolation is noisy
  };

  // Cross-check against GoTeamUp's actual charged amounts, where available — bank deposits are
  // net of processing fees and can lag or batch differently than when the sale was actually made,
  // so this is a more accurate source for genuine taxable turnover where we have it.
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
    // gtu_payments table may not exist yet — fine, just skip the comparison
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

// Individual transactions within a category, for a date range — lets the dashboard drill down
// from a category total into the actual transactions behind it, to spot-check accuracy.
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

// Transactions flagged for manual review
app.get('/api/review', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, c.name as category_name FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.needs_review = true
     ORDER BY t.txn_date DESC`
  );
  res.json(rows);
});

// Accept every transaction currently in the review queue as-is (whatever category it currently
// shows, whether AI-guessed or rule-matched) — clears the queue in one go.
app.post('/api/review/accept-all', requireAuth, async (req, res) => {
  const result = await pool.query(
    `UPDATE transactions SET needs_review = false WHERE needs_review = true RETURNING id`
  );
  res.json({ ok: true, cleared: result.rows.length });
});

// Manually fix a category — optionally creates a rule so future matches skip the AI entirely,
// and optionally applies the same fix to every other transaction with the same description.
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
    // Priority 20 — checked after any hand-tuned rules (priority 5-10) but before the AI ever runs
    await pool.query(
      `INSERT INTO category_rules (category_id, match_type, match_value, priority)
       VALUES ($1, 'description_contains', $2, 20)`,
      [category_id, txn.description_raw.toLowerCase()]
    );
  }

  res.json({ ok: true });
});

// Printable Profit & Loss report — formatted for browser Print > Save as PDF, so accountants
// get a proper document without needing a heavy PDF library on a free-tier server.
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

// Raw transaction export as CSV — for importing into accounting software or handing to an accountant
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

// Save a calculated payslip for record-keeping
app.post('/api/payslips', requireAuth, async (req, res) => {
  const { employee_name, pay_period_end, tax_code, ni_category, student_loan_plan,
          gross_pay, income_tax, employee_ni, employer_ni, student_loan, net_pay } = req.body;

  const { rows } = await pool.query(
    `INSERT INTO payslips (employee_name, pay_period_end, tax_code, ni_category, student_loan_plan,
       gross_pay, income_tax, employee_ni, employer_ni, student_loan, net_pay)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [employee_name, pay_period_end, tax_code, ni_category, student_loan_plan,
     gross_pay, income_tax, employee_ni, employer_ni, student_loan, net_pay]
  );
  res.json({ ok: true, id: rows[0].id });
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

// Daily sync at 6am — catches yesterday's transactions plus anything that settled late
cron.schedule('0 6 * * *', () => {
  console.log('Running scheduled daily sync...');
  exec('node server/sync.js', (err, stdout, stderr) => {
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SPS Finance running on port ${PORT}`));
