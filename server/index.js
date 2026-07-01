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

// Dashboard data — summary by category for a date range
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

// Manually fix a category
app.post('/api/transactions/:id/category', requireAuth, async (req, res) => {
  const { category_id } = req.body;
  await pool.query(
    `UPDATE transactions SET category_id = $1, categorized_by = 'manual', needs_review = false WHERE id = $2`,
    [category_id, req.params.id]
  );
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
