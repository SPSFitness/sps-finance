const axios = require('axios');
const pool = require('./db');

// Try every active rule, ordered by priority. Returns category_id or null.
async function tryRules(txn) {
  const { rows: rules } = await pool.query(
    `SELECT * FROM category_rules WHERE active = true ORDER BY priority ASC`
  );

  const desc = (txn.description_raw || '').toLowerCase();
  const merchant = (txn.merchant_name || '').toLowerCase();

  for (const rule of rules) {
    const val = rule.match_value.toLowerCase();
    if (rule.match_type === 'merchant_contains' && merchant.includes(val)) return rule.category_id;
    if (rule.match_type === 'description_contains' && desc.includes(val)) return rule.category_id;
    if (rule.match_type === 'exact_amount' && Number(txn.amount).toFixed(2) === Number(val).toFixed(2)) return rule.category_id;
    if (rule.match_type === 'amount_range') {
      const [min, max] = val.split(',').map(Number);
      const abs = Math.abs(Number(txn.amount));
      if (abs >= min && abs <= max) return rule.category_id;
    }
  }
  return null;
}

// Fallback: ask Claude to pick from the actual category list, with the transaction's own context.
// Only called for transactions the rule engine can't confidently place.
async function tryAI(txn) {
  const { rows: categories } = await pool.query(`SELECT id, name, type FROM categories`);
  const categoryList = categories.map(c => `${c.id}: ${c.name} (${c.type})`).join('\n');

  const prompt = `You're categorising a bank transaction for a small fitness business (personal training gym, retreats, made-to-order clothing store, some freelance web/marketing income).

Transaction:
Description: ${txn.description_raw}
Merchant: ${txn.merchant_name || 'unknown'}
Amount: ${txn.amount > 0 ? '+' : ''}${txn.amount} GBP (positive = money in, negative = money out)
Date: ${txn.txn_date}

Categories available:
${categoryList}

Reply ONLY with JSON, no other text: {"category_id": <number>, "confidence": <0.0-1.0>}
If genuinely unclear, use the lowest-confidence guess rather than guessing wildly.`;

  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    }
  });

  const text = res.data.content.map(b => b.text || '').join('').trim();
  const clean = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);
  return { categoryId: parsed.category_id, confidence: parsed.confidence };
}

// Main entry point — call this on every new transaction after insert.
async function categorizeTransaction(txnId) {
  const { rows } = await pool.query(`SELECT * FROM transactions WHERE id = $1`, [txnId]);
  const txn = rows[0];
  if (!txn) return;

  const ruleMatch = await tryRules(txn);
  if (ruleMatch) {
    await pool.query(
      `UPDATE transactions SET category_id = $1, categorized_by = 'rule', needs_review = false WHERE id = $2`,
      [ruleMatch, txnId]
    );
    return;
  }

  try {
    const { categoryId, confidence } = await tryAI(txn);
    // Below 0.6 confidence, flag for manual review rather than trusting it silently
    const needsReview = confidence < 0.6;
    await pool.query(
      `UPDATE transactions SET category_id = $1, categorized_by = 'ai', category_confidence = $2, needs_review = $3 WHERE id = $4`,
      [categoryId, confidence, needsReview, txnId]
    );
  } catch (err) {
    console.error(`AI categorisation failed for txn ${txnId}:`, err.message);
    await pool.query(`UPDATE transactions SET needs_review = true WHERE id = $1`, [txnId]);
  }
}

module.exports = { categorizeTransaction };
