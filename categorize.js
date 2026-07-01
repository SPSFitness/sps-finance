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

// Starling assigns its own spending category to every transaction, straight from the card
// network / payment rails — not a guess. Where the mapping to your categories is unambiguous,
// use it directly: instant, free, and more reliable than the AI guessing off a vague description.
// Deliberately left out anything genuinely ambiguous for your business (REVENUE could be
// membership, PT, clothing, or Stripe; VAT/TRAVEL/VEHICLES/BUSINESS_ENTERTAINMENT could be
// personal or business) — those still go through the AI, just with this tag as extra context.
const STARLING_CATEGORY_MAP = {
  STAFF: 'Wages & PAYE',
  PAYE_AND_NI: 'Wages & PAYE',
  WORKPLACE: 'Rent & Utilities',
  MARKETING: 'Marketing & Ads',
  PHONE_AND_INTERNET: 'Software & Subscriptions',
  PROFESSIONAL_SERVICES: 'Software & Subscriptions',
  EQUIPMENT: 'Equipment & Gym Kit',
  REPAIRS_AND_MAINTENANCE: 'Equipment & Gym Kit',
  BANK_CHARGES: 'Bank Fees & Charges',
  FOOD_AND_DRINK: 'Owner Drawings',
  LOAN_PRINCIPAL: 'Transfer Between Accounts'
};

async function tryStarlingCategory(txn) {
  if (!txn.starling_spending_category) return null;
  const targetName = STARLING_CATEGORY_MAP[txn.starling_spending_category];
  if (!targetName) return null;

  const { rows } = await pool.query(`SELECT id FROM categories WHERE name = $1`, [targetName]);
  return rows[0] ? rows[0].id : null;
}

// Fallback: ask Claude to pick from the actual category list, with the transaction's own context,
// Starling's own category tag (where present), plus real examples of past manual corrections.
async function tryAI(txn) {
  const { rows: categories } = await pool.query(`SELECT id, name, type FROM categories`);
  const categoryList = categories.map(c => `${c.id}: ${c.name} (${c.type})`).join('\n');

  const { rows: examples } = await pool.query(
    `SELECT t.description_raw, t.merchant_name, t.amount, c.name as category_name
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.categorized_by = 'manual'
     ORDER BY t.created_at DESC
     LIMIT 20`
  );

  const exampleText = examples.length > 0
    ? examples.map(e => `"${e.description_raw}" (${e.amount > 0 ? '+' : ''}${e.amount}) -> ${e.category_name}`).join('\n')
    : '(no confirmed examples yet)';

  const prompt = `You're categorising a bank transaction for a small fitness business (personal training gym, retreats, made-to-order clothing store, some freelance web/marketing income).

Transaction:
Description: ${txn.description_raw}
Merchant: ${txn.merchant_name || 'unknown'}
Amount: ${txn.amount > 0 ? '+' : ''}${txn.amount} GBP (positive = money in, negative = money out)
Date: ${txn.txn_date}
Starling's own spending category tag: ${txn.starling_spending_category || 'none provided'}

Categories available:
${categoryList}

Real examples of how the business owner has manually categorised similar transactions before —
weight these heavily, they reflect his actual judgement better than generic guessing:
${exampleText}

Important: many bank descriptions are meaningless reference codes or generic labels (random
alphanumeric strings, "Sessions", "Payment") that carry no real signal about what the transaction
actually was. If Starling's own category tag is present, weight it heavily too — it comes from
the card network, not a guess. If neither the description nor the Starling tag gives you anything
concrete, and there's no similar example above, use LOW confidence (0.3 or below) rather than
confidently guessing.

Reply ONLY with JSON, no other text: {"category_id": <number>, "confidence": <0.0-1.0>}`;

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

  const starlingMatch = await tryStarlingCategory(txn);
  if (starlingMatch) {
    await pool.query(
      `UPDATE transactions SET category_id = $1, categorized_by = 'starling', needs_review = false WHERE id = $2`,
      [starlingMatch, txnId]
    );
    return;
  }

  try {
    const { categoryId, confidence } = await tryAI(txn);

    // Sanity check: an income category can't hold a negative amount, an expense category
    // can't hold a positive one. If the AI's pick contradicts the actual money direction,
    // that's a logical error, not just uncertainty — always flag it regardless of confidence.
    const { rows: catRows } = await pool.query(`SELECT type FROM categories WHERE id = $1`, [categoryId]);
    const catType = catRows[0] ? catRows[0].type : null;
    const amountIsNegative = Number(txn.amount) < 0;
    const directionMismatch =
      (catType === 'income' && amountIsNegative) ||
      (catType === 'expense' && !amountIsNegative);

    const needsReview = confidence < 0.6 || directionMismatch;
    await pool.query(
      `UPDATE transactions SET category_id = $1, categorized_by = 'ai', category_confidence = $2, needs_review = $3 WHERE id = $4`,
      [categoryId, directionMismatch ? Math.min(confidence, 0.3) : confidence, needsReview, txnId]
    );
  } catch (err) {
    console.error(`AI categorisation failed for txn ${txnId}:`, err.message);
    await pool.query(`UPDATE transactions SET needs_review = true WHERE id = $1`, [txnId]);
  }
}

module.exports = { categorizeTransaction };
