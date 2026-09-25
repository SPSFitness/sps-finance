// ============================================================================
// VAT POSITION ENDPOINT — paste into server/index.js among the app.get routes.
// Returns live "how much should I have set aside" figures for BOTH breach dates,
// so the dashboard can show current VAT exposure under each basis. Adds /api/vat-position.
// ============================================================================
app.get('/api/vat-position', requireAuth, async (req, res) => {
  const THRESHOLD = 90000;
  const today = new Date().toISOString().slice(0, 10);

  // Monthly trading income, bank basis
  const { rows: bankMonths } = await pool.query(
    `SELECT to_char(date_trunc('month', t.txn_date), 'YYYY-MM') as month, SUM(t.amount) as total
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE c.type = 'income' AND c.hmrc_group = 'trading_income'
     GROUP BY month ORDER BY month ASC`
  );
  let gtuMonths = [];
  try {
    const r = await pool.query(
      `SELECT to_char(date_trunc('month', charged_at), 'YYYY-MM') as month, SUM(amount) as total
       FROM gtu_payments GROUP BY month ORDER BY month ASC`
    );
    gtuMonths = r.rows;
  } catch (e) { gtuMonths = []; }

  const bankMap = Object.fromEntries(bankMonths.map(r => [r.month, Number(r.total)]));
  const gtuMap = Object.fromEntries(gtuMonths.map(r => [r.month, Number(r.total)]));
  const allMonths = [...new Set([...Object.keys(bankMap), ...Object.keys(gtuMap)])].sort();

  function rolling12(map, endMonth) {
    const [y, m] = endMonth.split('-').map(Number);
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      let mm = m - i, yy = y;
      while (mm <= 0) { mm += 12; yy -= 1; }
      sum += (map[`${yy}-${String(mm).padStart(2, '0')}`] || 0);
    }
    return sum;
  }
  function effectiveDate(breachMonth) {
    const [y, m] = breachMonth.split('-').map(Number);
    let mm = m + 2, yy = y;
    while (mm > 12) { mm -= 12; yy += 1; }
    return `${yy}-${String(mm).padStart(2, '0')}-01`;
  }
  // Sum a month-map's income from a start month (YYYY-MM-01) to now
  function incomeSince(map, startDate) {
    const startMonth = startDate.slice(0, 7);
    return allMonths.filter(mo => mo >= startMonth).reduce((s, mo) => s + (map[mo] || 0), 0);
  }

  // Find breach month for each basis
  let bankBreach = null, gtuBreach = null;
  for (const mo of allMonths) {
    if (!bankBreach && rolling12(bankMap, mo) > THRESHOLD) bankBreach = mo;
    if (!gtuBreach && rolling12(gtuMap, mo) > THRESHOLD) gtuBreach = mo;
  }

  function scenario(breachMonth, incomeMap) {
    if (!breachMonth) return null;
    const regDate = effectiveDate(breachMonth);
    const liable = regDate <= today; // has the registration date passed?
    const incomeSinceReg = liable ? incomeSince(incomeMap, regDate) : 0;
    return {
      breachMonth,
      registrationDate: regDate,
      liabilityStarted: liable,
      incomeSinceRegistration: incomeSinceReg,
      setAside_8_5: incomeSinceReg * 0.085,
      setAside_16_5: incomeSinceReg * 0.165
    };
  }

  res.json({
    threshold: THRESHOLD,
    asOf: today,
    bankBasis: scenario(bankBreach, bankMap),
    goteamupBasis: scenario(gtuBreach, gtuMap)
  });
});
