-- SPS Finance — schema
-- Run this once against your Postgres instance (Render Postgres, free/starter tier is fine)

CREATE TABLE IF NOT EXISTS accounts (
    id              SERIAL PRIMARY KEY,
    provider        TEXT NOT NULL DEFAULT 'starling',
    provider_account_id TEXT NOT NULL UNIQUE,   -- Starling's accountUid
    starling_category_uid TEXT,                 -- Starling's defaultCategory, required for the transactions feed
    display_name    TEXT NOT NULL,               -- e.g. "SPS Starling Business"
    currency        TEXT NOT NULL DEFAULT 'GBP',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,             -- e.g. "Membership Income", "Retreat Deposits"
    type        TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer', 'owner')),
    hmrc_group  TEXT,                             -- optional mapping for accountant/SA103/return prep
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rule engine: matched top-to-bottom by priority before falling back to AI
CREATE TABLE IF NOT EXISTS category_rules (
    id              SERIAL PRIMARY KEY,
    category_id     INTEGER NOT NULL REFERENCES categories(id),
    match_type      TEXT NOT NULL CHECK (match_type IN ('merchant_contains', 'description_contains', 'exact_amount', 'amount_range')),
    match_value     TEXT NOT NULL,                -- text to match, or "min,max" for amount_range
    priority        INTEGER NOT NULL DEFAULT 100, -- lower = checked first
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
    id                  SERIAL PRIMARY KEY,
    account_id          INTEGER NOT NULL REFERENCES accounts(id),
    provider_txn_id     TEXT NOT NULL,             -- TrueLayer transaction_id, unique per account
    txn_date            DATE NOT NULL,
    amount              NUMERIC(12,2) NOT NULL,    -- positive = money in, negative = money out
    currency            TEXT NOT NULL DEFAULT 'GBP',
    description_raw     TEXT NOT NULL,             -- as it comes from the bank
    merchant_name        TEXT,
    category_id         INTEGER REFERENCES categories(id),
    categorized_by      TEXT CHECK (categorized_by IN ('rule', 'ai', 'manual', 'starling', NULL)),
    category_confidence NUMERIC(3,2),              -- 0.00–1.00, only set when categorized_by = 'ai'
    starling_spending_category TEXT,                -- Starling's own category tag (STAFF, REVENUE, WORKPLACE, etc)
    needs_review        BOOLEAN NOT NULL DEFAULT false,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, provider_txn_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_review ON transactions(needs_review) WHERE needs_review = true;

CREATE TABLE IF NOT EXISTS sync_log (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER REFERENCES accounts(id),
    sync_type       TEXT NOT NULL CHECK (sync_type IN ('backfill', 'daily')),
    from_date       DATE,
    to_date         DATE,
    txns_pulled     INTEGER,
    txns_new        INTEGER,
    status          TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
    error_message   TEXT,
    ran_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Starter categories shaped around SPS's actual business, not a generic chart of accounts
INSERT INTO categories (name, type, hmrc_group) VALUES
    ('Membership Income', 'income', 'trading_income'),
    ('PT Session Income', 'income', 'trading_income'),
    ('Retreat Deposits', 'income', 'trading_income'),
    ('Retreat Balance Payments', 'income', 'trading_income'),
    ('Clothing Store Sales', 'income', 'trading_income'),
    ('Freelance Web/Marketing Income', 'income', 'trading_income'),
    ('Rent & Utilities', 'expense', 'premises_costs'),
    ('Equipment & Gym Kit', 'expense', 'equipment'),
    ('Software & Subscriptions', 'expense', 'admin_costs'),
    ('Marketing & Ads', 'expense', 'admin_costs'),
    ('Wages & PAYE', 'expense', 'staff_costs'),
    ('Retreat Costs (flights/venue)', 'expense', 'cost_of_sales'),
    ('Clothing Store Stock/Printing', 'expense', 'cost_of_sales'),
    ('Drone/Equipment Investment', 'expense', 'equipment'),
    ('Bank Fees & Charges', 'expense', 'admin_costs'),
    ('Owner Drawings', 'owner', NULL),
    ('Transfer Between Accounts', 'transfer', NULL)
ON CONFLICT (name) DO NOTHING;
