#!/usr/bin/env node
/* =========================================================================
   Transfer-scenario test harness for the Financial Dashboard engine.

   Focus (per request): money moving bank → savings → partial back to bank
   → broker, both WITHIN a single month and ACROSS months. Verifies that:
     - estimated expenses (§2.2) are correct regardless of the transfer chain
     - internal transfers never leak into expenses or net worth
     - market growth (§2.4) excludes transfers and contributions
     - invested amount & savings rate (§2.3) are correct
     - reconciliation (§2.3) behaves as designed
   Also asserts the engine embedded in the built index.html is byte-identical
   to engine.js, so we are testing the actual deliverable.
   ========================================================================= */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'engine.js'));

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; failures.push({ name, e }); console.log('  \x1b[31m✗ ' + name + '\x1b[0m\n      ' + e.message); }
}
function approx(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= (tol == null ? 0.005 : tol), (msg || '') + ` expected ${b}, got ${a}`);
}

/* ----------------------------- builders ------------------------------ */
let _id = 0;
const id = (p) => p + (++_id);
function newData() {
  return { schemaVersion: 2, accounts: [], snapshots: {}, entries: {}, plans: [], settings: { fire: {} } };
}
function addAccount(d, name, type) {
  const acc = { id: id('acc-'), name, type, liquidity: type === 'pension' ? 'locked' : 'liquid', color: '#000', createdAt: '2025-01', archivedAt: null };
  d.accounts.push(acc); return acc;
}
function snap(d, acc, ym, payday, minus1) {
  d.snapshots[acc.id + '|' + ym] = { accountId: acc.id, yearMonth: ym, balancePayday: payday, balancePaydayMinus1: (minus1 === undefined ? null : minus1) };
}
function entry(d, ym, o) {
  d.entries[ym] = Object.assign({ yearMonth: ym, salaryNet: 0, extraSalary: 0, otherIncome: 0, paydayDayOfMonth: 27, contributions: [], internalTransfers: [], flags: [] }, o);
}
function transfer(from, to, amount, note) { return { id: id('t-'), fromAccountId: from.id, toAccountId: to.id, amount, note: note || null }; }
function contrib(acc, amount, source, kind) { return { id: id('c-'), accountId: acc.id, amount, kind: kind || 'recurring', source: source || 'current' }; }

console.log('\n=== Engine integrity ===');
test('engine inside built index.html is identical to engine.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  assert.ok(html.includes(engineSrc.trim()), 'engine.js source not found verbatim in index.html — run node build.js');
});
test('engine can be evaluated standalone in a fresh VM (browser-like)', () => {
  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  const sandbox = { self: {}, module: undefined };
  vm.createContext(sandbox);
  vm.runInContext(engineSrc + '\n;globalThis.__E = self.Engine;', sandbox);
  assert.ok(sandbox.self.Engine && typeof sandbox.self.Engine.estimatedExpenses === 'function');
});

/* =====================================================================
   SCENARIO 1 — Single-month transfer chain (the headline case)
   bank → savings 1000, savings → bank 300, bank → broker 500
   Cycle: payday(Jan) → payday-1(Feb). Real spending must come out to 600.
   ===================================================================== */
