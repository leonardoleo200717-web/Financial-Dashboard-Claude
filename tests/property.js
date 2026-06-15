#!/usr/bin/env node
/* =========================================================================
   Property / fuzz test harness — 100 randomized scenarios + edge cases.

   Strategy: a ground-truth simulator generates an *internally consistent*
   monthly history (salary, extra, other income, spending, contributions,
   withdrawals, internal transfers, and injected market moves), updating each
   account balance with the SAME equations the engine's definitions imply.
   We then hand the resulting snapshots/entries to the engine and assert it
   recovers: expenses, market growth, net worth, FIRE capital, invested amount,
   savings rate, and the reconciliation identity — for every month.

   A failure here means either a real engine bug or a mismatch in my model;
   each scenario prints its seed so it can be reproduced.
   ========================================================================= */
const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'engine.js'));

let pass = 0, fail = 0, assertions = 0;
const failed = [];
function check(label, cond, detail) {
  assertions++;
  if (!cond) throw new Error(label + (detail ? ' — ' + detail : ''));
}

const TOL = 0.05;
const near = (a, b) => Math.abs(a - b) <= TOL;

/* ----------------------------- simulator ----------------------------- */
function ym(y, m) { return y + '-' + String(m).padStart(2, '0'); }

function buildHistory(rng, scenarioId) {
  const rand = (lo, hi) => lo + (hi - lo) * rng();
  const ri = (lo, hi) => Math.floor(rand(lo, hi + 1));
  const pick = (arr) => arr[ri(0, arr.length - 1)];

  let _id = 0; const uid = (p) => p + scenarioId + '-' + (++_id);
  const accounts = [];
  const mk = (name, type) => { const a = { id: uid('a'), name, type, liquidity: type === 'pension' ? 'locked' : 'liquid', color: '#000', createdAt: '2024-01', archivedAt: null }; accounts.push(a); return a; };

  const bank = mk('Bank', 'current');
  const others = [];
  const nOther = ri(1, 4);
  for (let i = 0; i < nOther; i++) others.push(mk('A' + i, pick(['broker', 'broker', 'savings', 'pension'])));

  const snapshots = {}, entries = {};
  const truth = {}; // ym -> { spending, market:{accId:val}, deltaCashBase }

  const nMonths = ri(2, 6);
  let startY = 2024, startM = ri(1, 9);

  // initial balances
  let bankMinus1 = Math.round(rand(-500, 4000));
  let bankPayday = bankMinus1 + Math.round(rand(800, 3000)); // initial salary baked in
  const bal = {}; others.forEach(a => bal[a.id] = Math.round(rand(0, 80000)));

  for (let k = 0; k < nMonths; k++) {
    let y = startY, m = startM + k;
    while (m > 12) { m -= 12; y += 1; }
    const key = ym(y, m);

    const salary = Math.round(rand(800, 3500));
    const extra = rng() < 0.25 ? Math.round(rand(500, 4000)) : 0;
    const other = rng() < 0.4 ? Math.round(rand(0, 1500)) : 0;
    const spending = Math.round(rand(0, 3500));

    const contributions = [];
    const transfers = [];
    let contribOutCurrent = 0;   // positive deposits source=current (cash out of bank)
    let withdrawalsBack = 0;     // |negative source=current| (cash back to bank)
    const contribTotalByAcc = {}; // signed, all sources, per account (hits balance)
    others.forEach(a => contribTotalByAcc[a.id] = 0);

    // contributions
    others.forEach(a => {
      const nC = ri(0, 2);
      for (let c = 0; c < nC; c++) {
        let amount, source;
        if (a.type === 'pension') { source = rng() < 0.6 ? 'external' : 'current'; amount = Math.round(rand(50, 900)); }
        else {
          source = rng() < 0.7 ? 'current' : 'external';
          // allow occasional withdrawal (negative) only from current source
          amount = (source === 'current' && rng() < 0.2) ? -Math.round(rand(50, 1500)) : Math.round(rand(50, 3000));
        }
        contributions.push({ id: uid('c'), accountId: a.id, amount, kind: pick(['recurring', 'one_off']), source });
        contribTotalByAcc[a.id] += amount;
        if (source === 'current') { if (amount >= 0) contribOutCurrent += amount; else withdrawalsBack += -amount; }
      }
    });

    // transfers (between any two distinct accounts incl. bank)
    const transferNetByAcc = {}; accounts.forEach(a => transferNetByAcc[a.id] = 0);
    let bankTransferOut = 0, bankTransferIn = 0;
    const nT = ri(0, 3);
    for (let t = 0; t < nT; t++) {
      const from = pick(accounts); let to = pick(accounts);
      if (to.id === from.id) continue;
      const amount = Math.round(rand(50, 5000));
      transfers.push({ id: uid('t'), fromAccountId: from.id, toAccountId: to.id, amount, note: null });
      transferNetByAcc[from.id] -= amount; transferNetByAcc[to.id] += amount;
      if (from.id === bank.id) bankTransferOut += amount;
      if (to.id === bank.id) bankTransferIn += amount;
    }

    // market moves for non-current accounts
    const market = {};
    others.forEach(a => { market[a.id] = Math.round(rand(-2000, 3000)); });

    // ---- update CURRENT (bank) for this cycle ----
    if (k === 0) {
      // first month: use the pre-seeded bankMinus1/bankPayday as-is (no cycle math)
    } else {
      const netTransfersOutBank = bankTransferOut - bankTransferIn;
      bankMinus1 = bankPayday /*prev payday*/ + other + withdrawalsBack - spending - contribOutCurrent - netTransfersOutBank;
      bankPayday = bankMinus1 + salary + extra;
    }

    // ---- update non-current balances ----
    others.forEach(a => {
      bal[a.id] = bal[a.id] + contribTotalByAcc[a.id] + transferNetByAcc[a.id] + market[a.id];
    });

    // ---- record snapshots ----
    snapshots[bank.id + '|' + key] = { accountId: bank.id, yearMonth: key, balancePayday: bankPayday, balancePaydayMinus1: bankMinus1 };
    others.forEach(a => { snapshots[a.id + '|' + key] = { accountId: a.id, yearMonth: key, balancePayday: bal[a.id], balancePaydayMinus1: null }; });

    entries[key] = { yearMonth: key, salaryNet: salary, extraSalary: extra, otherIncome: other, paydayDayOfMonth: 27, contributions, internalTransfers: transfers, flags: [] };
    truth[key] = { spending, market, contribOutCurrent, withdrawalsBack, k };
  }

  return { data: { schemaVersion: 2, accounts, snapshots, entries, plans: [], settings: { fire: {} } }, truth, bank, others };
}

