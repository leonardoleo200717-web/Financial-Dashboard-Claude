#!/usr/bin/env node
/* Builds a schema-v2 import JSON from Leonardo's spreadsheet (2025 + 2026) and
   validates each month's liquid net worth against the sheet's "tot" column.
   Run: node generate-data.js  ->  writes financial-dashboard-2025-2026.json */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const E = require(path.join(ROOT, 'engine.js'));

let _n = 0; const uid = (p) => p + (++_n);

const accounts = [];
function acc(name, type, createdAt, archivedAt, color) {
  const a = { id: uid('acc-'), name, type, liquidity: type === 'pension' ? 'locked' : 'liquid', color, createdAt, archivedAt: archivedAt || null };
  accounts.push(a); return a;
}
const PAL = ['#3498db', '#1abc9c', '#9b59b6', '#2ecc71', '#16a085', '#e67e22', '#f1c40f'];
const ABN      = acc('ABN AMRO', 'current', '2025-01', null, PAL[0]);
const ABNsav   = acc('ABN Savings', 'savings', '2026-01', null, PAL[1]);
const EQUATE   = acc('EquatePlus (ASML)', 'broker', '2025-01', '2026-01', PAL[2]);
const SCAL     = acc('Scalable Capital', 'broker', '2025-01', null, PAL[3]);
const SCALsav  = acc('Scalable Savings', 'savings', '2026-03', null, PAL[4]);
const TRADE    = acc('Trade Republic', 'broker', '2025-01', '2026-03', PAL[5]);
const GENER    = acc('Generali (pensione)', 'pension', '2025-01', null, PAL[6]);

const snapshots = {};
function snap(a, ym, payday, minus1) {
  snapshots[a.id + '|' + ym] = { accountId: a.id, yearMonth: ym, balancePayday: payday, balancePaydayMinus1: (minus1 === undefined ? null : minus1) };
}
const entries = {};
function entry(ym, salaryNet, contribs) {
  entries[ym] = { yearMonth: ym, salaryNet: salaryNet, extraSalary: 0, otherIncome: 0, paydayDayOfMonth: 25, contributions: contribs || [], internalTransfers: [], flags: [] };
}
const C = (a, amount, source, kind) => ({ id: uid('c-'), accountId: a.id, amount, kind: kind || 'recurring', source: source || 'current' });

const M = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

/* ----------------------------- 2025 data ----------------------------- */
// [m24(minus1), m25(payday), income, equat, scalable, trade, tot, cEquate, cScalable]
const Y25 = [
  [64414, 68593, 4179, 6052, 27411, 23028, 125084, 600, 700],
  [60658, 73902, 13244, 7651, 31572, 25038, 138163, 600, 11200],
  [69331, 73671, 4340, 6716, 40557, 25038, 145982, 600, 702],
  [61036, 65300, 4264, 8101, 39747, 25093, 138241, 600, 704],
  [62390, 66698, 4308, 9555, 42500, 25192, 143945, 600, 704],
  [61444, 69785, 8341, 9460, 45389, 25192, 149826, 600, 705],
  [59481, 63841, 4360, 10000, 77200, 3000, 154041, 600, 30000],  // "30+"
  [36102, 40440, 4338, 10798, 104233, 3000, 158471, 700, 20000], // "20+"
  [38474, 42703, 4229, 12749, 105390, 3000, 163842, null, null],
  [34994, 39361, 4367, 11526, 119150, 2000, 172037, null, null],
  [36037, 40637, 4600, 9366, 120971, 850, 171824, null, null],
  [35501, 44598, 9097, 10800, 125561, 850, 181809, null, null],
];
Y25.forEach((r, i) => {
  const ym = '2025-' + M[i];
  const [m24, m25, income, equat, scal, trade, tot, cEq, cSc] = r;
  snap(ABN, ym, m25, m24);
  snap(EQUATE, ym, equat);
  snap(SCAL, ym, scal);
  snap(TRADE, ym, trade);
  const contribs = [];
  if (cEq != null) contribs.push(C(EQUATE, cEq, 'external'));        // ASML payroll share plan
  if (cSc != null) contribs.push(C(SCAL, cSc, 'current'));
  entry(ym, income, contribs);
});
snap(GENER, '2025-12', 8000);

