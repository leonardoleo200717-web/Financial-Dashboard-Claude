/* =========================================================================
   Financial Dashboard — Calculation Engine (schema v2)
   -------------------------------------------------------------------------
   Pure, DOM-free, side-effect-free. Implements the derived metrics defined
   in CLAUDE.md §2 (net worth, estimated expenses, invested amount, savings
   rate, market growth) and the FIRE math of §3.

   This file is inlined verbatim into index.html (single-file deliverable)
   AND consumed directly by the Node test harness in tests/. Keep it free of
   any browser/Chart.js/DOM references.
   ========================================================================= */
(function (root, factory) {
  const Engine = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  root.Engine = Engine;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ----------------------------- helpers ------------------------------- */

  const MONTHS_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
    'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

  const eurFmt = (typeof Intl !== 'undefined')
    ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' })
    : null;

  function fmtEUR(n) {
    if (n == null || isNaN(n)) return '—';
    if (eurFmt) return eurFmt.format(n);
    return '€ ' + Number(n).toFixed(2);
  }

  function fmtPct(n, digits) {
    if (n == null || isNaN(n)) return '—';
    return (n * 100).toFixed(digits == null ? 1 : digits).replace('.', ',') + '%';
  }

  // round to cents to avoid floating point noise in comparisons/flags
  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  /* ---------------------------- ym utilities --------------------------- */

  function ymParts(ym) {
    const [y, m] = ym.split('-').map(Number);
    return { y, m };
  }
  function ymPrev(ym) {
    let { y, m } = ymParts(ym);
    m -= 1; if (m === 0) { m = 12; y -= 1; }
    return y + '-' + String(m).padStart(2, '0');
  }
  function ymNext(ym) {
    let { y, m } = ymParts(ym);
    m += 1; if (m === 13) { m = 1; y += 1; }
    return y + '-' + String(m).padStart(2, '0');
  }
  function ymCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function monthsBetween(a, b) {
    const pa = ymParts(a), pb = ymParts(b);
    return (pb.y - pa.y) * 12 + (pb.m - pa.m);
  }
  function monthLabelIT(ym) {
    const { y, m } = ymParts(ym);
    return MONTHS_IT[m - 1] + ' ' + y;
  }
  // fractional age at the payday of a given month
  function ageAt(birthDate, ym) {
    if (!birthDate) return null;
    const [by, bm] = birthDate.split('-').map(Number);
    const { y, m } = ymParts(ym);
    return (y - by) + (m - bm) / 12;
  }

  /* --------------------------- data accessors -------------------------- */

  function accountById(data, id) {
    return (data.accounts || []).find(a => a.id === id) || null;
  }
  function snapKey(accId, ym) { return accId + '|' + ym; }
  function getSnapshot(data, accId, ym) {
    return (data.snapshots && data.snapshots[snapKey(accId, ym)]) || null;
  }
  function getEntry(data, ym) {
    return (data.entries && data.entries[ym]) || null;
  }
  function isLiquid(acc) {
    if (acc.liquidity) return acc.liquidity === 'liquid';
    return acc.type !== 'pension';
  }

  // Accounts considered "active" for entry/current-state at a given month:
  // created on/before ym and (not archived OR archived in a later month).
  function accountsActiveAt(data, ym) {
    return (data.accounts || []).filter(a => {
      if (a.createdAt && ymCompare(a.createdAt, ym) > 0) return false;
      if (a.archivedAt && ymCompare(a.archivedAt, ym) < 0) return false;
      return true;
    });
  }
  function currentAccounts(data) {
    return (data.accounts || []).filter(a => a.type === 'current');
  }

  // All months that have either a snapshot or an entry, ascending.
  function monthSeries(data) {
    const set = new Set();
    Object.values(data.snapshots || {}).forEach(s => set.add(s.yearMonth));
    Object.keys(data.entries || {}).forEach(ym => set.add(ym));
    return Array.from(set).sort(ymCompare);
  }

  /* --------------------------- §2.1 net worth -------------------------- */

  // Sum balancePayday over accounts matching a predicate that have a snapshot
  // for the month. Archived accounts naturally drop out once snapshots stop.
  function sumBalances(data, ym, pred) {
    let sum = 0, any = false;
    for (const acc of data.accounts || []) {
      if (!pred(acc)) continue;
      const s = getSnapshot(data, acc.id, ym);
      if (!s || s.balancePayday == null) continue;
      sum += s.balancePayday; any = true;
    }
    return any ? r2(sum) : null;
  }
  function liquidNetWorth(data, ym) {
    return sumBalances(data, ym, isLiquid);
  }
  // Whether an account counts toward FIRE capital (the compounding investment
  // base used for projections/Coast/Monte Carlo). Cash buffers (current) and
  // savings sit idle and should NOT be projected at market returns, so the
  // default is broker-only. A per-account `includeInFire` boolean overrides.
  function defaultIncludeInFire(acc) {
    return acc.type === 'broker';
  }
  function includesInFire(acc) {
    if (!isLiquid(acc)) return false; // pensions are the separate post-67 pillar
    return acc.includeInFire == null ? defaultIncludeInFire(acc) : !!acc.includeInFire;
  }
  // Investable capital used for all FIRE math (≠ liquid net worth, which also
  // includes idle cash/savings).
  function fireCapital(data, ym) {
    return sumBalances(data, ym, includesInFire);
  }
  function lockedNetWorth(data, ym) {
    return sumBalances(data, ym, a => !isLiquid(a));
  }
  function totalNetWorth(data, ym) {
    const l = liquidNetWorth(data, ym);
    const k = lockedNetWorth(data, ym);
    if (l == null && k == null) return null;
    return r2((l || 0) + (k || 0));
  }

  /* --------------- current-account snapshot aggregation ---------------- */

  // field: 'balancePayday' | 'balancePaydayMinus1'
  function sumCurrent(data, ym, field) {
    let sum = 0, missing = false, any = false;
    for (const acc of currentAccounts(data)) {
      // only count current accounts that are active that month
      if (acc.createdAt && ymCompare(acc.createdAt, ym) > 0) continue;
      if (acc.archivedAt && ymCompare(acc.archivedAt, ym) < 0) continue;
      const s = getSnapshot(data, acc.id, ym);
      if (!s || s[field] == null) { missing = true; continue; }
      sum += s[field]; any = true;
    }
    return { sum: r2(sum), missing, any };
  }

  /* --------------- contribution / transfer aggregation ----------------- */

  // Returns split of contributions in an entry.
  function contributionSplit(entry) {
    let depositsFromCurrent = 0;   // source=current, amount>0  (cash leaving CC)
    let withdrawalsToCurrent = 0;  // source=current, amount<0  (cash back to CC), abs
    let externalNet = 0;           // source=external, signed
    (entry && entry.contributions || []).forEach(c => {
      const amt = Number(c.amount) || 0;
      if (c.source === 'external') { externalNet += amt; return; }
      if (amt >= 0) depositsFromCurrent += amt;
      else withdrawalsToCurrent += -amt;
    });
    return {
      depositsFromCurrent: r2(depositsFromCurrent),
      withdrawalsToCurrent: r2(withdrawalsToCurrent),
      externalNet: r2(externalNet),
      // Σ contributions with source=current (signed) — used for reconciliation
      currentNet: r2(depositsFromCurrent - withdrawalsToCurrent),
    };
  }

  // Net transfers in/out of the set of CURRENT accounts for an entry.
  function transferCurrentSplit(data, entry) {
    const curIds = new Set(currentAccounts(data).map(a => a.id));
    let out = 0, into = 0;
    (entry && entry.internalTransfers || []).forEach(t => {
      const amt = Number(t.amount) || 0;
      const fromCur = curIds.has(t.fromAccountId);
      const toCur = curIds.has(t.toAccountId);
      if (fromCur) out += amt;
      if (toCur) into += amt;
    });
    // a current→current transfer adds to both and nets to zero — correct.
    return { out: r2(out), into: r2(into), net: r2(out - into) };
  }

  // Net contributions hitting a single account's balance (all sources, signed).
  function contributionsForAccount(entry, accId) {
    let s = 0;
    (entry && entry.contributions || []).forEach(c => {
      if (c.accountId === accId) s += Number(c.amount) || 0;
    });
    return r2(s);
  }
  // Net transfers into a single account (in − out).
  function transfersForAccount(entry, accId) {
    let s = 0;
    (entry && entry.internalTransfers || []).forEach(t => {
      const amt = Number(t.amount) || 0;
      if (t.toAccountId === accId) s += amt;
      if (t.fromAccountId === accId) s -= amt;
    });
    return r2(s);
  }

  /* --------------------- §2.2 estimated expenses ----------------------- */

  /*
    expenses(m) = balancePayday_current(m-1)              // cash at cycle start
                + otherIncome(m)
                + Σ withdrawals back to current (abs)
                − Σ contributions(source=current) deposits
                − (transfers out of current − transfers into current)
                − balancePaydayMinus1_current(m)          // cash left at cycle end
  */
  function estimatedExpenses(data, ym) {
    const flags = [];
    const prev = ymPrev(ym);
    const entry = getEntry(data, ym);

    const start = sumCurrent(data, prev, 'balancePayday');   // cycle start cash
    const end = sumCurrent(data, ym, 'balancePaydayMinus1'); // cycle end cash

    if (!start.any || start.missing || !end.any || end.missing) {
      flags.push('MISSING_SNAPSHOT');
      return { value: null, flags };
    }

    const otherIncome = entry ? (Number(entry.otherIncome) || 0) : 0;
    const cs = contributionSplit(entry);
    const ts = transferCurrentSplit(data, entry);

    const value = r2(
      start.sum
      + otherIncome
      + cs.withdrawalsToCurrent
      - cs.depositsFromCurrent
      - ts.net
      - end.sum
    );

    if (value < 0) flags.push('NEGATIVE_EXPENSES');
    return { value, flags };
  }

  /* ------------- §2.3 invested amount & savings rate ------------------- */

  function totalIncome(entry) {
    if (!entry) return 0;
    return r2((Number(entry.salaryNet) || 0)
      + (Number(entry.extraSalary) || 0)
      + (Number(entry.otherIncome) || 0));
  }

  function investedAndSavings(data, ym) {
    const flags = [];
    const prev = ymPrev(ym);
    const entry = getEntry(data, ym);

    const exp = estimatedExpenses(data, ym);
    const endCur = sumCurrent(data, ym, 'balancePaydayMinus1');
    const prevCur = sumCurrent(data, prev, 'balancePaydayMinus1');

    if (exp.value == null || !endCur.any || endCur.missing || !prevCur.any || prevCur.missing) {
      exp.flags.forEach(f => flags.push(f));
      if (!flags.includes('MISSING_SNAPSHOT')) flags.push('MISSING_SNAPSHOT');
      return { invested: null, savingsRate: null, totalIncome: totalIncome(entry), deltaCash: null, expenses: exp.value, flags };
    }

    const deltaCash = r2(endCur.sum - prevCur.sum);
    const inc = totalIncome(entry);
    const invested = r2(inc - exp.value - deltaCash);
    const savingsRate = inc > 0 ? invested / inc : null;

    exp.flags.forEach(f => flags.push(f));
    return { invested, savingsRate, totalIncome: inc, deltaCash, expenses: exp.value, flags };
  }

  // §2.3 reconciliation: manual current-sourced contributions vs invested.
  function reconcile(data, ym) {
    const is = investedAndSavings(data, ym);
    if (is.invested == null) return { mismatch: false, diff: null, contributions: null, invested: null };
    const entry = getEntry(data, ym);
    const contrib = contributionSplit(entry).currentNet; // money sent to investments from CC
    const diff = r2(contrib - is.invested);
    return {
      mismatch: Math.abs(diff) > 50,
      diff,
      contributions: contrib,
      invested: is.invested,
    };
  }

  /* ----------------- §2.4 market growth vs contributions --------------- */

  function marketGrowthForAccount(data, ym, accId) {
    const prev = ymPrev(ym);
    const cur = getSnapshot(data, accId, ym);
    const pre = getSnapshot(data, accId, prev);
    if (!cur || cur.balancePayday == null || !pre || pre.balancePayday == null) return null;
    const entry = getEntry(data, ym);
    const contrib = contributionsForAccount(entry, accId);
    const transf = transfersForAccount(entry, accId);
    return r2(cur.balancePayday - pre.balancePayday - contrib - transf);
  }

  // Portfolio market growth = Σ over non-current accounts.
  function portfolioMarketGrowth(data, ym) {
    let sum = 0, any = false;
    for (const acc of data.accounts || []) {
      if (acc.type === 'current') continue;
      const g = marketGrowthForAccount(data, ym, acc.id);
      if (g == null) continue;
      sum += g; any = true;
    }
    return any ? r2(sum) : null;
  }

  // Net contributions across portfolio (source=current only → "money I saved").
  function portfolioContributions(data, ym) {
    const entry = getEntry(data, ym);
    let s = 0;
    (entry && entry.contributions || []).forEach(c => {
      if (c.source === 'external') return;
      s += Number(c.amount) || 0;
    });
    return r2(s);
  }

  /* ----------------------- monthly table (Tab 2) ----------------------- */

  function buildMonthlyTable(data) {
    const months = monthSeries(data);
    return months.map(ym => {
      const prev = ymPrev(ym);
      const liquid = liquidNetWorth(data, ym);
      const prevLiquid = liquidNetWorth(data, prev);
      const exp = estimatedExpenses(data, ym);
      const is = investedAndSavings(data, ym);
      const rec = reconcile(data, ym);
      const entry = getEntry(data, ym);
      const flags = new Set([...(exp.flags || []), ...(is.flags || [])]);
      if (rec.mismatch) flags.add('RECONCILE_MISMATCH');
      if (entry && Array.isArray(entry.flags)) entry.flags.forEach(f => flags.add(f));
      const delta = (liquid != null && prevLiquid != null) ? r2(liquid - prevLiquid) : null;
      const deltaPct = (delta != null && prevLiquid) ? delta / prevLiquid : null;
      return {
        ym,
        label: monthLabelIT(ym),
        liquid,
        delta,
        deltaPct,
        contributions: portfolioContributions(data, ym),
        market: portfolioMarketGrowth(data, ym),
        expenses: exp.value,
        invested: is.invested,
        savingsRate: is.savingsRate,
        totalIncome: is.totalIncome,
        flags: Array.from(flags),
      };
    });
  }

  // Rolling N-month average over a numeric series (nulls skipped).
  function rollingAvg(values, ym2idx, months, n) {
    // values: array aligned to months; returns array of same length
    return values.map((_, i) => {
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - n + 1); j <= i; j++) {
        if (values[j] != null) { sum += values[j]; cnt++; }
      }
      return cnt ? sum / cnt : null;
    });
  }

  /* ============================ §3 FIRE math ========================== */

  // Present value at fireAge of an annuity paying `annual` per year for
  // `years` years, discounted at real return r (annual). End-of-year payments.
  function annuityPV(annual, years, r) {
    if (years <= 0) return 0;
    if (r === 0) return annual * years;
    return annual * (1 - Math.pow(1 + r, -years)) / r;
  }

  function fireNumberSimple(fire) {
    return r2(fire.monthlyExpenseFire * 12 / fire.swr);
  }

  // Two-phase: bridge (fireAge→pensionStartAge full expenses) + perpetual
  // capital at pension age covering (expenses − pension), discounted to fireAge.
  function fireNumberTwoPhase(fire) {
    const annualExp = fire.monthlyExpenseFire * 12;
    const bridgeYears = Math.max(0, fire.pensionStartAge - fire.fireAge);
    const r = fire.realReturnBase;
    const bridgeCapital = annuityPV(annualExp, bridgeYears, r);
    const postPensionAnnualNeed = Math.max(0, (fire.monthlyExpenseFire - fire.expectedPensionMonthly) * 12);
    const legacyAtPension = postPensionAnnualNeed / fire.swr;
    const legacyCapital = legacyAtPension / Math.pow(1 + r, bridgeYears);
    const total = r2(bridgeCapital + legacyCapital);
    const simple = fireNumberSimple(fire);
    return {
      twoPhase: total,
      simple,
      pensionSaving: r2(simple - total),
      bridgeCapital: r2(bridgeCapital),
      legacyCapital: r2(legacyCapital),
    };
  }

  function coastFire(fire, currentLiquid, currentAge, realReturn) {
    const number = fireNumberSimple(fire);
    const yearsToFire = fire.fireAge - currentAge;
    const yearsToCoast = fire.coastAge - currentAge;
    // capital required today so that, with no further contributions, you hit
    // the FIRE number at fireAge:
    const requiredToday = number / Math.pow(1 + realReturn, Math.max(0, yearsToFire));
    const coastNumberAtCoastAge = number / Math.pow(1 + realReturn, Math.max(0, fire.fireAge - fire.coastAge));
    let ageIfStopNow = null;
    if (currentLiquid > 0 && currentLiquid < number) {
      ageIfStopNow = currentAge + Math.log(number / currentLiquid) / Math.log(1 + realReturn);
    } else if (currentLiquid >= number) {
      ageIfStopNow = currentAge;
    }
    return {
      number,
      requiredToday,
      coastNumberAtCoastAge,
      gapToday: r2(requiredToday - currentLiquid),
      ageIfStopNow,
      yearsToCoast,
    };
  }

  // Deterministic accumulation projection. Returns month-by-month series and
  // the month the balance first reaches the FIRE number.
  function project(opts) {
    const {
      start, monthlyContribution, annualReturn, fireNumber,
      startYM, maxYears = 60,
      applyBox3 = false, box3DragAnnual = 0, box3StartYM = null,
    } = opts;
    const mRet = Math.pow(1 + annualReturn, 1 / 12) - 1;
    let balance = start;
    let ym = startYM;
    const series = [{ ym, balance: r2(balance) }];
    let reachedYM = balance >= fireNumber ? ym : null;
    const maxMonths = maxYears * 12;
    for (let i = 0; i < maxMonths; i++) {
      balance = balance * (1 + mRet) + monthlyContribution;
      ym = ymNext(ym);
      if (applyBox3 && box3StartYM && ymCompare(ym, box3StartYM) >= 0) {
        balance -= balance * (box3DragAnnual / 12);
      }
      series.push({ ym, balance: r2(balance) });
      if (reachedYM == null && balance >= fireNumber) reachedYM = ym;
    }
    return {
      series,
      reachedYM,
      reachedYear: reachedYM ? ymParts(reachedYM).y : null,
      finalBalance: r2(balance),
    };
  }

  /* -------------------------- Monte Carlo (§3.5) ----------------------- */

  function gaussian(mean, std, rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + std * z;
  }

  // Simple seeded RNG (mulberry32) for reproducible tests.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function monteCarlo(opts) {
    const {
      start, monthlyContribution, currentAge, fireAge,
      pensionStartAge, monthlyExpenseFire, expectedPensionMonthly,
      inflation, meanReturn, stdDev, runs = 1000, endAge = 90, seed = 12345,
    } = opts;
    const rng = mulberry32(seed);
    const accumMonths = Math.round((fireAge - currentAge) * 12);
    const totalMonths = Math.round((endAge - currentAge) * 12);
    const pensionMonth = Math.round((pensionStartAge - currentAge) * 12);

    const finals = [];
    const crossings = []; // age at which balance first reaches the fire number
    const failAges = [];
    const fireNumber = monthlyExpenseFire * 12 / 0.035;
    let successes = 0;
    // record balance percentiles at yearly checkpoints
    const checkpoints = [];
    for (let y = 0; y <= (endAge - currentAge); y++) checkpoints.push(y * 12);
    const cpData = checkpoints.map(() => []);

    for (let run = 0; run < runs; run++) {
      let balance = start;
      let crossed = null;
      let failed = false;
      let failAge = null;
      let cpIdx = 0;
      for (let m = 0; m <= totalMonths; m++) {
        if (cpIdx < checkpoints.length && m === checkpoints[cpIdx]) {
          cpData[cpIdx].push(balance); cpIdx++;
        }
        const age = currentAge + m / 12;
        if (crossed == null && balance >= fireNumber) crossed = age;
        if (m === totalMonths) break;
        // annual return drawn once per 12 months, applied monthly
        const annual = gaussian(meanReturn, stdDev, rng);
        const mRet = Math.pow(1 + Math.max(-0.95, annual), 1 / 12) - 1;
        balance = balance * (1 + mRet);
        if (m < accumMonths) {
          balance += monthlyContribution;
        } else {
          // withdrawal phase: inflation-adjusted FIRE expenses, less pension
          const yearsFromNow = m / 12;
          const infl = Math.pow(1 + inflation, yearsFromNow);
          let need = monthlyExpenseFire * infl;
          if (m >= pensionMonth) need -= expectedPensionMonthly * infl;
          balance -= Math.max(0, need);
          if (balance < 0 && !failed) { failed = true; failAge = age; }
        }
      }
      finals.push(balance);
      if (crossed != null) crossings.push(crossed);
      if (!failed) successes++; else failAges.push(failAge);
    }

    function pct(arr, p) {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
      return s[idx];
    }
    const fan = checkpoints.map((cp, i) => ({
      age: currentAge + cp / 12,
      p10: pct(cpData[i], 10), p25: pct(cpData[i], 25), p50: pct(cpData[i], 50),
      p75: pct(cpData[i], 75), p90: pct(cpData[i], 90),
    }));

    return {
      runs,
      successProbability: successes / runs,
      medianCrossingAge: pct(crossings, 50),
      medianFinal: pct(finals, 50),
      failAges,
      fan,
      fireNumber: r2(fireNumber),
    };
  }

  /* -------------------------- on-track (§3.3) -------------------------- */

  function planProjectionCurve(plan, months) {
    // months: array of YYYY-MM ascending starting at plan.createdAt
    const mRet = Math.pow(1 + plan.assumedRealReturn, 1 / 12) - 1;
    let balance = plan.startingLiquidNetWorth;
    const out = {};
    months.forEach((ym, i) => {
      if (i > 0) balance = balance * (1 + mRet) + plan.plannedMonthlyContribution;
      out[ym] = r2(balance);
    });
    return out;
  }

  /* ------------------------------ exports ------------------------------ */

  return {
    // helpers
    MONTHS_IT, fmtEUR, fmtPct, r2,
    ymParts, ymPrev, ymNext, ymCompare, monthsBetween, monthLabelIT, ageAt,
    // accessors
    accountById, getSnapshot, getEntry, isLiquid, accountsActiveAt,
    currentAccounts, monthSeries,
    // §2
    liquidNetWorth, lockedNetWorth, totalNetWorth,
    defaultIncludeInFire, includesInFire, fireCapital,
    sumCurrent, contributionSplit, transferCurrentSplit,
    contributionsForAccount, transfersForAccount,
    estimatedExpenses, totalIncome, investedAndSavings, reconcile,
    marketGrowthForAccount, portfolioMarketGrowth, portfolioContributions,
    buildMonthlyTable, rollingAvg,
    // §3
    annuityPV, fireNumberSimple, fireNumberTwoPhase, coastFire,
    project, monteCarlo, planProjectionCurve, mulberry32,
  };
});