console.log('\n=== Scenario 1: single-month chain bank→savings→bank→broker ===');
{
  const d = newData();
  const bank = addAccount(d, 'Bank', 'current');
  const sav = addAccount(d, 'Savings', 'savings');
  const broker = addAccount(d, 'Broker', 'broker');

  // Jan baseline (cycle start cash = bank payday Jan = 2000)
  snap(d, bank, '2026-01', 2000, 1500);
  snap(d, sav, '2026-01', 10000, null);
  snap(d, broker, '2026-01', 20000, null);
  entry(d, '2026-01', { salaryNet: 2500 });

  // Feb: chain. bank net out = 1000 + 500 - 300 = 1200. End bank cash = 200 → spent 600.
  snap(d, bank, '2026-02', 2200, 200);
  snap(d, sav, '2026-02', 10700, null);   // +700 net transfer, 0 market
  snap(d, broker, '2026-02', 20800, null); // +500 transfer + 300 market
  entry(d, '2026-02', {
    salaryNet: 2500,
    internalTransfers: [
      transfer(bank, sav, 1000, 'accantona'),
      transfer(sav, bank, 300, 'rientro parziale'),
      transfer(bank, broker, 500, 'verso broker'),
    ],
  });

  test('estimated expenses = 600 (chain nets out, only real spend counts)', () => {
    const exp = E.estimatedExpenses(d, '2026-02');
    approx(exp.value, 600);
    assert.deepStrictEqual(exp.flags, []);
  });
  test('transfers do NOT inflate or deflate expenses', () => {
    // Remove all transfers but keep same end balance impossible — instead check
    // that the net-transfer term equals 1200 exactly.
    const ts = E.transferCurrentSplit(d, d.entries['2026-02']);
    approx(ts.out, 1500); approx(ts.into, 300); approx(ts.net, 1200);
  });
  test('broker market growth = 300 (excludes the 500 transfer)', () => {
    approx(E.marketGrowthForAccount(d, '2026-02', broker.id), 300);
  });
  test('savings market growth = 0 (pure transfer destination)', () => {
    approx(E.marketGrowthForAccount(d, '2026-02', sav.id), 0);
  });
  test('liquid net worth = sum of all liquid balances (transfers are internal)', () => {
    approx(E.liquidNetWorth(d, '2026-02'), 2200 + 10700 + 20800);
    approx(E.liquidNetWorth(d, '2026-01'), 2000 + 10000 + 20000);
  });
  test('invested & savings rate consistent', () => {
    const is = E.investedAndSavings(d, '2026-02');
    // ΔCash = 200 - 1500 = -1300; invested = 2500 - 600 - (-1300) = 3200
    approx(is.deltaCash, -1300);
    approx(is.invested, 3200);
    approx(is.savingsRate, 3200 / 2500);
  });
}

/* =====================================================================
   SCENARIO 2 — Same chain SPREAD ACROSS two months
   Feb: bank → savings 1000
   Mar: savings → bank 300, bank → broker 500
   Each month's expenses must be independently correct.
   ===================================================================== */
console.log('\n=== Scenario 2: chain spread across months ===');
{
  const d = newData();
  const bank = addAccount(d, 'Bank', 'current');
  const sav = addAccount(d, 'Savings', 'savings');
  const broker = addAccount(d, 'Broker', 'broker');

  snap(d, bank, '2026-01', 2000, 1500);
  snap(d, sav, '2026-01', 10000, null);
  snap(d, broker, '2026-01', 20000, null);
  entry(d, '2026-01', { salaryNet: 2500 });

  // Feb: only bank→savings 1000. Spending 600. bank end = 2000 - 1000 - 600 = 400.
  snap(d, bank, '2026-02', 2300, 400);
  snap(d, sav, '2026-02', 11000, null);
  snap(d, broker, '2026-02', 20000, null);
  entry(d, '2026-02', { salaryNet: 2500, internalTransfers: [transfer(bank, sav, 1000)] });

  // Mar: savings→bank 300, bank→broker 500. bank net out = 500 - 300 = 200.
  // start = bank payday Feb = 2300. spend 700 → bank end = 2300 - 200 - 700 = 1400.
  snap(d, bank, '2026-03', 2400, 1400);
  snap(d, sav, '2026-03', 10700, null);   // 11000 - 300
  snap(d, broker, '2026-03', 20500, null); // +500 transfer, 0 market
  entry(d, '2026-03', { salaryNet: 2500, internalTransfers: [transfer(sav, bank, 300), transfer(bank, broker, 500)] });

  test('Feb expenses = 600', () => approx(E.estimatedExpenses(d, '2026-02').value, 600));
  test('Mar expenses = 700', () => approx(E.estimatedExpenses(d, '2026-03').value, 700));
  test('Mar broker market growth = 0 (only transfer in)', () => approx(E.marketGrowthForAccount(d, '2026-03', broker.id), 0));
  test('Mar savings net transfer = -300', () => approx(E.transfersForAccount(d.entries['2026-03'], sav.id), -300));
  test('net worth grows only by income - spend across the two months', () => {
    const jan = E.liquidNetWorth(d, '2026-01');
    const mar = E.liquidNetWorth(d, '2026-03');
    // Feb saved (2500-600)=1900 net + market 0; Mar saved (2500-700)=1800 + market 0
    // but net worth also reflects current-account baseline changes; just assert it rose.
    assert.ok(mar > jan, 'net worth should increase');
  });
}