/* ----------------------------- invariants ---------------------------- */
function checkScenario(h) {
  const { data, truth, bank, others } = h;
  const months = E.monthSeries(data);
  months.forEach((key, idx) => {
    const t = truth[key];
    const prev = E.ymPrev(key);
    const hasPrev = months.includes(prev);

    // 1) net worth = sum of liquid balances
    let liq = 0; data.accounts.forEach(a => { if (!E.isLiquid(a)) return; const s = E.getSnapshot(data, a.id, key); if (s) liq += s.balancePayday; });
    check('liquidNetWorth', near(E.liquidNetWorth(data, key), liq), key);

    // 2) FIRE capital = sum of broker balances (default include)
    let fc = 0; data.accounts.forEach(a => { if (a.type !== 'broker') return; const s = E.getSnapshot(data, a.id, key); if (s) fc += s.balancePayday; });
    check('fireCapital', near(E.fireCapital(data, key), fc), key);

    // 3) total = liquid + locked
    check('totalNetWorth', near(E.totalNetWorth(data, key), (E.liquidNetWorth(data, key) || 0) + (E.lockedNetWorth(data, key) || 0)), key);

    if (!hasPrev) return; // expenses/market/invested need a previous month

    // 4) expenses == injected spending
    const exp = E.estimatedExpenses(data, key);
    check('expenses==spending', exp.value != null && near(exp.value, t.spending), key + ` got ${exp.value} want ${t.spending}`);

    // 5) market growth per non-current account == injected market
    others.forEach(a => {
      if (!months.includes(prev)) return;
      const mg = E.marketGrowthForAccount(data, key, a.id);
      check('marketGrowth ' + a.type, mg != null && near(mg, t.market[a.id]), key + ` acc ${a.id} got ${mg} want ${t.market[a.id]}`);
    });

    // 6) portfolio market growth == sum of injected market over non-current
    let pm = 0; others.forEach(a => pm += t.market[a.id]);
    check('portfolioMarketGrowth', near(E.portfolioMarketGrowth(data, key), pm), key);

    // 7) invested == income - expenses - ΔCashBaseline
    const is = E.investedAndSavings(data, key);
    const curNow = E.sumCurrent(data, key, 'balancePaydayMinus1').sum;
    const curPrev = E.sumCurrent(data, prev, 'balancePaydayMinus1').sum;
    const inc = (data.entries[key].salaryNet || 0) + (data.entries[key].extraSalary || 0) + (data.entries[key].otherIncome || 0);
    const expectedInvested = inc - t.spending - (curNow - curPrev);
    check('invested', is.invested != null && near(is.invested, expectedInvested), key + ` got ${is.invested} want ${expectedInvested}`);

    // 8) savings rate identity
    if (inc > 0) check('savingsRate', near(is.savingsRate, is.invested / inc), key);

    // 9) reconciliation diff identity = currentContribNet - invested
    const rec = E.reconcile(data, key);
    const ccn = E.contributionSplit(data.entries[key]).currentNet;
    check('reconcile diff', near(rec.diff, ccn - is.invested), key);
  });
}

