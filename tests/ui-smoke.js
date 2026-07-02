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
    // Simulate the local-file case where the Anthropic endpoint is unreachable.
    window.fetch = () => Promise.reject(new Error('network blocked (local file)'));
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

  const tabs = ['andamento', 'storico', 'fire', 'simulatore', 'tasse', 'pensioni', 'impostazioni'];
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

  t('info ⓘ button toggles an explanation panel', () => {
    window.FD.go('andamento');
    const info = document.querySelector('.info-btn');
    if (!info) throw new Error('no info button');
    const pop = info.parentElement.nextElementSibling;
    if (!pop || !pop.classList.contains('info-pop')) throw new Error('no info pop');
    const before = pop.style.display;
    info.click();
    if (pop.style.display === before) throw new Error('info pop did not toggle');
  });

  t('enlarge ⤢ button opens a chart modal', () => {
    window.FD.go('andamento');
    const exp = document.querySelector('.enlarge-btn');
    if (!exp) throw new Error('no enlarge button');
    exp.click();
    const modal = document.querySelector('.chart-modal');
    if (!modal) throw new Error('chart modal did not open');
    modal.parentElement.remove();
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
    modal.parentElement.remove();
  });

  t('interaction: SWR chip updates the FIRE number', () => {
    window.FD.go('fire');
    const chip = document.querySelector('[data-swr="0.04"]');
    if (!chip) throw new Error('swr chip missing');
    chip.click();
    if (window.FD.data.settings.fire.swr !== 0.04) throw new Error('swr did not update');
  });

  t('interaction: run Monte Carlo produces a probability', () => {
    window.FD.go('fire');
    const btn = Array.from(document.querySelectorAll('button')).find(b => /Esegui simulazione/.test(b.textContent));
    if (!btn) throw new Error('monte carlo button missing');
    btn.click();
    if (!/Probabilità di successo/.test(document.body.textContent)) throw new Error('MC output missing');
  });

  t('interaction: toggle FIRE checkbox on an account in Settings', () => {
    window.FD.go('impostazioni');
    const cb = document.querySelector('[data-fire]');
    if (!cb) throw new Error('no FIRE checkbox');
    const id = cb.dataset.fire; const before = window.FD.data.accounts.find(a => a.id === id).includeInFire;
    cb.checked = !cb.checked; cb.dispatchEvent(new window.Event('change'));
    const after = window.FD.data.accounts.find(a => a.id === id).includeInFire;
    if (after === before) throw new Error('includeInFire did not change');
  });

  t('interaction: edit + save a month persists balances', () => {
    const ov = document.querySelector('.modal-overlay'); if (ov) ov.remove();
    window.FD.openEntry('2026-02');
    const inp = document.querySelector('[data-snap-payday]');
    if (!inp) throw new Error('no balance input');
    inp.value = '12345'; inp.dispatchEvent(new window.Event('input'));
    const saveBtn = document.querySelector('#ef-save');
    saveBtn.click();
    const accId = inp.dataset.snapPayday;
    const s = window.FD.data.snapshots[accId + '|2026-02'];
    if (!s || s.balancePayday !== 12345) throw new Error('balance not saved');
  });

  t('simulator tab seeds fireSim and renders charts + numbers table', () => {
    window.FD.go('simulatore');
    const d = window.FD.data;
    if (!d.fireSim || !d.fireSim.classes || !d.fireSim.classes.length) throw new Error('fireSim not seeded');
    if (!document.body.textContent.match(/Coast-FIRE/)) throw new Error('results missing');
    if (!document.querySelector('canvas')) throw new Error('no sim charts');
    if (!/non consulenza finanziaria/.test(document.body.textContent)) throw new Error('disclaimer missing');
  });

  t('simulator what-if degrades gracefully when AI endpoint unreachable', async () => {
    window.FD.go('simulatore');
    const ta = document.querySelector('.whatif-input');
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Simula');
    if (!ta || !btn) throw new Error('what-if controls missing');
    ta.value = 'vado in pensione a 53';
    btn.click();
    await new Promise(r => setTimeout(r, 60)); // let the failed fetch reject
    if (!/AI non disponibile/.test(document.body.textContent)) throw new Error('no graceful AI-down message');
  });

  t('simulator stress test renders with-vs-without and toggles a persisted shock', () => {
    window.FD.go('simulatore');
    if (!/Stress test/.test(document.body.textContent)) throw new Error('stress card missing');
    if (!document.querySelector('#sk-sev')) throw new Error('severity control missing');
    if (!/senza crisi/i.test(document.body.textContent)) throw new Error('comparison missing');
    const applyBtn = Array.from(document.querySelectorAll('button')).find(b => /crisi allo scenario|crisi dallo scenario/.test(b.textContent));
    if (!applyBtn) throw new Error('apply button missing');
    const before = window.FD.data.fireSim.profile.shock.enabled;
    applyBtn.click();
    if (window.FD.data.fireSim.profile.shock.enabled === before) throw new Error('shock not toggled/persisted');
  });

  t('simulator manual param edit updates the engine result', () => {
    window.FD.go('simulatore');
    const inp = document.querySelector('[data-pf="annualSpend"]');
    if (!inp) throw new Error('no spend input');
    inp.value = '120000'; inp.dispatchEvent(new window.Event('change'));
    if (window.FD.data.fireSim.profile.annualSpend !== 120000) throw new Error('param not saved');
  });

  t('tax tab renders deterministic facts + disclaimer', () => {
    window.FD.go('tasse');
    const txt = document.body.textContent;
    if (!/Non è consulenza fiscale/.test(txt)) throw new Error('disclaimer missing');
    if (!/30% ruling/.test(txt)) throw new Error('deterministic facts missing');
    if (!document.querySelector('.whatif-input')) throw new Error('chat input missing');
  });

  t('tax ask degrades gracefully and renders all 3 agent layers', async () => {
    window.FD.go('tasse');
    const ta = document.querySelector('.whatif-input');
    const btn = Array.from(document.querySelectorAll('button')).find(b => /Optimizer → Reviewer → Reconciler/.test(b.textContent));
    if (!ta || !btn) throw new Error('tax controls missing');
    ta.value = 'Conviene aumentare il lijfrente?';
    btn.click();
    await new Promise(r => setTimeout(r, 80)); // running -> error (fetch rejects)
    const txt = document.body.textContent;
    if (!/AI non disponibile/.test(txt)) throw new Error('no graceful AI-down message');
    if (!/Optimizer/.test(txt) || !/Reviewer/.test(txt) || !/Reconciler/.test(txt)) throw new Error('three agent layers not all rendered');
    if (!window.FD.data.taxAssist.history.length) throw new Error('history not persisted');
  });

  t('AI settings card renders provider options and persists config', () => {
    window.FD.go('impostazioni');
    const sel = document.querySelector('#ai-prov');
    if (!sel) throw new Error('provider select missing');
    if (!Array.from(sel.options).some(o => o.value === 'deepseek')) throw new Error('deepseek preset missing');
    sel.value = 'deepseek'; sel.dispatchEvent(new window.Event('change'));
    const ai = window.FD.data.settings.ai;
    if (ai.provider !== 'deepseek') throw new Error('provider not saved');
    if (!/deepseek/.test(ai.baseUrl)) throw new Error('preset baseUrl not applied');
  });

  t('callModel routes to OpenAI-compatible shape for DeepSeek/Ollama', async () => {
    let captured = null;
    const realFetch = window.fetch;
    window.fetch = (url, opts) => { captured = { url, opts }; return Promise.resolve({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'OK-openai' } }] }) }); };
    window.FD.data.settings.ai = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', model: 'deepseek-chat' };
    const out = await window.FD.callModel('parse', { system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    window.fetch = realFetch;
    if (out !== 'OK-openai') throw new Error('did not parse OpenAI response, got ' + out);
    if (!/\/chat\/completions$/.test(captured.url)) throw new Error('wrong endpoint ' + captured.url);
    if (captured.opts.headers['Authorization'] !== 'Bearer sk-test') throw new Error('missing bearer auth');
    const body = JSON.parse(captured.opts.body);
    if (body.model !== 'deepseek-chat' || body.messages[0].role !== 'system') throw new Error('bad openai body');
  });

  t('callModel routes to Anthropic shape with x-api-key when configured', async () => {
    let captured = null;
    const realFetch = window.fetch;
    window.fetch = (url, opts) => { captured = { url, opts }; return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: [{ text: 'OK-anthropic' }] }) }); };
    window.FD.data.settings.ai = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'ak-test', model: 'claude-sonnet-4-6' };
    const out = await window.FD.callModel('parse', { system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    window.fetch = realFetch;
    if (out !== 'OK-anthropic') throw new Error('did not parse Anthropic response');
    if (!/\/v1\/messages$/.test(captured.url)) throw new Error('wrong endpoint ' + captured.url);
    if (captured.opts.headers['x-api-key'] !== 'ak-test') throw new Error('missing x-api-key');
    // restore default so later tests keep the graceful-down behaviour
    window.FD.data.settings.ai = { provider: 'artifact', baseUrl: '', apiKey: '', model: '' };
  });

  t('storico shows bold annual rollup rows with YoY', () => {
    window.FD.go('storico');
    const yearRows = document.querySelectorAll('.year-row');
    if (!yearRows.length) throw new Error('no annual rollup rows');
    if (!/^\d{4}$/.test(yearRows[0].querySelector('td b').textContent)) throw new Error('year label missing');
  });

  t('coast FIRE card is pension-aware and has a crossover chart', () => {
    window.FD.go('fire');
    if (!/Obiettivo \(due fasi, con pensioni\)/.test(document.body.textContent)) throw new Error('two-phase target missing from coast card');
    if (!document.querySelector('#c-coast')) throw new Error('coast crossover canvas missing');
  });

  t('Monte Carlo params are editable in Settings', () => {
    window.FD.go('impostazioni');
    const mean = document.querySelector('[data-param="meanReturn"][data-scope="mc"]');
    if (!mean) throw new Error('MC meanReturn input missing');
    mean.value = '0.07'; mean.dispatchEvent(new window.Event('change'));
    if (window.FD.data.settings.fire.monteCarlo.meanReturn !== 0.07) throw new Error('MC param not saved');
    mean.value = '0.06'; mean.dispatchEvent(new window.Event('change'));
  });

  t('archived account balance is NOT prefilled/written into a new month', () => {
    // archive an account whose last snapshot is the month before the new one
    const d = window.FD.data;
    const acc = { id: 'arch-test', name: 'Archiviato', type: 'broker', liquidity: 'liquid', color: '#123456', createdAt: '2026-01', archivedAt: '2026-03' };
    d.accounts.push(acc);
    d.snapshots['arch-test|2026-03'] = { accountId: 'arch-test', yearMonth: '2026-03', balancePayday: 99999, balancePaydayMinus1: null };
    const ov0 = document.querySelector('.modal-overlay'); if (ov0) ov0.remove();
    window.FD.openEntry('2026-04'); // new month right after the archive month
    const saveBtn = document.querySelector('#ef-save');
    saveBtn.click(); // confirm() stubbed true for the missing-balance prompt
    if (d.snapshots['arch-test|2026-04']) throw new Error('archived balance resurrected into 2026-04');
    // cleanup
    d.accounts = d.accounts.filter(a => a.id !== 'arch-test');
    delete d.snapshots['arch-test|2026-03'];
    Object.keys(d.snapshots).filter(k => k.endsWith('|2026-04')).forEach(k => delete d.snapshots[k]);
    delete d.entries['2026-04'];
    window.FD.save(); window.FD.render();
  });

  t('account names are HTML-escaped (no XSS via account name)', () => {
    const d = window.FD.data;
    const evil = { id: 'xss-test', name: '<img src=x onerror="window.__xss=1">', type: 'broker', liquidity: 'liquid', color: '#000000', createdAt: '2026-01', archivedAt: null };
    d.accounts.push(evil);
    window.FD.go('impostazioni'); // renders account rows
    const injected = document.querySelector('.acc-name img');
    const flagged = window.__xss === 1;
    d.accounts = d.accounts.filter(a => a.id !== 'xss-test');
    window.FD.save(); window.FD.render();
    if (injected || flagged) throw new Error('account name executed as HTML');
  });

  t('JSON export never contains the AI API key', () => {
    window.FD.data.settings.ai = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-SECRET-123', model: 'deepseek-chat' };
    const payload = window.FD.exportPayload();
    const text = JSON.stringify(payload);
    if (text.includes('sk-SECRET-123')) throw new Error('API key leaked into export');
    if (window.FD.data.settings.ai.apiKey !== 'sk-SECRET-123') throw new Error('redaction mutated live data');
    window.FD.data.settings.ai = { provider: 'artifact', baseUrl: '', apiKey: '', model: '' };
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
