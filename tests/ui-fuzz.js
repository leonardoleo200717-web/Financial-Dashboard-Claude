#!/usr/bin/env node
/* UI fuzz: load the real index.html once in jsdom (Chart stubbed), then push
   30 random-but-valid datasets through FD.load() and render EVERY tab + open
   the entry form for a random month. Any uncaught error / console.error fails.
   Catches UI-layer bugs (null rendering, chart construction, empty states)
   that the engine property test can't see. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const E = require(path.join(__dirname, '..', 'engine.js'));

const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script src="https:\/\/cdn[^"]+"><\/script>/, '');

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/',
  beforeParse(w) {
    w.Chart = function () { w.__charts = (w.__charts || 0) + 1; }; w.Chart.prototype.destroy = function () {};
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    if (!w.crypto) w.crypto = {}; w.crypto.randomUUID = () => 'id-' + Math.random().toString(36).slice(2);
    w.confirm = () => true; w.alert = () => {}; w.prompt = () => 'CONFERMA';
    w.console.error = (...a) => errors.push('console.error: ' + a.join(' '));
    w.addEventListener('error', e => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
  },
});
const { window } = dom, { document } = window;

/* ------- random valid dataset generator ------- */
function genData(rng, sid) {
  const rand = (lo, hi) => lo + (hi - lo) * rng();
  const ri = (lo, hi) => Math.floor(rand(lo, hi + 1));
  const pick = a => a[ri(0, a.length - 1)];
  let _i = 0; const uid = p => p + sid + '-' + (++_i);
  const accounts = [], snapshots = {}, entries = {};
  const types = ['current', 'savings', 'broker', 'broker', 'pension'];
  const nAcc = ri(1, 6);
  for (let i = 0; i < nAcc; i++) {
    const type = i === 0 ? 'current' : pick(types);
    accounts.push({ id: uid('a'), name: type + i, type, liquidity: type === 'pension' ? 'locked' : 'liquid', color: '#' + (0x1000000 + Math.floor(rng() * 0xffffff)).toString(16).slice(1), createdAt: '2024-01', archivedAt: rng() < 0.15 ? '2025-06' : null, includeInFire: rng() < 0.5 ? undefined : rng() < 0.5 });
  }
  const nMonths = ri(0, 14);
  let y = 2024, m = 1;
  for (let k = 0; k < nMonths; k++) {
    const key = y + '-' + String(m).padStart(2, '0');
    const contribs = [], transfers = [];
    accounts.forEach(a => {
      if (rng() < 0.5) return;
      // archived accounts may lack snapshots in later months
      if (a.archivedAt && key > a.archivedAt && rng() < 0.7) return;
      const payday = Math.round(rand(-1000, 90000));
      const minus1 = a.type === 'current' ? Math.round(rand(-1000, payday)) : null;
      snapshots[a.id + '|' + key] = { accountId: a.id, yearMonth: key, balancePayday: payday, balancePaydayMinus1: minus1 };
      if (a.type !== 'current' && rng() < 0.5) contribs.push({ id: uid('c'), accountId: a.id, amount: Math.round(rand(-1000, 3000)), kind: pick(['recurring', 'one_off']), source: pick(['current', 'external']) });
    });
    if (accounts.length > 1 && rng() < 0.5) { const f = pick(accounts), t = pick(accounts); if (f.id !== t.id) transfers.push({ id: uid('t'), fromAccountId: f.id, toAccountId: t.id, amount: Math.round(rand(50, 4000)), note: null }); }
    entries[key] = { yearMonth: key, salaryNet: rng() < 0.2 ? 0 : Math.round(rand(0, 4000)), extraSalary: rng() < 0.2 ? Math.round(rand(0, 3000)) : 0, otherIncome: rng() < 0.3 ? Math.round(rand(0, 1500)) : 0, paydayDayOfMonth: 27, contributions: contribs, internalTransfers: transfers, flags: [] };
    m++; if (m > 12) { m = 1; y++; }
  }
  return {
    schemaVersion: 2, accounts, snapshots, entries, plans: [],
    settings: {
      defaultPaydayDayOfMonth: 27, birthDate: pick(['1990-01-01', '1985-06-15', '2000-12-31']),
      fire: { monthlyExpenseFire: Math.round(rand(1000, 4000)), swr: pick([0.03, 0.035, 0.04]), realReturnBase: 0.05, realReturnOptimistic: 0.07, inflation: 0.025, coastAge: 45, fireAge: pick([50, 55, 60]), pensionStartAge: 67, expectedPensionMonthly: Math.round(rand(0, 2000)), box3DragAnnual: 0.0212, box3StartDate: '2027-05', marginalRateBox1: 0.37, monteCarlo: { meanReturn: 0.06, stdDev: 0.15, runs: 50 } },
      milestones: [{ id: uid('ms'), date: '2027-05', label: 'X', note: null }],
    },
  };
}

const tabs = ['andamento', 'storico', 'fire', 'simulatore', 'pensioni', 'impostazioni'];
let pass = 0, fail = 0;
setTimeout(() => {
  console.log('\n=== UI fuzz: 30 random datasets × (5 tabs + entry form) ===');
  const N = 30;
  for (let s = 1; s <= N; s++) {
    const before = errors.length;
    const rng = E.mulberry32((0xBEEF + s * 40503) >>> 0);
    try {
      const data = genData(rng, s);
      window.localStorage.setItem('fd_data_v2', JSON.stringify(data));
      window.FD.load();
      tabs.forEach(t => { window.FD.go(t); if (!document.querySelector('.content') && !document.querySelector('.empty')) throw new Error('no content for tab ' + t); });
      // open entry form for a random existing month (or current)
      const months = E.monthSeries(window.FD.data);
      const target = months.length ? months[Math.floor(rng() * months.length)] : '2026-06';
      const ov = document.querySelector('.modal-overlay'); if (ov) ov.remove();
      window.FD.openEntry(target);
      if (!document.querySelector('.modal')) throw new Error('entry modal did not open');
      document.querySelector('.modal-overlay').remove();
      if (errors.length > before) throw new Error(errors.slice(before).join(' | '));
      pass++;
    } catch (e) {
      fail++;
      if (fail <= 8) console.log(`  \x1b[31m✗ dataset ${s}\x1b[0m: ${e.message}`);
    }
  }
  console.log(`  ${pass}/${N} datasets rendered cleanly across all tabs + entry form`);
  console.log('\n' + '='.repeat(50) + `\n  ${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n` + '='.repeat(50) + '\n');
  process.exit(fail ? 1 : 0);
}, 200);
