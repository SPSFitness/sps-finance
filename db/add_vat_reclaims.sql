-- VAT reclaims under the Flat Rate Scheme.
--
-- On the 8.5% flat rate scheme you normally CANNOT reclaim input VAT on purchases.
-- The two exceptions this table is for:
--   1. Capital assets costing £2,000 or more (VAT-inclusive) in a single purchase
--      (e.g. the £7k gym equipment) — the input VAT can be reclaimed.
--   2. Pre-registration reclaim on assets still on hand (goods: back to deregistration
--      date Oct 2025 in this case, since the 4-year window is cut short by the previous
--      registration).
--
-- Nothing in here is auto-calculated. Each row is a value entered by hand, on the
-- accountant's advice. vat_amount is the figure that gets netted against VAT owed.

CREATE TABLE IF NOT EXISTS vat_reclaims (
  id            SERIAL PRIMARY KEY,
  reclaim_date  DATE NOT NULL,              -- date of the purchase / which quarter it falls in
  description   TEXT NOT NULL,              -- e.g. "3 racks, benches & barbells — £7k invoice"
  net_amount    NUMERIC(12,2),             -- optional: net (ex-VAT) value of the asset
  vat_amount    NUMERIC(12,2) NOT NULL,    -- the VAT value being reclaimed (per accountant)
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vat_reclaims_date ON vat_reclaims (reclaim_date);
