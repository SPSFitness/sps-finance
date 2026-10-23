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

// ---------------------------------------------------------------------------
// VAT — Flat Rate Scheme configuration
// ---------------------------------------------------------------------------
// Live registration: 8.5% flat rate, bank basis, effective 1 November 2026,
// no first-year 1% discount applied (accountant confirmed 8.5%).
//
// VAT_QUARTER_ANCHOR is the start of the FIRST VAT period. Until the VAT
// certificate confirms the stagger group, quarters default to 3-month blocks
// from registration (Nov–Jan, Feb–Apr, May–Jul, Aug–Oct). When the certificate
// arrives, change VAT_QUARTER_ANCHOR to the real first-period start date and,
// if HMRC gave a short/long opening period, that's the only line to touch.
const VAT_REGISTERED_FROM = process.env.VAT_REGISTERED_FROM || '2026-11-01';
const VAT_FLAT_RATE = Number(process.env.VAT_FLAT_RATE || 0.085);
const VAT_QUARTER_ANCHOR = process.env.VAT_QUARTER_ANCHOR || '2026-11-01';
const VAT_QUARTER_MONTHS = Number(process.env.VAT_QUARTER_MONTHS || 3);

// Build a date string from local parts (avoids the UTC day-shift bug).
function isoLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Generate consecutive VAT quarters from the anchor up to (and including) the
// quarter that contains today. Each quarter is { from, to } inclusive ISO dates.
function buildVatQuarters(anchorISO, today) {
  const quarters = [];
  const now = today || new Date();
  let start = new Date(anchorISO + 'T00:00:00');
  // guard against a misconfigured anchor producing an infinite loop
  let safety = 0;
  while (start <= now && safety < 400) {
    const end = new Date(start);
    end.setMonth(end.getMonth() + VAT_QUARTER_MONTHS);
    end.setDate(end.getDate() - 1); // inclusive last day of the period
    quarters.push({ from: isoLocal(start), to: isoLocal(end) });
    start = new Date(end);
    start.setDate(start.getDate() + 1);
    safety++;
  }
  return quarters;
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
app.post('/api/catch-up', requireAuth, async (req, res) => {
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

// ---------------------------------------------------------------------------
// VAT Flat Rate Scheme — what's actually owed, per quarter and running total.
// ---------------------------------------------------------------------------
// Bank basis: gross takings = trading income landing in the bank. On the flat
// rate scheme you pay VAT_FLAT_RATE of your VAT-inclusive takings; you do NOT
// deduct input VAT on normal purchases. The only deductions are the manual
// reclaims in vat_reclaims (capital assets >= £2k, and the pre-registration
// claim), each netted against the quarter its reclaim_date falls in.
app.get('/api/vat-flat-rate', requireAuth, async (req, res) => {
  try {
    const today = new Date();
    const quarters = buildVatQuarters(VAT_QUARTER_ANCHOR, today);

    // Pull all reclaims once, assign them to quarters in JS.
    let reclaims = [];
    try {
      const r = await pool.query(`SELECT * FROM vat_reclaims ORDER BY reclaim_date ASC`);
      reclaims = r.rows;
    } catch (e) {
      reclaims = []; // table may not exist yet
    }

    const quarterData = [];
    for (const q of quarters) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(t.amount), 0) as total
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
         WHERE c.type = 'income' AND c.hmrc_group = 'trading_income'
           AND t.txn_date BETWEEN $1 AND $2`,
        [q.from, q.to]
      );
      const grossTakings = Number(rows[0].total);
      const vatDue = grossTakings * VAT_FLAT_RATE;

      const qReclaims = reclaims.filter(rc => {
        const d = rc.reclaim_date instanceof Date ? isoLocal(rc.reclaim_date) : String(rc.reclaim_date).slice(0, 10);
        return d >= q.from && d <= q.to;
      });
      const reclaimTotal = qReclaims.reduce((s, rc) => s + Number(rc.vat_amount), 0);

      quarterData.push({
        from: q.from,
        to: q.to,
        grossTakings,
        vatDue,
        reclaimTotal,
        netDue: vatDue - reclaimTotal,
        reclaimCount: qReclaims.length
      });
    }

    const totalGross = quarterData.reduce((s, q) => s + q.grossTakings, 0);
    const totalVatDue = quarterData.reduce((s, q) => s + q.vatDue, 0);
    const totalReclaims = reclaims.reduce((s, rc) => s + Number(rc.vat_amount), 0);
    const runningNetOwed = totalVatDue - totalReclaims;

    res.json({
      registeredFrom: VAT_REGISTERED_FROM,
      flatRate: VAT_FLAT_RATE,
      quarterAnchor: VAT_QUARTER_ANCHOR,
      quarterMonths: VAT_QUARTER_MONTHS,
      quartersStartedYet: quarters.length > 0,
      quarters: quarterData,
      totals: {
        totalGross,
        totalVatDue,
        totalReclaims,
        runningNetOwed
      },
      reclaims
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List reclaims
app.get('/api/vat-reclaims', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM vat_reclaims ORDER BY reclaim_date DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a reclaim — every figure is user-entered, on the accountant's advice.
app.post('/api/vat-reclaims', requireAuth, async (req, res) => {
  const { reclaim_date, description, net_amount, vat_amount, notes } = req.body;
  if (!reclaim_date || !description || vat_amount === undefined || vat_amount === null || vat_amount === '') {
    return res.status(400).json({ error: 'reclaim_date, description and vat_amount are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO vat_reclaims (reclaim_date, description, net_amount, vat_amount, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [reclaim_date, description, net_amount || null, vat_amount, notes || null]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a reclaim
app.delete('/api/vat-reclaims/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM vat_reclaims WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Printable VAT Flat Rate return summary — per-quarter owed + running total, for the accountant.
app.get('/report/vat-flat-rate', async (req, res) => {
  const { key } = req.query;
  if (key !== process.env.APP_SECRET) return res.status(401).send('Unauthorized');

  try {
    const today = new Date();
    const quarters = buildVatQuarters(VAT_QUARTER_ANCHOR, today);

    let reclaims = [];
    try {
      const r = await pool.query(`SELECT * FROM vat_reclaims ORDER BY reclaim_date ASC`);
      reclaims = r.rows;
    } catch (e) { reclaims = []; }

    const fmt = (n) => (n < 0 ? '-£' : '£') + Math.abs(Number(n)).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

    const qRows = [];
    let totalGross = 0, totalVat = 0;
    for (const q of quarters) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(t.amount), 0) as total
         FROM transactions t JOIN categories c ON c.id = t.category_id
         WHERE c.type = 'income' AND c.hmrc_group = 'trading_income'
           AND t.txn_date BETWEEN $1 AND $2`,
        [q.from, q.to]
      );
      const gross = Number(rows[0].total);
      const vat = gross * VAT_FLAT_RATE;
      const qReclaims = reclaims.filter(rc => {
        const d = rc.reclaim_date instanceof Date ? isoLocal(rc.reclaim_date) : String(rc.reclaim_date).slice(0, 10);
        return d >= q.from && d <= q.to;
      });
      const reclaimTotal = qReclaims.reduce((s, rc) => s + Number(rc.vat_amount), 0);
      totalGross += gross; totalVat += vat;
      qRows.push(`<tr>
        <td>${fmtDate(q.from)} – ${fmtDate(q.to)}</td>
        <td style="text-align:right">${fmt(gross)}</td>
        <td style="text-align:right">${fmt(vat)}</td>
        <td style="text-align:right">${reclaimTotal ? '-' + fmt(reclaimTotal) : '—'}</td>
        <td style="text-align:right;font-weight:700">${fmt(vat - reclaimTotal)}</td>
      </tr>`);
    }

    const totalReclaims = reclaims.reduce((s, rc) => s + Number(rc.vat_amount), 0);
    const runningNet = totalVat - totalReclaims;

    const reclaimRows = reclaims.map(rc => `<tr>
      <td>${fmtDate(rc.reclaim_date)}</td>
      <td>${rc.description}</td>
      <td style="text-align:right">${rc.net_amount ? fmt(rc.net_amount) : '—'}</td>
      <td style="text-align:right">${fmt(rc.vat_amount)}</td>
    </tr>`).join('');

    const noQuarters = quarters.length === 0;

    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>VAT Flat Rate — SPS Fitness</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; max-width: 820px; margin: 40px auto; color: #0b0b0f; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
  h2 { font-size: 15px; border-bottom: 2px solid #0b0b0f; padding-bottom: 6px; margin-top: 30px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #6b7280; padding: 6px 4px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 6px 4px; border-bottom: 1px solid #f1f3f5; }
  .total-row td { font-weight: 700; border-top: 2px solid #0b0b0f; border-bottom: none; padding-top: 10px; }
  .headline { font-size: 26px; font-weight: 800; margin: 8px 0 2px; }
  .box { background:#f7f8fa; border:1px solid #e5e7eb; border-radius:10px; padding:18px 20px; margin-top:16px; }
  .print-btn { position: fixed; top: 20px; right: 20px; background: #1a4dff; color: white; border: none; padding: 10px 18px; border-radius: 6px; font-weight: 600; cursor: pointer; }
  @media print { .print-btn { display: none; } }
</style></head>
<body>
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <h1>SPS Fitness — VAT (Flat Rate Scheme)</h1>
  <div class="sub">Flat rate ${(VAT_FLAT_RATE * 100).toFixed(1)}% · Bank basis · Registered from ${fmtDate(VAT_REGISTERED_FROM)} · Generated ${new Date().toLocaleDateString('en-GB')}</div>

  <div class="box">
    <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;font-weight:700;">VAT owed since registration (net of reclaims)</div>
    <div class="headline" style="color:${runningNet >= 0 ? '#0b0b0f' : '#0f9d58'}">${fmt(runningNet)}</div>
    <div style="font-size:12px;color:#6b7280;">${fmt(totalVat)} flat-rate VAT due, less ${fmt(totalReclaims)} reclaimed on capital assets / pre-registration.</div>
  </div>

  ${noQuarters ? `<p style="margin-top:24px;color:#6b7280;">No VAT period has started yet. Registration begins ${fmtDate(VAT_REGISTERED_FROM)}; the first quarter's figures appear here once trading from that date is recorded. Any reclaims entered below are held ready for the first return.</p>` : `
  <h2>By quarter</h2>
  <table>
    <thead><tr><th>Period</th><th style="text-align:right">Gross takings</th><th style="text-align:right">VAT @ ${(VAT_FLAT_RATE*100).toFixed(1)}%</th><th style="text-align:right">Reclaims</th><th style="text-align:right">Net due</th></tr></thead>
    <tbody>
      ${qRows.join('')}
      <tr class="total-row"><td>Total</td><td style="text-align:right">${fmt(totalGross)}</td><td style="text-align:right">${fmt(totalVat)}</td><td style="text-align:right">-${fmt(totalReclaims)}</td><td style="text-align:right">${fmt(runningNet)}</td></tr>
    </tbody>
  </table>`}

  <h2>Reclaims entered</h2>
  ${reclaims.length ? `<table>
    <thead><tr><th>Date</th><th>Description</th><th style="text-align:right">Net value</th><th style="text-align:right">VAT reclaimed</th></tr></thead>
    <tbody>${reclaimRows}<tr class="total-row"><td>Total reclaimed</td><td></td><td></td><td style="text-align:right">${fmt(totalReclaims)}</td></tr></tbody>
  </table>` : '<p style="color:#6b7280;">No reclaims entered yet.</p>'}

  <p style="margin-top:30px;font-size:11px;color:#9ca3af;line-height:1.5;">
    Flat Rate Scheme: VAT is charged at ${(VAT_FLAT_RATE*100).toFixed(1)}% of gross (VAT-inclusive) takings; input VAT on normal
    purchases is not reclaimable. Reclaims shown are capital assets of £2,000+ (VAT-inclusive) and pre-registration claims,
    entered manually on the accountant's advice. Quarter dates are provisional until confirmed by the VAT certificate.
    Figures are a working aid, not a substitute for the accountant's filed return.
  </p>
</body></html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
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