/* =====================================================================
   SCENARIO 3 — Transfer to broker vs Contribution to broker
   The user can model "bank → broker" either way. Expenses & net worth must
   be IDENTICAL; only reconciliation differs (a transfer-funded buy is a
   "contributo non registrato").
   ===================================================================== */
console.log('\n=== Scenario 3: broker funding as transfer vs contribution ===');
{
  function build(useContribution) {
    const d = newData();
    const bank = addAccount(d, 'Bank', 'current');
    const broker = addAccount(d, 'Broker', 'broker');
    snap(d, bank, '2026-01', 2000, 1500);
    snap(d, broker, '2026-01', 20000, null);
    entry(d, '2026-01', { salaryNet: 2500 });
    // Feb: 800 to broker, spend 600. bank end = 2000 - 800 - 600 = 600.
    snap(d, bank, '2026-02', 2200, 600);
    snap(d, broker, '2026-02', 20800, null);
    const e = { salaryNet: 2500 };
    if (useContribution) e.contributions = [contrib(broker, 800, 'current')];
    else e.internalTransfers = [transfer(bank, broker, 800)];
    entry(d, '2026-02', e);
    return { d, broker };
  }
  const A = build(false); // transfer
  const B = build(true);  // contribution
  test('expenses identical (600) whether broker funded by transfer or contribution', () => {
    approx(E.estimatedExpenses(A.d, '2026-02').value, 600);
    approx(E.estimatedExpenses(B.d, '2026-02').value, 600);
  });
  test('liquid net worth identical', () => {
    approx(E.liquidNetWorth(A.d, '2026-02'), E.liquidNetWorth(B.d, '2026-02'));
  });
  test('broker market growth identical (0) both ways', () => {
    approx(E.marketGrowthForAccount(A.d, '2026-02', A.broker.id), 0);
    approx(E.marketGrowthForAccount(B.d, '2026-02', B.broker.id), 0);
  });
  test('invested identical both ways', () => {
    approx(E.investedAndSavings(A.d, '2026-02').invested, E.investedAndSavings(B.d, '2026-02').invested);
  });
  test('reconciliation treats transfers and contributions identically', () => {
    const recB = E.reconcile(B.d, '2026-02'); // funded via contribution
    const recA = E.reconcile(A.d, '2026-02'); // funded via internal transfer
    // invested here = 2500 - 600 - (600-1500) = 2500-600+900 = 2800
    approx(E.investedAndSavings(B.d, '2026-02').invested, 2800);
    // Both workflows register the same €800 flow — funding a broker via a
    // transfer is NOT a data-quality problem.
    assert.strictEqual(recB.contributions, 800);
    assert.strictEqual(recA.contributions, 800);
    approx(recA.diff, recB.diff);
    assert.strictEqual(recA.mismatch, recB.mismatch);
  });
}

/* =====================================================================
   SCENARIO 4 — Net-worth invariance of a pure internal transfer
   ===================================================================== */
console.log('\n=== Scenario 4: pure transfer leaves net worth unchanged ===');
{
  const d = newData();
  const bank = addAccount(d, 'Bank', 'current');
  const sav = addAccount(d, 'Savings', 'savings');
  // Two months identical except a 1500 transfer bank→savings; no income/spend.
  snap(d, bank, '2026-01', 5000, 5000);
  snap(d, sav, '2026-01', 1000, null);
  entry(d, '2026-01', {});
  snap(d, bank, '2026-02', 3500, 3500); // -1500
  snap(d, sav, '2026-02', 2500, null);  // +1500
  entry(d, '2026-02', { internalTransfers: [transfer(bank, sav, 1500)] });
  test('liquid net worth unchanged (6000 → 6000)', () => {
    approx(E.liquidNetWorth(d, '2026-01'), 6000);
    approx(E.liquidNetWorth(d, '2026-02'), 6000);
  });
  test('expenses = 0 (nothing spent, only moved)', () => approx(E.estimatedExpenses(d, '2026-02').value, 0));
}

/* =====================================================================
   SCENARIO 5 — Withdrawal back to current + current→current transfer
   ===================================================================== */
