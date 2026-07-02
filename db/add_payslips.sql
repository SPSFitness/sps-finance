CREATE TABLE IF NOT EXISTS payslips (
    id              SERIAL PRIMARY KEY,
    employee_name   TEXT NOT NULL,
    pay_period_end  DATE NOT NULL,
    tax_code        TEXT NOT NULL DEFAULT '1257L',
    ni_category     TEXT NOT NULL DEFAULT 'A',
    student_loan_plan TEXT DEFAULT 'plan1',  -- 'none', 'plan1', 'plan2', 'plan4', 'plan5', 'postgrad'
    gross_pay       NUMERIC(10,2) NOT NULL,
    income_tax      NUMERIC(10,2) NOT NULL,
    employee_ni     NUMERIC(10,2) NOT NULL,
    employer_ni     NUMERIC(10,2) NOT NULL,
    student_loan    NUMERIC(10,2) NOT NULL DEFAULT 0,
    net_pay         NUMERIC(10,2) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
