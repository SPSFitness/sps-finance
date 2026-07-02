CREATE TABLE IF NOT EXISTS gtu_payments (
    id              SERIAL PRIMARY KEY,
    gtu_payment_id  TEXT NOT NULL UNIQUE,
    plan_name       TEXT NOT NULL,
    category        TEXT NOT NULL,  -- pif, recurring, bodyblast, discount, refund, retail, other, reconstruction
    amount          NUMERIC(10,2) NOT NULL,
    payment_method  TEXT,
    charged_at      DATE NOT NULL,
    raw             JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gtu_payments_charged_at ON gtu_payments(charged_at);