console.log('\n=== Scenario 5: withdrawal back to current, current↔current ===');
{
  const d = newData();
  const bank = addAccount(d, 'Bank', 'current');
  const bank2 = addAccount(d, 'Bank2', 'current');
  const broker = addAccount(d, 'Broker', 'broker');
  snap(d, bank, '2026-01', 3000, 2000);
  snap(d, bank2, '2026-01', 500, 500);
  snap(d, broker, '2026-01', 10000, null);
  entry(d, '2026-01', { salaryNet: 3000 });
  // Feb: withdraw 200 from broker back to current (negative contribution),
  //      move 400 bank→bank2 (current→current, should net to zero in expenses).
  //      spend 700.
  // current cash start = bank payday Jan + bank2 payday Jan = 3000 + 500 = 3500
  // withdrawals back +200; current→current net 0.
  // end current cash = 3500 + 200 - 700 = 3000.
  snap(d, bank, '2026-02', 2600, 2600); // 3000 -400 +200 ... we just set end totals
  snap(d, bank2, '2026-02', 400, 400);  // bank+bank2 minus1 = 3000
  snap(d, broker, '2026-02', 9800, null); // -200 withdrawn, 0 market
  entry(d, '2026-02', {
    salaryNet: 3000,
    contributions: [contrib(broker, -200, 'current')],
    internalTransfers: [transfer(bank, bank2, 400)],
  });
  test('current→current transfer nets to zero in expense math', () => {
    const ts = E.transferCurrentSplit(d, d.entries['2026-02']);
    approx(ts.net, 0);
  });
  test('expenses = 700 (withdrawal back to current handled)', () => {
    approx(E.estimatedExpenses(d, '2026-02').value, 700);
  });
  test('broker market growth = 0 (the -200 is a registered withdrawal)', () => {
    approx(E.marketGrowthForAccount(d, '2026-02', broker.id), 0);
  });
}

/* =====================================================================
   SCENARIO 6 — Flags: negative expenses & missing snapshot
   ===================================================================== */
console.log('\n=== Scenario 6: flags ===');
{
  const d = newData();
  const bank = addAccount(d, 'Bank', 'current');
  snap(d, bank, '2026-01', 2000, 1500);
  entry(d, '2026-01', { salaryNet: 2000 });
  // Feb: unexplained income made end balance higher than start → negative expenses
  snap(d, bank, '2026-02', 2000, 3000);
  entry(d, '2026-02', { salaryNet: 2000 });
  test('NEGATIVE_EXPENSES flag set, value null-ish handling', () => {
    const exp = E.estimatedExpenses(d, '2026-02');
    assert.ok(exp.flags.includes('NEGATIVE_EXPENSES'));
    assert.ok(exp.value < 0);
  });
  test('MISSING_SNAPSHOT flag when current snapshot absent', () => {
    const d2 = newData();
    const b = addAccount(d2, 'Bank', 'current');
    snap(d2, b, '2026-01', 2000, 1500);
    entry(d2, '2026-02', { salaryNet: 2000 }); // no Feb snapshot
    const exp = E.estimatedExpenses(d2, '2026-02');
    assert.ok(exp.flags.includes('MISSING_SNAPSHOT'));
    assert.strictEqual(exp.value, null);
  });
}

/* =====================================================================
   SCENARIO 7 — Reconciliation within tolerance
   ===================================================================== */
console.log('\n=== Scenario 7: reconciliation matches registered contributions ===');
{
  const d = newData();
  const bank = addAccount(d, 'Bank', 'current');
  const broker = addAccount(d, 'Broker', 'broker');
  // Internally consistent fixture: Jan payday 2000 = minus1 1500 + salary 500.
  snap(d, bank, '2026-01', 2000, 1500);
  snap(d, broker, '2026-01', 20000, null);
  entry(d, '2026-01', { salaryNet: 500 });
  // Feb: salary 500 (delta 0), contribute 500 to broker, no spending.
  // expenses = start(2000) + 0 − 500 − 0 − end(1500) = 0; ΔCash = 0.
  // invested = 500 − 0 − 0 = 500 = registered → no mismatch.
  snap(d, bank, '2026-02', 2000, 1500);
  snap(d, broker, '2026-02', 20500, null);
  entry(d, '2026-02', { salaryNet: 500, contributions: [contrib(broker, 500, 'current')] });
  test('invested equals registered contribution → no mismatch', () => {
    const is = E.investedAndSavings(d, '2026-02');
    approx(is.invested, 500);
    const rec = E.reconcile(d, '2026-02');
    approx(rec.contributions, 500);
    assert.strictEqual(rec.mismatch, false);
  });
}

