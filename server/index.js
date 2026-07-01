require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const pool = require('./db');
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

  const threshold = 90000; // UK VAT registration threshold, correct as of April 2026 tax year
  const total = Number(rows[0].total);
  res.json({
    rollingTotal: total,
    threshold,
    remaining: threshold - total,
    periodFrom: from,
    periodTo: to
  });
});

app.get('/api/monthly-summary', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  const { rows } = await pool.query(
    `SELECT
       to_char(date_trunc('month', t.txn_date), 'YYYY-MM') as month,
       c.name, c.type, SUM(t.amount) as total, COUNT(*) as txn_count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.txn_date BETWEEN $1 AND $2
     GROUP BY month, c.name, c.type
     ORDER BY month DESC, c.type, total DESC`,
    [from, to]
  );
  res.json(rows);
});

app.get('/api/summary', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  const { rows } = await pool.query(
    `SELECT c.name, c.type, SUM(t.amount) as total, COUNT(*) as txn_count
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.txn_date BETWEEN $1 AND $2
     GROUP BY c.name, c.type
     ORDER BY c.type, total DESC`,
    [from, to]
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
