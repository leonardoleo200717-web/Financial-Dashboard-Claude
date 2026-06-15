#!/usr/bin/env node
/* Regression: import the real 2025–2026 spreadsheet JSON into the built
   dashboard and render every tab without errors. */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script src="https:\/\/cdn[^"]+"><\/script>/, '');
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
  t('storico shows 17 rows', () => { w.FD.go('storico'); if (d.querySelectorAll('.data-row').length !== 17) throw new Error('rows=' + d.querySelectorAll('.data-row').length); });
  t('pensioni renders Generali', () => { w.FD.go('pensioni'); if (!/Generali/.test(d.body.textContent)) throw new Error('no Generali'); });
  t('FIRE capital is 186.426 (brokers only, archived excluded)', () => { const E = require(path.join(ROOT, 'engine.js')); if (Math.round(E.fireCapital(w.FD.data, '2026-05')) !== 186426) throw new Error('got ' + E.fireCapital(w.FD.data, '2026-05')); });
  t('no console errors', () => { if (errors.length) throw new Error(errors.join('\n      ')); });
  console.log(fail ? '\nFAILED' : '\nALL PASSED');
  process.exit(fail ? 1 : 0);
}, 200);