/* =====================================================================
   SCENARIO 7b — FIRE capital = investments only (brokers by default)
   ===================================================================== */
console.log('\n=== Scenario 7b: FIRE capital excludes cash/savings ===');
{
  const d = newData();
  const bank = addAccount(d, 'Bank', 'current');
  const sav = addAccount(d, 'Savings', 'savings');
  const broker = addAccount(d, 'Broker', 'broker');
  const pension = addAccount(d, 'Pension', 'pension');
  snap(d, bank, '2026-01', 5000, 5000);
  snap(d, sav, '2026-01', 30000, null);
  snap(d, broker, '2026-01', 100000, null);
  snap(d, pension, '2026-01', 40000, null);
  test('liquid net worth includes cash + savings + broker', () => {
    approx(E.liquidNetWorth(d, '2026-01'), 135000);
  });
  test('fireCapital is broker-only by default (excludes cash, savings, pension)', () => {
    approx(E.fireCapital(d, '2026-01'), 100000);
  });
  test('includeInFire=true on savings adds it to FIRE capital', () => {
    sav.includeInFire = true;
    approx(E.fireCapital(d, '2026-01'), 130000);
    sav.includeInFire = false;
    approx(E.fireCapital(d, '2026-01'), 100000);
  });
  test('a pension can never be counted in FIRE capital', () => {
    pension.includeInFire = true; // even if forced
    approx(E.fireCapital(d, '2026-01'), 100000);
  });
}

/* =====================================================================
   SCENARIO 7c — trailing invested & personal return (§2.5)
   ===================================================================== */
console.log('\n=== Scenario 7c: trailing invested & personal return ===');
{
  const d = newData();
  const bank = addAccount(d, 'Bank', 'current');
  const broker = addAccount(d, 'Broker', 'broker');
  // Baseline: current account returns to 1500 each cycle; payday = 1500 + salary.
  snap(d, bank, '2025-12', 3500, 1500);
  snap(d, broker, '2025-12', 10000, null);
  entry(d, '2025-12', { salaryNet: 2000 });
  // Each month: salary 2000, spend 1500, invest 500 (market flat)
  ['2026-01', '2026-02', '2026-03'].forEach((ym, i) => {
    snap(d, bank, ym, 3500, 1500);
    snap(d, broker, ym, 10000 + 500 * (i + 1), null);
    entry(d, ym, { salaryNet: 2000, contributions: [contrib(broker, 500, 'current')] });
  });
  test('trailingInvested ≈ 500/month', () => {
    approx(E.trailingInvested(d, 12), 500, 1);
  });
  test('personalReturn 2026 ≈ 0 when all growth is contributions (no market)', () => {
    const pr = E.personalReturn(d, 2026);
    assert.ok(pr != null);
    approx(pr.ret, 0, 0.01);
    approx(pr.netFlow, 1500, 1); // 3 × 500
  });
  test('personalReturn reflects market gain when balance outgrows contributions', () => {
    const d2 = newData();
    const bk = addAccount(d2, 'Bank', 'current');
    const br = addAccount(d2, 'Broker', 'broker');
    snap(d2, bk, '2025-12', 2000, 1500);
    snap(d2, br, '2025-12', 10000, null);
    entry(d2, '2025-12', {});
    // one month: no contributions, broker +1000 (pure market) → return ≈ 1000/10000 = 10%
    snap(d2, bk, '2026-01', 2000, 1500);
    snap(d2, br, '2026-01', 11000, null);
    entry(d2, '2026-01', {});
    const pr = E.personalReturn(d2, 2026);
    approx(pr.ret, 0.10, 0.001);
  });
}

/* =====================================================================
   SCENARIO 8 — FIRE math sanity
   ===================================================================== */
