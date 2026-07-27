#!/usr/bin/env node
/* Regression: import the real 2025–2026 spreadsheet JSON into the built
   dashboard and render every tab without errors. */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script src="https:\/\/cdn[^"]+"><\/script>/, '').replace(/<script id="vendor-chart">[\s\S]*?<\/script>/, '');
const json = fs.readFileSync(path.join(ROOT, 'financial-dashboard-2025-2026.json'), 'utf8');
const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/',
  beforeParse(w) {
    w.Chart = function () { w.__c = (w.__c || 0) + 1; }; w.Chart.prototype.destroy = function () {};
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    if (!w.crypto) w.crypto = {}; w.crypto.randomUUID = () => 'id-' + Math.random().toString(36).slice(2);
    w.confirm = () => true; w.alert = () => {};
    w.console.error = (...a) => errors.push(a.join(' '));
    w.addEventListener('error', e => errors.push('err:' + (e.error && e.error.stack || e.message)));
  },
});
const w = dom.window, d = w.document;
setTimeout(() => {
  w.localStorage.setItem('fd_data_v2', json); w.FD.load(); w.FD.render();
  let fail = 0;
  const t = (n, fn) => { try { fn(); console.log('  \x1b[32m✓\x1b[0m ' + n); } catch (e) { fail++; console.log('  \x1b[31m✗ ' + n + '\x1b[0m — ' + e.message); } };
  console.log('\n=== Import render (real 2025–2026 data) ===');
  t('loaded 7 accounts', () => { if (w.FD.data.accounts.length !== 7) throw new Error('got ' + w.FD.data.accounts.length); });
  ['andamento', 'storico', 'fire', 'pensioni', 'impostazioni'].forEach(tab => t('render ' + tab, () => { w.FD.go(tab); if (!d.querySelector('.content')) throw new Error('no content'); }));
  // Row count is derived, not hardcoded: the dataset grows every time a new
  // month is added to generate-data.js, and a stale literal here would fail
  // for a reason that has nothing to do with rendering.
  t('storico shows one row per month in the dataset', () => {
    const E = require(path.join(ROOT, 'engine.js'));
    const expected = E.monthSeries(w.FD.data).length;
    w.FD.go('storico');
    const got = d.querySelectorAll('.data-row').length;
    if (got !== expected) throw new Error('rows=' + got + ', months=' + expected);
  });
  t('pensioni renders Generali', () => { w.FD.go('pensioni'); if (!/Generali/.test(d.body.textContent)) throw new Error('no Generali'); });
  t('FIRE capital is 186.426 (brokers only, archived excluded)', () => { const E = require(path.join(ROOT, 'engine.js')); if (Math.round(E.fireCapital(w.FD.data, '2026-05')) !== 186426) throw new Error('got ' + E.fireCapital(w.FD.data, '2026-05')); });
  // The numbers the user actually reads off the dashboard must equal the
  // source spreadsheet's "tot" column, month by month — this is the guard
  // that the import reproduces the sheet rather than merely rendering.
  t('liquid net worth matches the spreadsheet for every month', () => {
    const E = require(path.join(ROOT, 'engine.js'));
    const expected = {
      '2025-12': 181809, '2026-01': 191254, '2026-02': 206937, '2026-03': 202524,
      '2026-04': 214953, '2026-05': 223685, '2026-06': 234911, '2026-07': 235394,
    };
    Object.keys(expected).forEach(ym => {
      const got = Math.round(E.liquidNetWorth(w.FD.data, ym));
      if (got !== expected[ym]) throw new Error(ym + ': got ' + got + ', sheet says ' + expected[ym]);
    });
  });
  t('no console errors', () => { if (errors.length) throw new Error(errors.join('\n      ')); });
  console.log(fail ? '\nFAILED' : '\nALL PASSED');
  process.exit(fail ? 1 : 0);
}, 200);
