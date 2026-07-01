# SPS Finance

Replaces QuickBooks day-to-day: pulls Starling transactions automatically, categorises them
against your actual business (memberships, PT, retreats, clothing store, freelance work),
flags anything uncertain for your review, gives you a live P&L-style dashboard.

Does **not** submit PAYE — that stays on HMRC Basic PAYE Tools as agreed. This is purely the
bookkeeping side.

## 1. Set up Postgres on Render

1. Render dashboard → New → PostgreSQL. Free tier is fine to start.
2. Copy the "External Database URL" it gives you → this is your `DATABASE_URL`.
3. Connect to it (Render gives you a "Connect" button with a psql command, or use any Postgres client) and run:
   ```
   psql <your-database-url> -f db/schema.sql
   ```
   This creates all tables and pre-loads your starter categories.

## 2. Create a TrueLayer developer account

1. Go to console.truelayer.com, sign up (free).
2. Create a new app. Note your **Client ID** and **Client Secret**.
3. Under "Redirect URIs", add: `https://<your-render-app-name>.onrender.com/auth/callback`
   (you'll get the real Render URL in step 4 — come back and add it once you know it)
4. TrueLayer will initially put you in a review/limited-live mode for real bank connections.
   Starling is on their standard supported bank list, so this should work without extra approval,
   but check console.truelayer.com for any "go live" checklist items they flag for your app.

## 3. Deploy to Render

1. Push this folder to a GitHub repo (e.g. `SPSFitness/sps-finance`, matching your other projects).
2. Render dashboard → New → Web Service → connect the repo.
3. Build command: `npm install`
   Start command: `npm start`
4. Add environment variables (from `.env.example`):
   - `DATABASE_URL` (from step 1)
   - `TRUELAYER_CLIENT_ID`, `TRUELAYER_CLIENT_SECRET` (from step 2)
   - `TRUELAYER_REDIRECT_URI` — `https://<your-actual-render-url>.onrender.com/auth/callback`
   - `TRUELAYER_ENV=live`
   - `ANTHROPIC_API_KEY` — your API key from console.anthropic.com
   - `TAX_YEAR_START=2026-04-06`
   - `APP_SECRET` — make up a long random string, this is what protects your dashboard
5. Deploy. Once it's live, go back to TrueLayer console and confirm the redirect URI matches exactly.

## 4. Connect Starling

1. Visit `https://<your-render-url>.onrender.com/auth/connect`
2. You'll be sent to TrueLayer's bank selection — choose Starling, log in and approve access
   the same way you would for any other Open Banking connection.
3. On success you'll see a confirmation with your account name(s) — this means the account
   is now saved in your database with tokens ready to use.

## 5. Backfill from the start of the tax year

Run this once, from your local machine or a Render shell, with the same environment variables set:

```
npm run backfill
```

This pulls every transaction from 6 April 2026 to today, in monthly chunks (some banks limit
how much history a single request returns, so chunking guarantees nothing gets missed), inserts
them, and runs them through the categoriser. It'll print how many transactions ended up flagged
for manual review.

## 6. Check the dashboard

Visit `https://<your-render-url>.onrender.com/?key=<your-APP_SECRET>`

- Top cards: income, expenses, net for the tax year to date
- By category table: exactly what's coming in and going out, by your actual categories
- Needs review: anything the rules and AI couldn't confidently place — pick the right category
  and hit Confirm. This does not create a new rule automatically, so a one-off doesn't quietly
  change future categorisation; add a proper rule (see below) if it's a recurring one.

## 7. Tighten up the categorisation rules

The AI fallback is solid but rules are instant, free, and 100% predictable — worth adding rules
for anything recurring (Stripe payouts, GoCardless, specific suppliers, etc). Add directly in
the database:

```sql
INSERT INTO category_rules (category_id, match_type, match_value, priority)
VALUES (
  (SELECT id FROM categories WHERE name = 'Membership Income'),
  'merchant_contains',
  'gocardless',
  10
);
```

Lower priority number = checked first. Once a rule exists, every future transaction matching
it skips the AI call entirely.

## 8. Daily sync

Runs automatically at 6am every day once deployed (built into `server/index.js` via cron),
pulling the last 7 days to catch anything that posted late. No action needed from you once
it's live. Check `/api/sync-log?key=<your-APP_SECRET>` if you ever want to confirm it ran.

## What to double check before binning QuickBooks

- Compare a month's totals here against QuickBooks for the same period — confirm they match
  before you rely on this for accountant handoff
- Make sure your accountant is happy with the categories/`hmrc_group` mapping in `categories`
  table, tweak names if they want different groupings for your tax return
- Keep QuickBooks running in parallel for one full month as a sanity check before cancelling it