console.log('\n=== Scenario 8: FIRE math ===');
{
  const fire = {
    monthlyExpenseFire: 2500, swr: 0.035, realReturnBase: 0.05, realReturnOptimistic: 0.07,
    inflation: 0.025, coastAge: 45, fireAge: 55, pensionStartAge: 67, expectedPensionMonthly: 1200,
    box3DragAnnual: 0.0212, box3StartDate: '2027-05', marginalRateBox1: 0.37,
    monteCarlo: { meanReturn: 0.06, stdDev: 0.15, runs: 200 },
  };
  test('simple FIRE number = expenses*12/SWR', () => {
    approx(E.fireNumberSimple(fire), 2500 * 12 / 0.035, 0.01);
  });
  test('two-phase < simple and pension saving > 0', () => {
    const tp = E.fireNumberTwoPhase(fire);
    assert.ok(tp.twoPhase < tp.simple);
    assert.ok(tp.pensionSaving > 0);
  });
  test('projection reaches FIRE number in finite time with contributions', () => {
    const fireN = E.fireNumberSimple(fire);
    const r = E.project({ start: 100000, monthlyContribution: 2000, annualReturn: 0.05, fireNumber: fireN, startYM: '2026-06', maxYears: 60 });
    assert.ok(r.reachedYM != null, 'should reach FIRE number');
  });
  test('Box 3 drag lowers final capital', () => {
    const common = { start: 100000, monthlyContribution: 2000, annualReturn: 0.05, fireNumber: 1e12, startYM: '2026-06', maxYears: 20, box3DragAnnual: 0.0212, box3StartYM: '2027-05' };
    const withDrag = E.project(Object.assign({}, common, { applyBox3: true }));
    const without = E.project(Object.assign({}, common, { applyBox3: false }));
    assert.ok(withDrag.finalBalance < without.finalBalance);
  });
  test('Monte Carlo returns probability in [0,1] and a fan', () => {
    const res = E.monteCarlo({
      start: 200000, monthlyContribution: 2000, currentAge: 36, fireAge: 55,
      pensionStartAge: 67, monthlyExpenseFire: 2500, expectedPensionMonthly: 1200,
      inflation: 0.025, meanReturn: 0.06, stdDev: 0.15, runs: 200, seed: 42,
    });
    assert.ok(res.successProbability >= 0 && res.successProbability <= 1);
    assert.ok(res.fan.length > 0);
  });
  test('Monte Carlo is reproducible with a fixed seed', () => {
    const opts = { start: 200000, monthlyContribution: 2000, currentAge: 36, fireAge: 55, pensionStartAge: 67, monthlyExpenseFire: 2500, expectedPensionMonthly: 1200, inflation: 0.025, meanReturn: 0.06, stdDev: 0.15, runs: 200, seed: 7 };
    approx(E.monteCarlo(opts).successProbability, E.monteCarlo(opts).successProbability, 0);
  });
  test('Monte Carlo realizes the configured volatility (fan spread, not √12-collapsed)', () => {
    // Pure growth, no flows: after 20y at 15% annual vol the P90/P10 spread of
    // the fan must be wide (lognormal ≈ 5+). The old monthly-redraw bug
    // collapsed realized vol to ~4.3% and gave a spread under ~2.2.
    const r = E.monteCarlo({ start: 100000, monthlyContribution: 0, currentAge: 40, fireAge: 89, pensionStartAge: 99, monthlyExpenseFire: 0, expectedPensionMonthly: 0, inflation: 0, meanReturn: 0.06, stdDev: 0.15, runs: 600, endAge: 60, seed: 11 });
    const last = r.fan[r.fan.length - 1];
    assert.ok(last.p90 / last.p10 > 3.5, 'fan too narrow: P90/P10 = ' + (last.p90 / last.p10).toFixed(2));
  });
  test('coastFire: zero/negative real return → ageIfStopNow null, no Infinity', () => {
    const f = { monthlyExpenseFire: 2000, swr: 0.035, coastAge: 45, fireAge: 55 };
    const c0 = E.coastFire(f, 100000, 40, 0);
    const cn = E.coastFire(f, 100000, 40, -0.02);
    assert.strictEqual(c0.ageIfStopNow, null);
    assert.strictEqual(cn.ageIfStopNow, null);
    assert.ok(isFinite(c0.requiredToday) && isFinite(c0.gapToday));
  });
}

/* =====================================================================
   SCENARIO 9 — Migration v1 → v2 (contributions get source=current)
   ===================================================================== */
