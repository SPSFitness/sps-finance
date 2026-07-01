# SPS Finance

Replaces QuickBooks day-to-day: pulls Starling transactions automatically, categorises them
against your actual business (memberships, PT, retreats, clothing store, freelance work),
flags anything uncertain for your review, gives you a live P&L-style dashboard.

Does **not** submit PAYE — that stays on HMRC Basic PAYE Tools as agreed. This is purely the
bookkeeping side.

Uses Starling's own developer API directly (Personal Access Token) — no TrueLayer, no
Open Banking aggregator, no production approval wait. You already have your token if you're
reading this after setup.

## What's already done (as of this build)

- Postgres database created on Render
- Web service deployed on Render, connected to your GitHub repo
- Starling Personal Access Token created

## What's left to do

### 1. Update environment variables on Render

Go to your `sps-finance` service on Render → **Environment** tab → **Edit**, and set:

- `DATABASE_URL` — should already be set
- `STARLING_ACCESS_TOKEN` — your Personal Access Token from developer.starlingbank.com
- `ANTHROPIC_API_KEY` — your key from console.anthropic.com
- `TAX_YEAR_START` — `2026-04-06`
- `APP_SECRET` — a long random password of your choosing, protects your dashboard

You can now **delete** these if they're still there — no longer needed:
- `TRUELAYER_CLIENT_ID`
- `TRUELAYER_CLIENT_SECRET`
- `TRUELAYER_REDIRECT_URI`
- `TRUELAYER_ENV`

Save — Render will redeploy automatically.

### 2. Push this updated code to GitHub

Replace the contents of your `sps-finance` repo with everything in this folder (the whole
`server/` folder has changed, plus this README and `.env.example`). Render will pick up the
push and redeploy automatically if it's connected to auto-deploy — otherwise trigger a manual
deploy from the Render dashboard.

### 3. Run the database schema update

The `accounts` table structure changed slightly (no more OAuth tokens stored, just Starling's
account and category IDs). If you already ran the old schema, run this against your database:

```sql
ALTER TABLE accounts DROP COLUMN IF EXISTS access_token;
ALTER TABLE accounts DROP COLUMN IF EXISTS refresh_token;
ALTER TABLE accounts DROP COLUMN IF EXISTS token_expires_at;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS starling_category_uid TEXT;
ALTER TABLE accounts ALTER COLUMN provider SET DEFAULT 'starling';
```

If this is a fresh database that never ran the old schema, just run the whole `db/schema.sql`
file as normal — no changes needed on your end.

### 4. Run the backfill

This is now a single command — it automatically fetches your account details from Starling
first (no separate "connect" step needed), then pulls every transaction from 6 April 2026 to
today, categorising as it goes:

```
npm run backfill
```

Run this from your own machine or a Render Shell, with the same environment variables
available (if running locally, copy your real values into a `.env` file first).

### 5. Check the dashboard

Visit `https://sps-finance.onrender.com/?key=<your-APP_SECRET>`

- Top cards: income, expenses, net for the tax year to date
- By category table: exactly what's coming in and going out, by your actual categories
- Needs review: anything the rules and AI couldn't confidently place — pick the right category
  and hit Confirm

### 6. Daily sync

Runs automatically at 6am every day once deployed, pulling the last 7 days to catch anything
that settled late. No action needed once it's live.

## One thing to know about Starling's Personal Access Token

Unlike an OAuth connection, this token doesn't refresh itself automatically and will need
manual renewal eventually (Starling's docs don't fix an exact expiry, but treat it as something
to check periodically). If the daily sync starts failing, the first thing to check is whether
the token has expired — regenerate it at developer.starlingbank.com/personal/token and update
`STARLING_ACCESS_TOKEN` on Render.

## Tightening up categorisation rules

The AI fallback is solid but rules are instant, free, and 100% predictable — worth adding for
anything recurring (Stripe payouts, GoCardless, specific suppliers). Add directly in the
database:

```sql
INSERT INTO category_rules (category_id, match_type, match_value, priority)
VALUES (
  (SELECT id FROM categories WHERE name = 'Membership Income'),
  'merchant_contains',
  'gocardless',
  10
);
```

Lower priority number = checked first.

## What to double check before binning QuickBooks

- Compare a month's totals here against QuickBooks for the same period
- Make sure your accountant is happy with the category groupings — tweak names in the
  `categories` table if needed
- Keep QuickBooks running in parallel for one full month as a sanity check before cancelling it