/* ----------------------------- 2026 data ----------------------------- */
// [m24, m25, income, equat, scalable, scalableSa, trade, savings, tot, scRec, scOne]
const Y26 = [
  [5000, 9455, 4455, 14152, 135200, null, 1600, 30847, 191254, 713, null],
  [2556, 17712, 15156, 0, 153423, null, 1600, 34202, 206937, 1215, 13400],
  [2619, 7722, 5103, 0, 160000, 20000, 1600, 13202, 202524, 1383, 13000],
  [3171, 8300, 5129, 0, 177631, 20022, 0, 9000, 214953, 884, 8000],
  [3100, 8196, 5096, 0, 186426, 20063, 0, 9000, 223685, 1186, 1476],
];
Y26.forEach((r, i) => {
  const ym = '2026-' + M[i];
  const [m24, m25, income, equat, scal, scalSa, trade, sav, tot, scRec, scOne] = r;
  snap(ABN, ym, m25, m24);
  snap(SCAL, ym, scal);
  snap(ABNsav, ym, sav);
  if (scalSa != null) snap(SCALsav, ym, scalSa);
  // EquatePlus liquidated in Feb-2026 -> keep last real balance (Jan), then archived.
  if (ym === '2026-01') snap(EQUATE, ym, equat);
  // Trade Republic closed after Mar-2026 -> keep balances through Mar, then archived.
  if (E.ymCompare(ym, '2026-03') <= 0) snap(TRADE, ym, trade);
  const contribs = [];
  if (scRec != null) contribs.push(C(SCAL, scRec, 'current', 'recurring'));
  if (scOne != null) contribs.push(C(SCAL, scOne, 'current', 'one_off'));
  entry(ym, income, contribs);
});
snap(GENER, '2026-05', 10000);

/* ------------------------------ settings ----------------------------- */
const data = {
  schemaVersion: 2,
  accounts, snapshots, entries, plans: [],
  settings: {
    defaultPaydayDayOfMonth: 25,
    birthDate: '1990-01-01',   // PLACEHOLDER — update in Impostazioni for correct FIRE ages
    fire: {
      monthlyExpenseFire: 2500, swr: 0.035, realReturnBase: 0.05, realReturnOptimistic: 0.07,
      inflation: 0.025, coastAge: 45, fireAge: 55, pensionStartAge: 67, expectedPensionMonthly: 1200,
      box3DragAnnual: 0.0212, box3StartDate: '2027-05', marginalRateBox1: 0.37,
      monteCarlo: { meanReturn: 0.06, stdDev: 0.15, runs: 1000 },
    },
    milestones: [
      { id: uid('ms-'), date: '2027-05', label: 'Scadenza 30% ruling + Box 3', note: null },
      { id: uid('ms-'), date: '2030-12', label: 'iBonds Dec 2030 maturity — riallocare', note: null },
    ],
  },
};

/* ------------------------- validate vs "tot" ------------------------- */
const expectedTot = {};
Y25.forEach((r, i) => { expectedTot['2025-' + M[i]] = r[6]; });
Y26.forEach((r, i) => { expectedTot['2026-' + M[i]] = r[8]; });

let okCount = 0, badCount = 0;
console.log('\nMonth     liquidNetWorth   sheet "tot"   match   expenses(flags)');
console.log('-'.repeat(78));
E.monthSeries(data).forEach(ym => {
  const lnw = E.liquidNetWorth(data, ym);
  const exp = E.estimatedExpenses(data, ym);
  const tot = expectedTot[ym];
  const match = (tot == null) ? '   ' : (Math.abs(lnw - tot) < 0.5 ? ' OK' : 'BAD');
  if (tot != null) { if (match === ' OK') okCount++; else badCount++; }
  const expStr = exp.value == null ? '—' : Math.round(exp.value) + (exp.flags.length ? ' [' + exp.flags.join(',') + ']' : '');
  console.log(
    ym.padEnd(9) +
    String(lnw == null ? '—' : Math.round(lnw)).padStart(13) +
    String(tot == null ? '—' : tot).padStart(14) + '   ' + match + '     ' + expStr
  );
});
console.log('-'.repeat(78));
console.log(`Reconciliation vs sheet "tot": ${okCount} OK, ${badCount} mismatched`);
console.log(`Liquid net worth Dec-2025: ${E.fmtEUR(E.liquidNetWorth(data, '2025-12'))}`);
console.log(`Liquid net worth May-2026: ${E.fmtEUR(E.liquidNetWorth(data, '2026-05'))}`);
console.log(`Pension (Generali) Dec-2025: ${E.fmtEUR(E.lockedNetWorth(data, '2025-12'))}, May-2026: ${E.fmtEUR(E.lockedNetWorth(data, '2026-05'))}`);

const outFile = path.join(ROOT, 'financial-dashboard-2025-2026.json');
fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
console.log('\nWrote ' + outFile + ' (' + accounts.length + ' accounts, ' + Object.keys(snapshots).length + ' snapshots, ' + Object.keys(entries).length + ' months)');
if (badCount > 0) process.exit(1);