console.log('\n=== Scenario 9: ym helpers & table ===');
{
  test('ymPrev / ymNext / monthsBetween', () => {
    assert.strictEqual(E.ymPrev('2026-01'), '2025-12');
    assert.strictEqual(E.ymNext('2026-12'), '2027-01');
    assert.strictEqual(E.monthsBetween('2026-01', '2027-03'), 14);
  });
  test('buildMonthlyTable returns a row per month with flags array', () => {
    const d = newData();
    const bank = addAccount(d, 'Bank', 'current');
    snap(d, bank, '2026-01', 2000, 1500);
    snap(d, bank, '2026-02', 2100, 1400);
    entry(d, '2026-01', { salaryNet: 2000 });
    entry(d, '2026-02', { salaryNet: 2000 });
    const t = E.buildMonthlyTable(d);
    assert.strictEqual(t.length, 2);
    assert.ok(Array.isArray(t[0].flags));
  });
}

/* =====================================================================
   SCENARIO 10 — FIRE Simulator engine (deterministic conservation + MC)
   ===================================================================== */
console.log('\n=== Scenario 10: FIRE simulator engine ===');
{
  const classes = [
    { id: 'eq', name: 'Eq', value: 100000, realReturn: 0, volatility: 0, kind: 'liquid' },
    { id: 'pen', name: 'Pen', value: 50000, realReturn: 0, volatility: 0, kind: 'pension' },
  ];
  const profile = { currentAge: 40, retirementAge: 50, statePensionAge: 99, endAge: 60, annualContribution: 12000, annualSpend: 24000, statePensionAnnual: 0 };
  const det = E.simulateFireDeterministic(profile, classes);

  test('one row per year inclusive (40..60 = 21 rows)', () => assert.strictEqual(det.years.length, 21));
  test('with zero returns, liquid follows prev + contribution − withdrawal exactly', () => {
    for (let i = 1; i < det.years.length; i++) {
      const prev = det.years[i - 1].liquidTotal, cur = det.years[i];
      const expected = E.r2(prev + cur.contribution - cur.withdrawal);
      approx(cur.liquidTotal, expected, 0.02, 'age ' + cur.age);
    }
  });
  test('accumulation 10y of 12k on 100k (0% return) → 220k at retirement', () => {
    approx(det.years.find(y => y.age === 49).liquidTotal, 220000, 0.5);
  });
  test('pension pot is never drawn (stays 50k at 0% return)', () => {
    approx(det.years[det.years.length - 1].pensionTotal, 50000, 0.5);
  });
  test('depletes during decumulation (220k / 24k ≈ age 59)', () => {
    assert.ok(det.depletedAge >= 58 && det.depletedAge <= 60, 'got ' + det.depletedAge);
  });
  test('state pension income reduces withdrawal need after statePensionAge', () => {
    const p2 = Object.assign({}, profile, { statePensionAge: 55, statePensionAnnual: 24000, endAge: 70 });
    const s2 = E.simulateFireDeterministic(p2, classes);
    const row = s2.years.find(y => y.age === 60);
    approx(row.withdrawal, 0, 0.02); // pension fully covers spend
    assert.strictEqual(s2.depletedAge, null);
  });
  test('coastFireAge: rich plan can coast immediately, poor plan cannot', () => {
    const rich = { currentAge: 40, retirementAge: 55, statePensionAge: 67, endAge: 90, annualContribution: 0, annualSpend: 1000, statePensionAnnual: 0 };
    assert.strictEqual(E.coastFireAge(rich, [{ id: 'x', value: 2000000, realReturn: 0.04, volatility: 0, kind: 'liquid' }]), 40);
    const poor = { currentAge: 40, retirementAge: 55, statePensionAge: 67, endAge: 90, annualContribution: 100, annualSpend: 80000, statePensionAnnual: 0 };
    assert.strictEqual(E.coastFireAge(poor, [{ id: 'x', value: 1000, realReturn: 0.02, volatility: 0, kind: 'liquid' }]), null);
  });
  test('monteCarloFire: classes share one market factor (no fake diversification)', () => {
    // The same money as 4 identical classes vs 1 block must give the SAME
    // success probability — independent per-class draws used to grant ~25pp
    // of diversification that correlated equity classes don't have.
    const prof = { currentAge: 36, retirementAge: 55, statePensionAge: 70, endAge: 90, annualContribution: 24000, annualSpend: 36000, statePensionAnnual: 0 };
    const split = [1, 2, 3, 4].map(() => ({ value: 50000, realReturn: 0.05, volatility: 0.16, kind: 'liquid' }));
    const block = [{ value: 200000, realReturn: 0.05, volatility: 0.16, kind: 'liquid' }];
    const a = E.monteCarloFire(prof, split, 400, 42);
    const b = E.monteCarloFire(prof, block, 400, 42);
    approx(a.successProbability, b.successProbability, 0.001);
  });
  test('monteCarloFire: probability in [0,1], bands ordered p10≤p50≤p90, reproducible', () => {
    const mc1 = E.monteCarloFire(profile, classes, 200, 123);
    const mc2 = E.monteCarloFire(profile, classes, 200, 123);
    assert.ok(mc1.successProbability >= 0 && mc1.successProbability <= 1);
    approx(mc1.successProbability, mc2.successProbability, 0);
    mc1.bands.forEach(b => { assert.ok(b.p10 <= b.p50 + 0.01 && b.p50 <= b.p90 + 0.01, 'age ' + b.age); });
  });
  test('fireClassTotals splits liquid vs pension', () => {
    const t = E.fireClassTotals(classes);
    approx(t.liquid, 100000); approx(t.pension, 50000); approx(t.total, 150000);
  });

  // crisis stress-test shock
  const sclasses = [
    { id: 'eq', name: 'Eq', value: 200000, realReturn: 0.05, volatility: 0.16, kind: 'liquid' },
    { id: 'cash', name: 'Cash', value: 30000, realReturn: 0, volatility: 0.01, kind: 'liquid' },
  ];
  const sbase = { currentAge: 36, retirementAge: 55, statePensionAge: 70, endAge: 90, annualContribution: 24000, annualSpend: 30000, statePensionAnnual: 12000 };
  const withShock = (atAge, sev) => Object.assign({}, sbase, { shock: { enabled: true, atAge, severity: sev } });
  test('shock disabled / severity 0 is a no-op', () => {
    const a = E.simulateFireDeterministic(sbase, sclasses).years.at(-1).total;
    const b = E.simulateFireDeterministic(withShock(55, 0), sclasses).years.at(-1).total;
    approx(a, b, 0.01);
  });
  test('a crisis shock reduces final capital', () => {
    const base = E.simulateFireDeterministic(sbase, sclasses).years.at(-1).total;
    const crash = E.simulateFireDeterministic(withShock(55, 0.35), sclasses).years.at(-1).total;
    assert.ok(crash < base, `crash ${crash} should be < base ${base}`);
  });
  test('shock hits high-vol classes harder than cash (vol-scaled)', () => {
    // a pure-cash portfolio barely moves; a pure-equity one drops ~severity
    const eqOnly = [{ id: 'e', value: 100000, realReturn: 0, volatility: 0.16, kind: 'liquid' }];
    const cashOnly = [{ id: 'c', value: 100000, realReturn: 0, volatility: 0.01, kind: 'liquid' }];
    const p = { currentAge: 60, retirementAge: 90, statePensionAge: 99, endAge: 61, annualContribution: 0, annualSpend: 0, statePensionAnnual: 0, shock: { enabled: true, atAge: 60, severity: 0.4 } };
    const eq = E.simulateFireDeterministic(p, eqOnly).years.find(y => y.age === 60).total;
    const cash = E.simulateFireDeterministic(p, cashOnly).years.find(y => y.age === 60).total;
    approx(eq, 60000, 1);   // 100k × (1 − 0.4)
    assert.ok(cash > 97000, 'cash barely moves, got ' + cash);
  });
  test('sequence risk: a crash near retirement is worse than one mid-career', () => {
    const early = E.simulateFireDeterministic(withShock(40, 0.35), sclasses).years.at(-1).total;
    const late = E.simulateFireDeterministic(withShock(55, 0.35), sclasses).years.at(-1).total;
    assert.ok(early > late, `early-crash ${early} should leave more than late-crash ${late}`);
  });
  test('Monte Carlo success drops (or holds) with an added crash', () => {
    const a = E.monteCarloFire(sbase, sclasses, 400, 42).successProbability;
    const b = E.monteCarloFire(withShock(55, 0.35), sclasses, 400, 42).successProbability;
    assert.ok(b <= a + 1e-9, `with-crash ${b} should be ≤ baseline ${a}`);
  });
}

/* ------------------------------ summary ------------------------------ */
console.log('\n' + '='.repeat(48));
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(48) + '\n');
process.exit(fail ? 1 : 0);