/* ------------------------------ run 100 ------------------------------ */
console.log('\n=== Property test: 100 randomized consistent histories ===');
const BASE_SEED = 0xC0FFEE;
for (let s = 1; s <= 100; s++) {
  const rng = E.mulberry32(BASE_SEED + s * 2654435761 >>> 0);
  let h;
  try {
    h = buildHistory(rng, s);
    checkScenario(h);
    pass++;
  } catch (e) {
    fail++;
    failed.push({ s, msg: e.message });
    if (failed.length <= 8) console.log(`  \x1b[31m✗ scenario ${s}\x1b[0m: ${e.message}`);
  }
}
console.log(`  ${pass}/100 scenarios passed  (${assertions} invariant checks)`);

/* --------------------------- edge cases ------------------------------ */
console.log('\n=== Deterministic edge cases ===');
function ecase(name, fn) {
  assertions++;
  try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; failed.push({ s: name, msg: e.message }); console.log('  \x1b[31m✗ ' + name + '\x1b[0m — ' + e.message); }
}
const D = () => ({ schemaVersion: 2, accounts: [], snapshots: {}, entries: {}, plans: [], settings: { fire: {} } });
let _e = 0; const eid = p => p + '-e' + (++_e);
function A(d, name, type) { const a = { id: eid(name), name, type, liquidity: type === 'pension' ? 'locked' : 'liquid', color: '#000', createdAt: '2024-01', archivedAt: null }; d.accounts.push(a); return a; }
function S(d, a, k, p, m) { d.snapshots[a.id + '|' + k] = { accountId: a.id, yearMonth: k, balancePayday: p, balancePaydayMinus1: m === undefined ? null : m }; }
function EN(d, k, o) { d.entries[k] = Object.assign({ yearMonth: k, salaryNet: 0, extraSalary: 0, otherIncome: 0, paydayDayOfMonth: 27, contributions: [], internalTransfers: [], flags: [] }, o); }

