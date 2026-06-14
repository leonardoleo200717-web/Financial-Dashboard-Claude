#!/usr/bin/env node
/* DOM smoke test: loads the built index.html in jsdom, stubs Chart.js (CDN is
   blocked in the sandbox), seeds demo data, then renders every tab and opens
   the monthly entry form. Fails on any uncaught error / console.error. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// Drop the external Chart.js CDN <script> (no network); we inject a stub instead.
html = html.replace(/<script src="https:\/\/cdn[^"]+"><\/script>/, '');

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://localhost/',   // real origin → native localStorage works
  beforeParse(window) {
    // Chart.js stub: records instantiations, supports destroy().
    window.Chart = function (ctx, cfg) {
      this.ctx = ctx; this.config = cfg; window.__charts = (window.__charts || 0) + 1;
    };
    window.Chart.prototype.destroy = function () {};
    // URL.createObjectURL is only used on the export path; stub for safety.
    if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:stub';
    if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};
    if (!window.crypto) window.crypto = {};
    window.crypto.randomUUID = () => 'id-' + Math.random().toString(36).slice(2);
    window.confirm = () => true;
    window.prompt = () => 'CONFERMA';
    window.alert = () => {};
    window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    const origErr = window.console.error;
    window.console.error = (...a) => { errors.push(a.join(' ')); origErr.apply(window.console, a); };
    window.addEventListener('error', e => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
  },
});

const { window } = dom;
const { document } = window;

function run() {
  let pass = 0, fail = 0;
  function t(name, fn) {
    try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
    catch (e) { fail++; console.log('  \x1b[31m✗ ' + name + '\x1b[0m\n      ' + (e.stack || e.message)); }
  }

  console.log('\n=== UI smoke (jsdom) ===');
  t('app booted and exposed window.FD', () => {
    if (!window.FD) throw new Error('window.FD missing — app did not boot');
  });
  t('seedDemo builds the transfer-chain dataset', () => {
    window.FD.seedDemo();
    const d = window.FD.data;
    if (!d.accounts.length) throw new Error('no accounts seeded');
    const months = Object.keys(d.entries);
    if (!months.includes('2026-03')) throw new Error('demo month 2026-03 missing');
  });

  const tabs = ['andamento', 'storico', 'fire', 'pensioni', 'impostazioni'];
  tabs.forEach(tab => {
    t('render tab: ' + tab, () => {
      window.FD.go(tab);
      if (!document.querySelector('.content')) throw new Error('no .content rendered');
    });
  });

  t('charts were instantiated on Andamento', () => {
    window.FD.go('andamento');
    if (!window.__charts) throw new Error('no charts created');
  });

  t('storico table has rows', () => {
    window.FD.go('storico');
    const rows = document.querySelectorAll('.data-row');
    if (!rows.length) throw new Error('no data rows');
  });

  t('FIRE tab shows headline progress + personal-return card', () => {
    window.FD.go('fire');
    const txt = document.body.textContent;
    if (!/A che punto sei/.test(txt)) throw new Error('headline missing');
    if (!document.querySelector('.progress-fill')) throw new Error('progress bar missing');
    if (!/Rendimento personale/.test(txt)) throw new Error('personal return card missing');
  });

  t('new-month entry form prefills balances and offers ghost contributions', () => {
    // open a fresh future month (2026-12) -> should carry forward balances
    const ov = document.querySelector('.modal-overlay'); if (ov) ov.remove();
    // 2026-04 is new; its predecessor 2026-03 has balances + a recurring contribution
    window.FD.openEntry('2026-04');
    const modal = document.querySelector('.modal');
    if (!modal) throw new Error('entry modal did not open');
    const paydayInputs = modal.querySelectorAll('[data-snap-payday]');
    const anyPrefilled = Array.from(paydayInputs).some(i => i.value !== '' && i.value !== '0');
    if (!anyPrefilled) throw new Error('balances were not prefilled from previous month');
    if (!/Ricorrenti del mese scorso/.test(modal.textContent)) throw new Error('ghost contributions missing');
    document.querySelector('.modal-overlay').remove();
  });

  t('entry form opens and shows transfer rows for 2026-03', () => {
    window.FD.go('storico');
    // open editor for the chain month via the engine-backed form
    const overlayBefore = document.querySelector('.modal-overlay');
    if (overlayBefore) overlayBefore.remove();
    // trigger edit button for 2026-03
    const btn = Array.from(document.querySelectorAll('[data-edit]')).find(b => b.dataset.edit === '2026-03');
    if (!btn) throw new Error('edit button for 2026-03 not found');
    btn.click();
    const modal = document.querySelector('.modal');
    if (!modal) throw new Error('modal did not open');
    if (!/Trasferimenti interni/.test(modal.textContent)) throw new Error('transfers section missing');
  });

  t('no console.error / uncaught errors during smoke', () => {
    if (errors.length) throw new Error(errors.join('\n      '));
  });

  console.log('\n' + '='.repeat(48));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(48) + '\n');
  process.exit(fail ? 1 : 0);
}

// allow the app's DOMContentLoaded + setTimeout(0) chart callbacks to settle
setTimeout(run, 200);
