# SPS Finance

Replaces QuickBooks day-to-day: pulls Starling transactions automatically, categorises them
against your actual business (memberships, PT, retreats, clothing store, freelance work),
flags anything uncertain for your review, gives you a live P&L-style dashboard.

## IMPORTANT — exact file locations

When uploading to GitHub, files MUST go in these exact folders, not loose at the top level:

```
sps-finance/
├── db/
│   ├── schema.sql
│   └── fix_rules.sql
├── public/
│   └── index.html          <- the dashboard, NOT at the top level
├── server/
│   ├── index.js             <- the running server, NOT at the top level
│   ├── backfill.js
│   ├── categorize.js
│   ├── db.js
│   ├── ingest.js
│   ├── recategorize.js
│   ├── starling.js
│   └── sync.js
├── .env.example
├── package.json
└── README.md
```

If `index.html` or `index.js` end up sitting loose at the repo's top level instead of inside
`public/` or `server/`, the app will not use them — it only reads from those exact folders.
Delete any stray top-level copies if you see them in your repo.

Does **not** submit PAYE — that stays on HMRC Basic PAYE Tools as agreed. This is purely the
bookkeeping side.

Uses Starling's own developer API directly (Personal Access Token) — no TrueLayer, no
Open Banking aggregator, no production approval wait.

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

If this is a brand new database, run the whole schema plus the accuracy fixes:

```
psql "YOUR_DATABASE_URL" -f db/schema.sql
psql "YOUR_DATABASE_URL" -f db/fix_rules.sql
```

`fix_rules.sql` adds rules that stop common personal-spend merchants (Tesco, Costa, Uber Eats
etc) and recurring business terms ("Sessions", "STRIPE", "PAYOUT") from being mis-guessed by
the AI — these get matched instantly and correctly every time instead.

If you already have an existing database from an earlier version, just run whichever of the
two files you haven't run yet — both are safe to re-run, they skip anything already present.

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

## Fixing the daily sync properly (important)

The free Render web service tier spins down after periods of inactivity. The sync scheduled
inside the app (6am daily) only fires if the server happens to already be awake at that moment
— on a free tier with light traffic, it often won't be, so transactions silently stop updating
without any error being shown anywhere.

**Two ways to fix this — do at least one:**

**Option A — Use the "Sync Now" button** (manual, but works immediately, no extra setup)
On the dashboard, click "🔄 Sync Now" whenever you want fresh data. Takes a few seconds.

**Option B — Set up a proper Render Cron Job** (automatic, the real fix)
1. Render dashboard → your Finances project → **New** → **Cron Job**
2. Connect the same GitHub repo
3. **Command**: `node server/sync.js`
4. **Schedule**: `0 6 * * *` (6am daily, in cron syntax)
5. Add the same environment variables as your web service (`DATABASE_URL`, `STARLING_ACCESS_TOKEN`,
   `ANTHROPIC_API_KEY`, `APP_SECRET`) — Cron Jobs run as a separate process and don't share the
   web service's environment automatically
6. Create it

This runs as an independent scheduled task on Render's infrastructure, completely separate from
whether your web service is awake or asleep — this is the reliable long-term fix.

## GoTeamUp integration (added later in the build)

Automatically pulls genuinely paid invoice line items from GoTeamUp's own API — a more
accurate source for VAT taxable turnover than bank deposits, since bank data is net of
processing fees and lags behind when the sale actually happened.

### Setup

1. In GoTeamUp: **Settings → Integrations → API Integration** → create an application →
   generate an **M2M Token** (Full Access). Copy it immediately, it's not shown again.
2. Add to `.env`: `GOTEAMUP_API_TOKEN=your-token-here`
3. Run the migration: `psql "YOUR_DB_URL" -f db/add_gtu_payments.sql`
4. Run the sync: `node server/sync_goteamup.js`

Important: GoTeamUp's API requires the header `Authorization: Token <token>` — NOT
`Bearer <token>`, despite what generic code samples on their docs site show. Using the
wrong prefix fails with a generic "expired or invalid" error that looks identical to an
actually-bad token, which cost real time to track down.

The sync automatically filters out Open/Voided/Upcoming Skipped invoice lines and only
keeps genuinely paid ones — the raw API feed includes a lot of £0.00 noise that isn't real
income. Re-running the sync is always safe; duplicates are skipped via `ON CONFLICT DO NOTHING`.

### Known limitation

GoTeamUp only holds data from when you actually started using it (December 2025 for SPS).
Earlier months (July–November 2025) are reconstructed from bank deposits instead — these
are flagged with `category = 'reconstruction'` in the `gtu_payments` table and are estimates,
not verified charge data.

## PAYE Calculator

Located at `/paye.html`. Calculates income tax, employee NI, student loan deductions, and
employer NI for a given gross pay amount, tax code, and NI category — built for 2026/27 tax
year rates. Correctly validated for tax code 1257L and NI category A against a real QuickBooks
payroll calculation (matched to the penny once the employer NI secondary threshold was corrected
to £417/month). Other NI categories (B, C, H, M) use simplified logic and should be
double-checked against HMRC's own calculator before relying on them.

Includes:
- Manual gross pay entry each period (since pay varies)
- National Insurance number field, saved with each payslip
- Payslip history with **View / Print** to recall and reprint any past payslip
- Print / Save as PDF button producing a clean payslip document

Run `psql "YOUR_DB_URL" -f db/add_payslips.sql` then `db/add_ni_number.sql` to set up the
required tables if starting fresh.