ecase('empty data: net worth null, no months, no crash', () => {
  const d = D();
  assert.strictEqual(E.monthSeries(d).length, 0);
  assert.strictEqual(E.liquidNetWorth(d, '2026-01'), null);
  assert.deepStrictEqual(E.buildMonthlyTable(d), []);
});
ecase('single month, single account: MISSING_SNAPSHOT for expenses', () => {
  const d = D(); const b = A(d, 'B', 'current'); S(d, b, '2026-01', 2000, 1500); EN(d, '2026-01', { salaryNet: 2000 });
  assert.ok(E.estimatedExpenses(d, '2026-01').flags.includes('MISSING_SNAPSHOT'));
});
ecase('zero income: savings rate null, not NaN/Infinity', () => {
  const d = D(); const b = A(d, 'B', 'current'); S(d, b, '2026-01', 1000, 1000); S(d, b, '2026-02', 1000, 1000); EN(d, '2026-01', {}); EN(d, '2026-02', {});
  const is = E.investedAndSavings(d, '2026-02');
  assert.strictEqual(is.savingsRate, null);
});
ecase('negative balances handled (liquid net worth can be < 0)', () => {
  const d = D(); const b = A(d, 'B', 'current'); S(d, b, '2026-01', -500, -800);
  assert.ok(E.liquidNetWorth(d, '2026-01') === -500);
});
ecase('pension never counts in FIRE capital even if includeInFire forced', () => {
  const d = D(); const p = A(d, 'P', 'pension'); p.includeInFire = true; S(d, p, '2026-01', 50000);
  assert.strictEqual(E.fireCapital(d, '2026-01'), null);
  assert.strictEqual(E.lockedNetWorth(d, '2026-01'), 50000);
});
ecase('two current accounts: current→current transfer nets to zero in expenses', () => {
  const d = D(); const b1 = A(d, 'B1', 'current'); const b2 = A(d, 'B2', 'current');
  S(d, b1, '2026-01', 3000, 3000); S(d, b2, '2026-01', 1000, 1000); EN(d, '2026-01', {});
  // spend 500 total, move 400 b1->b2
  S(d, b1, '2026-02', 2600 - 400, 2600 - 400); S(d, b2, '2026-02', 1400, 1400); EN(d, '2026-02', { internalTransfers: [{ id: 't', fromAccountId: b1.id, toAccountId: b2.id, amount: 400, note: null }] });
  // start cur = 4000, end cur = 2200+1400=3600 -> spent 400? recompute: start 4000, transfers net 0, end 3600 => exp 400
  approxEq(E.estimatedExpenses(d, '2026-02').value, 400);
});
ecase('NEGATIVE_EXPENSES when unexplained income inflates end balance', () => {
  const d = D(); const b = A(d, 'B', 'current'); S(d, b, '2026-01', 1000, 1000); S(d, b, '2026-02', 5000, 5000); EN(d, '2026-01', {}); EN(d, '2026-02', {});
  assert.ok(E.estimatedExpenses(d, '2026-02').flags.includes('NEGATIVE_EXPENSES'));
});
ecase('year boundary Dec->Jan in expense cycle', () => {
  const d = D(); const b = A(d, 'B', 'current'); S(d, b, '2025-12', 2000, 1500); S(d, b, '2026-01', 2200, 1300); EN(d, '2025-12', { salaryNet: 2000 }); EN(d, '2026-01', { salaryNet: 2000 });
  const exp = E.estimatedExpenses(d, '2026-01');
  approxEq(exp.value, 2000 - 1300); // 700
});
ecase('archived account drops out of net worth after archive month', () => {
  const d = D(); const b = A(d, 'B', 'current'); const k = A(d, 'K', 'broker');
  S(d, b, '2026-01', 1000, 1000); S(d, k, '2026-01', 5000); k.archivedAt = '2026-01';
  // no Feb snapshot for k
  S(d, b, '2026-02', 1000, 1000);
  assert.strictEqual(E.liquidNetWorth(d, '2026-01'), 6000);
  assert.strictEqual(E.liquidNetWorth(d, '2026-02'), 1000);
});
ecase('annuityPV with r=0 equals annual*years', () => { approxEq(E.annuityPV(1000, 10, 0), 10000); });
ecase('fireNumberSimple = expenses*12/swr', () => { approxEq(E.fireNumberSimple({ monthlyExpenseFire: 2000, swr: 0.04 }), 2000 * 12 / 0.04); });
ecase('two-phase: pension >= expenses => no legacy capital', () => {
  const f = { monthlyExpenseFire: 1000, swr: 0.035, realReturnBase: 0.05, fireAge: 50, pensionStartAge: 67, expectedPensionMonthly: 2000 };
  const tp = E.fireNumberTwoPhase(f);
  approxEq(tp.legacyCapital, 0);
});
ecase('project with 0 return reaches target by contributions alone', () => {
  const r = E.project({ start: 0, monthlyContribution: 1000, annualReturn: 0, fireNumber: 12000, startYM: '2026-01', maxYears: 5 });
  assert.ok(r.reachedYM != null);
});
ecase('project negative return never reaches an unreachable target', () => {
  const r = E.project({ start: 1000, monthlyContribution: 0, annualReturn: -0.1, fireNumber: 1e9, startYM: '2026-01', maxYears: 5 });
  assert.strictEqual(r.reachedYM, null);
});
ecase('coastFire: currentLiquid >= number => ageIfStopNow = currentAge', () => {
  const f = { monthlyExpenseFire: 1000, swr: 0.04, coastAge: 45, fireAge: 55 };
  const c = E.coastFire(f, 999999999, 40, 0.05);
  approxEq(c.ageIfStopNow, 40);
});
ecase('coastFire: currentLiquid = 0 => ageIfStopNow null (no crash)', () => {
  const f = { monthlyExpenseFire: 1000, swr: 0.04, coastAge: 45, fireAge: 55 };
  const c = E.coastFire(f, 0, 40, 0.05);
  assert.strictEqual(c.ageIfStopNow, null);
});
ecase('monteCarlo: probability within [0,1], reproducible with seed', () => {
  const o = { start: 100000, monthlyContribution: 1000, currentAge: 40, fireAge: 55, pensionStartAge: 67, monthlyExpenseFire: 2000, expectedPensionMonthly: 1000, inflation: 0.02, meanReturn: 0.05, stdDev: 0.12, runs: 100, seed: 99 };
  const a = E.monteCarlo(o), b = E.monteCarlo(o);
  assert.ok(a.successProbability >= 0 && a.successProbability <= 1);
  approxEq(a.successProbability, b.successProbability, 0);
});
ecase('trailingInvested null when nothing computable', () => {
  const d = D(); const b = A(d, 'B', 'current'); S(d, b, '2026-01', 1000, 1000); EN(d, '2026-01', {});
  assert.strictEqual(E.trailingInvested(d, 12), null);
});
ecase('personalReturn null with a single month / no flows-from-prev', () => {
  const d = D(); const k = A(d, 'K', 'broker'); S(d, k, '2026-01', 1000); EN(d, '2026-01', {});
  assert.strictEqual(E.personalReturn(d, 2026), null);
});
ecase('migration v1: contributions get source=current (via normalize semantics)', () => {
  // emulate the engine's source defaulting expectation
  const c = { id: 'x', accountId: 'a', amount: 100, kind: 'recurring' };
  // engine treats missing source as non-external in contributionSplit:
  const split = E.contributionSplit({ contributions: [c] });
  approxEq(split.currentNet, 100);
});
ecase('ym helpers: leap across multiple years', () => {
  assert.strictEqual(E.ymNext('2024-12'), '2025-01');
  assert.strictEqual(E.ymPrev('2025-01'), '2024-12');
  assert.strictEqual(E.monthsBetween('2024-01', '2026-01'), 24);
});
ecase('rollingAvg skips nulls and averages a window', () => {
  const r = E.rollingAvg([null, 100, 200, null, 300], null, [], 3);
  approxEq(r[2], 150); // avg(100,200)
});
ecase('large numbers do not lose cents precision badly', () => {
  const d = D(); const k = A(d, 'K', 'broker'); S(d, k, '2026-01', 1234567.89); S(d, k, '2026-02', 1234567.89 + 0.01);
  EN(d, '2026-01', {}); EN(d, '2026-02', {});
  approxEq(E.marketGrowthForAccount(d, '2026-02', k.id), 0.01, 0.001);
});

function approxEq(a, b, tol) { assert.ok(Math.abs(a - b) <= (tol == null ? TOL : tol), `expected ${b}, got ${a}`); }

/* ------------------------------ summary ------------------------------ */
console.log('\n' + '='.repeat(56));
console.log(`  TOTAL: ${pass} passed, ${fail} failed  (${assertions} assertions)`);
if (failed.length) {
  console.log('  Failures:');
  failed.slice(0, 15).forEach(f => console.log(`   - [${f.s}] ${f.msg}`));
}
console.log('='.repeat(56) + '\n');
process.exit(fail ? 1 : 0);
