/* =========================================================================
   Financial Dashboard — UI layer (app.js)
   Depends on the global `Engine` (engine.js) and global `Chart` (CDN).
   Inlined into index.html at build time.
   ========================================================================= */
(function () {
  'use strict';
  const E = Engine;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const STORAGE_KEY = 'fd_data_v2';

  const PALETTE = ['#3498db', '#2ecc71', '#9b59b6', '#e67e22', '#1abc9c',
    '#e74c3c', '#f1c40f', '#34495e', '#16a085', '#d35400', '#7f8c8d', '#27ae60'];
  const POS = '#2ecc71', NEG = '#e74c3c';

  /* ----------------------------- state -------------------------------- */
  let data = null;
  let charts = {};

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function defaultData() {
    return {
      schemaVersion: 2,
      accounts: [],
      snapshots: {},   // "accId|YYYY-MM" -> snapshot
      entries: {},     // "YYYY-MM" -> entry
      plans: [],
      settings: {
        defaultPaydayDayOfMonth: 27,
        birthDate: '1990-01-15',
        fire: {
          monthlyExpenseFire: 2500, swr: 0.035,
          realReturnBase: 0.05, realReturnOptimistic: 0.07, inflation: 0.025,
          coastAge: 45, fireAge: 55, pensionStartAge: 67,
          expectedPensionMonthly: 1200,
          box3DragAnnual: 0.0212, box3StartDate: '2027-05',
          marginalRateBox1: 0.37,
          monteCarlo: { meanReturn: 0.06, stdDev: 0.15, runs: 1000 },
        },
        milestones: [
          { id: uuid(), date: '2027-05', label: 'Scadenza 30% ruling + Box 3', note: null },
          { id: uuid(), date: '2030-12', label: 'iBonds Dec 2030 maturity — riallocare', note: null },
        ],
      },
    };
  }

  /* --------------------------- persistence ---------------------------- */
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { data = defaultData(); return; }
      const parsed = JSON.parse(raw);
      data = migrate(parsed);
    } catch (e) {
      console.error('load failed', e);
      data = defaultData();
    }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      alert('Memoria piena: esporta i dati prima di continuare. Il salvataggio è bloccato.');
      doExport();
    }
  }
  function migrate(parsed) {
    if (!parsed || typeof parsed !== 'object') return defaultData();
    if (parsed.schemaVersion === 2) return normalize(parsed);
    if (parsed.schemaVersion === 1) {
      // v1 → v2: contributions default source=current; balancePaydayMinus1 preserved
      (parsed.entries && Object.values(parsed.entries) || []).forEach(en => {
        (en.contributions || []).forEach(c => { if (!c.source) c.source = 'current'; });
      });
      parsed.schemaVersion = 2;
      return normalize(parsed);
    }
    return normalize(parsed);
  }
  function normalize(d) {
    const base = defaultData();
    d.accounts = d.accounts || [];
    d.snapshots = d.snapshots || {};
    d.entries = d.entries || {};
    d.plans = d.plans || [];
    d.settings = Object.assign(base.settings, d.settings || {});
    d.settings.fire = Object.assign(base.settings.fire, (d.settings && d.settings.fire) || {});
    return d;
  }

  /* ------------------------------ seed -------------------------------- */
  // Demo scenario built specifically around the transfer chain:
  // bank → savings → partial back to bank → broker, across months.
  function seedDemo() {
    data = defaultData();
    const bank = mkAccount('Conto Corrente ING', 'current');
    const sav = mkAccount('Conto Deposito', 'savings');
    const broker = mkAccount('Broker DEGIRO', 'broker');
    const pme = mkAccount('PME (pensione NL)', 'pension');
    [bank, sav, broker, pme].forEach(a => data.accounts.push(a));

    function snap(acc, ym, payday, minus1) {
      data.snapshots[acc.id + '|' + ym] = {
        accountId: acc.id, yearMonth: ym,
        balancePayday: payday,
        balancePaydayMinus1: minus1 == null ? null : minus1,
      };
    }
    function entry(ym, o) {
      data.entries[ym] = Object.assign({
        yearMonth: ym, salaryNet: 0, extraSalary: 0, otherIncome: 0,
        paydayDayOfMonth: 27, contributions: [], internalTransfers: [], flags: [],
      }, o);
    }

    // 2026-01 baseline
    snap(bank, '2026-01', 3000, 1500);
    snap(sav, '2026-01', 10000, null);
    snap(broker, '2026-01', 20000, null);
    snap(pme, '2026-01', 30000, null);
    entry('2026-01', { salaryNet: 2800, paydayDayOfMonth: 27 });

    // 2026-02: salary 2800; spent ~1300; moved 1000 bank→savings.
    // bank end (minus1) = 1500(start payday-1 of jan) ... we set explicit numbers.
    snap(bank, '2026-02', 3200, 1200);
    snap(sav, '2026-02', 11000, null);
    snap(broker, '2026-02', 20500, null);
    snap(pme, '2026-02', 30600, null);
    entry('2026-02', {
      salaryNet: 2800,
      internalTransfers: [
        { id: uuid(), fromAccountId: bank.id, toAccountId: sav.id, amount: 1000, note: 'accantonamento' },
      ],
      contributions: [
        { id: uuid(), accountId: pme.id, amount: 550, kind: 'recurring', source: 'external' },
      ],
    });

    // 2026-03: the full transfer chain in one month —
    //   bank → savings 1500, savings → bank 500 (portion back), bank → broker 1200.
    snap(bank, '2026-03', 3100, 1300);
    snap(sav, '2026-03', 12000, null);  // +1000 net (1500 in − 500 out)
    snap(broker, '2026-03', 22000, null); // +1500: 1200 transfer + 300 market
    snap(pme, '2026-03', 31200, null);
    entry('2026-03', {
      salaryNet: 2800,
      internalTransfers: [
        { id: uuid(), fromAccountId: bank.id, toAccountId: sav.id, amount: 1500, note: 'accantonamento' },
        { id: uuid(), fromAccountId: sav.id, toAccountId: bank.id, amount: 500, note: 'rientro parziale' },
        { id: uuid(), fromAccountId: bank.id, toAccountId: broker.id, amount: 1200, note: 'verso broker' },
      ],
      contributions: [
        { id: uuid(), accountId: pme.id, amount: 550, kind: 'recurring', source: 'external' },
      ],
    });

    save();
  }
  function mkAccount(name, type) {
    const liquidity = type === 'pension' ? 'locked' : 'liquid';
    return {
      id: uuid(), name, type, liquidity,
      color: PALETTE[(data.accounts.length) % PALETTE.length],
      createdAt: '2026-01', archivedAt: null,
    };
  }

  /* ----------------------------- routing ------------------------------ */
  const TABS = [
    { id: 'andamento', label: 'Andamento', icon: '📈' },
    { id: 'storico', label: 'Storico', icon: '📋' },
    { id: 'fire', label: 'FIRE', icon: '🔥' },
    { id: 'pensioni', label: 'Pensioni', icon: '🏛️' },
    { id: 'impostazioni', label: 'Impostazioni', icon: '⚙️' },
  ];
  let activeTab = 'andamento';
  function go(tab) { activeTab = tab; render(); }

  /* ----------------------------- render ------------------------------- */
  function render() {
    const app = $('#app');
    app.innerHTML = '';
    app.appendChild(renderNav());
    const main = document.createElement('main');
    main.className = 'content';
    app.appendChild(main);
    Object.values(charts).forEach(c => { try { c.destroy(); } catch (e) {} });
    charts = {};

    if (E.monthSeries(data).length === 0 && activeTab !== 'impostazioni') {
      main.appendChild(emptyState());
      return;
    }
    switch (activeTab) {
      case 'andamento': renderAndamento(main); break;
      case 'storico': renderStorico(main); break;
      case 'fire': renderFire(main); break;
      case 'pensioni': renderPensioni(main); break;
      case 'impostazioni': renderImpostazioni(main); break;
    }
  }

  function renderNav() {
    const nav = document.createElement('nav');
    nav.className = 'nav';
    nav.innerHTML = `<div class="brand">💶 Financial Dashboard</div>
      <div class="tabs">${TABS.map(t =>
      `<button class="tab ${t.id === activeTab ? 'active' : ''}" data-tab="${t.id}">
         <span class="ic">${t.icon}</span><span class="lb">${t.label}</span></button>`).join('')}</div>`;
    $$('.tab', nav).forEach(b => b.onclick = () => go(b.dataset.tab));
    return nav;
  }

  function emptyState() {
    const d = document.createElement('div');
    d.className = 'empty';
    d.innerHTML = `<h2>Nessun dato</h2>
      <p>Inizia inserendo il primo mese oppure carica i dati dimostrativi.</p>
      <div class="row">
        <button class="btn primary" id="es-add">+ Inserisci il primo mese</button>
        <button class="btn" id="es-demo">Carica dati demo</button>
      </div>`;
    d.querySelector('#es-add').onclick = () => openEntryForm(currentMonth());
    d.querySelector('#es-demo').onclick = () => { seedDemo(); go('andamento'); };
    return d;
  }

  function currentMonth() {
    const now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  }

  /* ---------- small DOM helpers ---------- */
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function card(title, bodyNode) {
    const c = el('div', 'card');
    if (title) c.appendChild(el('h3', 'card-title', title));
    if (bodyNode) c.appendChild(bodyNode);
    return c;
  }
  function canvas(id) {
    const wrap = el('div', 'chart-wrap');
    const cv = document.createElement('canvas');
    cv.id = id; wrap.appendChild(cv); return wrap;
  }
  const fmt = E.fmtEUR;
  const fmtP = E.fmtPct;

  /* ========================== TAB 1 — Andamento ===================== */
  function renderAndamento(main) {
    const months = E.monthSeries(data);
    const grid = el('div', 'grid');
    main.appendChild(grid);

    grid.appendChild(card('Patrimonio nel tempo', canvas('c-networth')));
    grid.appendChild(card('Contributi vs Mercato', canvas('c-contrib')));
    grid.appendChild(card('Crescita mensile', canvas('c-monthly')));
    grid.appendChild(card('Savings rate', canvas('c-savings')));
    grid.appendChild(card('Spese stimate', canvas('c-expenses')));
    grid.appendChild(card('Allocazione', allocationBlock()));
    grid.appendChild(countdownCard());

    drawNetWorth(months);
    drawContribVsMarket(months);
    drawMonthlyGrowth(months);
    drawSavings(months);
    drawExpenses(months);
    drawAllocation(months, false);
  }

  function milestoneAnnotations(months) {
    // returns Chart.js scatter-ish markers as a dataset of vertical lines via labels
    return (data.settings.milestones || []).filter(m => months.includes(m.date));
  }

  function drawNetWorth(months) {
    const liquid = months.map(m => E.liquidNetWorth(data, m));
    const total = months.map(m => E.totalNetWorth(data, m));
    // cumulative contributions
    let cum = 0; const cumContrib = months.map(m => { cum += E.portfolioContributions(data, m) || 0; return E.r2(cum); });
    const fire = E.fireNumberSimple(data.settings.fire);
    const labels = months.map(E.monthLabelIT);
    charts.nw = new Chart($('#c-networth'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Patrimonio liquido', data: liquid, borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,.1)', tension: .25, fill: false },
          { label: 'Totale (incl. pensioni)', data: total, borderColor: '#9b59b6', borderDash: [6, 4], tension: .25, fill: false },
          { label: 'Contributi cumulativi', data: cumContrib, borderColor: '#95a5a6', tension: .25, fill: false, pointRadius: 0 },
          { label: 'FIRE number', data: months.map(() => fire), borderColor: NEG, borderDash: [2, 2], pointRadius: 0, fill: false },
        ],
      },
      options: baseLineOpts(),
    });
  }

  function drawContribVsMarket(months) {
    let cc = 0, cm = 0;
    const cumC = [], cumM = [];
    months.forEach(m => {
      cc += E.portfolioContributions(data, m) || 0;
      cm += E.portfolioMarketGrowth(data, m) || 0;
      cumC.push(E.r2(cc)); cumM.push(E.r2(cm));
    });
    charts.cm = new Chart($('#c-contrib'), {
      type: 'line',
      data: {
        labels: months.map(E.monthLabelIT),
        datasets: [
          { label: 'Contributi cumulativi', data: cumC, borderColor: '#2980b9', backgroundColor: 'rgba(41,128,185,.5)', fill: 'origin', tension: .2, pointRadius: 0 },
          { label: 'Crescita di mercato cumulativa', data: cumM.map((v, i) => E.r2(v + cumC[i])), borderColor: '#27ae60', backgroundColor: 'rgba(39,174,96,.4)', fill: '-1', tension: .2, pointRadius: 0 },
        ],
      },
      options: baseLineOpts(),
    });
  }

  function drawMonthlyGrowth(months) {
    const deltas = months.map((m, i) => {
      if (i === 0) return null;
      const a = E.liquidNetWorth(data, m), b = E.liquidNetWorth(data, months[i - 1]);
      return (a != null && b != null) ? E.r2(a - b) : null;
    });
    charts.mg = new Chart($('#c-monthly'), {
      type: 'bar',
      data: {
        labels: months.map(E.monthLabelIT),
        datasets: [{
          label: 'Δ liquido', data: deltas,
          backgroundColor: deltas.map(d => d == null ? '#ccc' : d >= 0 ? POS : NEG),
        }],
      },
      options: Object.assign(baseLineOpts(), {
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterBody: (items) => {
                const i = items[0].dataIndex; const m = months[i];
                const c = E.portfolioContributions(data, m), mk = E.portfolioMarketGrowth(data, m);
                return ['Contributi: ' + fmt(c), 'Mercato: ' + fmt(mk)];
              },
            },
          },
        },
      }),
    });
  }

  function drawSavings(months) {
    const table = E.buildMonthlyTable(data);
    const sr = table.map(r => r.savingsRate);
    const roll = E.rollingAvg(sr, null, months, 12);
    charts.sr = new Chart($('#c-savings'), {
      type: 'line',
      data: {
        labels: months.map(E.monthLabelIT),
        datasets: [
          { label: 'Savings rate mensile', data: sr.map(v => v == null ? null : v * 100), borderColor: '#16a085', tension: .2, spanGaps: true },
          { label: 'Media 12 mesi', data: roll.map(v => v == null ? null : v * 100), borderColor: '#e67e22', borderDash: [5, 3], tension: .2, pointRadius: 0, spanGaps: true },
        ],
      },
      options: pctLineOpts(),
    });
  }

  function drawExpenses(months) {
    const exp = months.map(m => E.estimatedExpenses(data, m));
    const vals = exp.map(e => e.value);
    const roll = E.rollingAvg(vals, null, months, 3);
    charts.ex = new Chart($('#c-expenses'), {
      type: 'line',
      data: {
        labels: months.map(E.monthLabelIT),
        datasets: [
          {
            label: 'Spese stimate', data: vals, borderColor: '#c0392b', tension: .2, spanGaps: true,
            pointStyle: exp.map(e => (e.flags && e.flags.length) ? 'crossRot' : 'circle'),
            pointRadius: exp.map(e => (e.flags && e.flags.length) ? 6 : 3),
          },
          { label: 'Media 3 mesi', data: roll.map(v => v == null ? null : v), borderColor: '#e67e22', borderDash: [5, 3], pointRadius: 0, tension: .2, spanGaps: true },
        ],
      },
      options: baseLineOpts(),
    });
  }

  function allocationBlock() {
    const wrap = el('div');
    const lbl = el('label', 'toggle', `<input type="checkbox" id="alloc-arch"> mostra conti archiviati`);
    wrap.appendChild(lbl);
    wrap.appendChild(canvas('c-alloc'));
    setTimeout(() => {
      const cb = $('#alloc-arch');
      if (cb) cb.onchange = () => drawAllocation(E.monthSeries(data), cb.checked);
    }, 0);
    return wrap;
  }

  function drawAllocation(months, showArchived) {
    if (charts.al) { try { charts.al.destroy(); } catch (e) {} }
    const accs = (data.accounts || []).filter(a => showArchived || !a.archivedAt || true);
    const datasets = accs.map(a => ({
      label: a.name,
      data: months.map(m => {
        const s = E.getSnapshot(data, a.id, m);
        return s && s.balancePayday != null ? s.balancePayday : null;
      }),
      borderColor: a.color, backgroundColor: a.color + '55', fill: true, tension: .2, pointRadius: 0,
    }));
    charts.al = new Chart($('#c-alloc'), {
      type: 'line',
      data: { labels: months.map(E.monthLabelIT), datasets },
      options: Object.assign(baseLineOpts(), { scales: { y: { stacked: true, ticks: { callback: v => fmt(v) } } } }),
    });
  }

  function countdownCard() {
    const today = currentMonth();
    const next = (data.settings.milestones || [])
      .filter(m => E.ymCompare(m.date, today) >= 0)
      .sort((a, b) => E.ymCompare(a.date, b.date))[0];
    const body = el('div');
    if (!next) body.innerHTML = '<p class="muted">Nessuna milestone futura.</p>';
    else {
      const months = E.monthsBetween(today, next.date);
      body.innerHTML = `<div class="big">${months} mesi</div>
        <div class="muted">${next.label}</div>
        <div class="muted small">${E.monthLabelIT(next.date)}</div>`;
    }
    return card('Prossima milestone', body);
  }

  /* ========================== TAB 2 — Storico ======================= */
  function renderStorico(main) {
    const rows = E.buildMonthlyTable(data).slice().reverse();
    const head = el('div', 'storico-head');
    head.innerHTML = `<h2>Storico mensile</h2>`;
    const addBtn = el('button', 'btn primary', '+ Inserisci mese');
    addBtn.onclick = () => openEntryForm(currentMonth());
    head.appendChild(addBtn);
    main.appendChild(head);

    const table = el('table', 'data-table');
    table.innerHTML = `<thead><tr>
      <th>Mese</th><th>Patrimonio liquido</th><th>Δ mese</th><th>Δ %</th>
      <th>Contributi</th><th>Mercato</th><th>Spese stimate</th><th>Savings rate</th><th></th>
      </tr></thead>`;
    const tb = el('tbody');
    let lastYear = null;
    rows.forEach(r => {
      const yr = r.ym.slice(0, 4);
      const tr = el('tr');
      tr.className = 'data-row';
      const flagMark = r.flags && r.flags.length
        ? `<span class="flag" title="${r.flags.join(', ')}">⚠</span>` : '';
      tr.innerHTML = `
        <td>${r.label} ${flagMark}</td>
        <td>${fmt(r.liquid)}</td>
        <td class="${r.delta >= 0 ? 'pos' : 'neg'}">${r.delta == null ? '—' : fmt(r.delta)}</td>
        <td>${r.deltaPct == null ? '—' : fmtP(r.deltaPct)}</td>
        <td>${fmt(r.contributions)}</td>
        <td>${r.market == null ? '—' : fmt(r.market)}</td>
        <td>${expCell(r)}</td>
        <td>${r.savingsRate == null ? '—' : fmtP(r.savingsRate)}</td>
        <td><button class="link" data-edit="${r.ym}">modifica</button></td>`;
      tr.querySelector('[data-edit]').onclick = (ev) => { ev.stopPropagation(); openEntryForm(r.ym); };
      tr.onclick = () => toggleBreakdown(tr, r.ym);
      tb.appendChild(tr);
      lastYear = yr;
    });
    table.appendChild(tb);
    main.appendChild(table);
  }
  function expCell(r) {
    if (r.flags && r.flags.includes('NEGATIVE_EXPENSES')) return `<span class="flag">⚠ verifica entrate</span>`;
    if (r.expenses == null) return '—';
    return fmt(r.expenses);
  }
  function toggleBreakdown(tr, ym) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('breakdown')) { next.remove(); return; }
    const det = el('tr', 'breakdown');
    const td = el('td'); td.colSpan = 9;
    td.appendChild(monthBreakdown(ym));
    det.appendChild(td);
    tr.after(det);
  }
  function monthBreakdown(ym) {
    const wrap = el('div', 'breakdown-body');
    const entry = E.getEntry(data, ym) || {};
    const is = E.investedAndSavings(data, ym);
    const rec = E.reconcile(data, ym);
    let html = '<div class="bk-grid">';
    html += `<div><b>Entrate</b><br>Stipendio: ${fmt(entry.salaryNet || 0)}<br>Extra: ${fmt(entry.extraSalary || 0)}<br>Altre: ${fmt(entry.otherIncome || 0)}</div>`;
    html += `<div><b>Metriche</b><br>Investito: ${fmt(is.invested)}<br>Spese: ${fmt(is.expenses)}<br>Δ liquidità CC: ${fmt(is.deltaCash)}</div>`;
    html += '<div><b>Saldi conti</b><br>';
    (data.accounts || []).forEach(a => {
      const s = E.getSnapshot(data, a.id, ym);
      if (s) html += `<span class="swatch" style="background:${a.color}"></span>${a.name}: ${fmt(s.balancePayday)}<br>`;
    });
    html += '</div>';
    html += '<div><b>Movimenti</b><br>';
    (entry.contributions || []).forEach(c => {
      const a = E.accountById(data, c.accountId);
      html += `Contributo → ${a ? a.name : '?'}: ${fmt(c.amount)} <span class="muted small">(${c.source})</span><br>`;
    });
    (entry.internalTransfers || []).forEach(t => {
      const f = E.accountById(data, t.fromAccountId), to = E.accountById(data, t.toAccountId);
      html += `Trasf. ${f ? f.name : '?'} → ${to ? to.name : '?'}: ${fmt(t.amount)}<br>`;
    });
    html += '</div>';
    html += '</div>';
    if (rec.mismatch) html += `<div class="warn">⚠ Discrepanza ${fmt(rec.diff)} — contributo non registrato o entrata mancante? (contributi ${fmt(rec.contributions)} vs investito ${fmt(rec.invested)})</div>`;
    wrap.innerHTML = html;
    return wrap;
  }

  /* ============================ TAB 3 — FIRE ======================== */
  function renderFire(main) {
    const f = data.settings.fire;
    const grid = el('div', 'grid');
    main.appendChild(grid);

    // 3.1 FIRE number
    const tp = E.fireNumberTwoPhase(f);
    const fnBody = el('div');
    fnBody.innerHTML = `
      <div class="kpi"><span>FIRE number (semplice, SWR ${(f.swr * 100).toFixed(1)}%)</span><b>${fmt(tp.simple)}</b></div>
      <div class="kpi"><span>FIRE number (due fasi, con pensioni)</span><b>${fmt(tp.twoPhase)}</b></div>
      <div class="note pos">Le pensioni riducono il tuo fabbisogno di ${fmt(tp.pensionSaving)}.</div>
      <div class="muted small">Ponte ${f.fireAge}→${f.pensionStartAge}: ${fmt(tp.bridgeCapital)} · capitale perpetuo post-${f.pensionStartAge}: ${fmt(tp.legacyCapital)}</div>
      <div class="swr-row">SWR:
        ${[0.03, 0.035, 0.04].map(s => `<button class="chip ${s === f.swr ? 'active' : ''}" data-swr="${s}">${(s * 100).toFixed(1)}%</button>`).join('')}
      </div>`;
    const fnCard = card('3.1 FIRE Number', fnBody);
    grid.appendChild(fnCard);
    $$('[data-swr]', fnBody).forEach(b => b.onclick = () => { f.swr = parseFloat(b.dataset.swr); save(); render(); });

    // 3.2 Coast FIRE
    const today = currentMonth();
    const liquid = E.liquidNetWorth(data, lastMonthWith(today)) || 0;
    const age = E.ageAt(data.settings.birthDate, today);
    const coastBase = E.coastFire(f, liquid, age, f.realReturnBase);
    const coastOpt = E.coastFire(f, liquid, age, f.realReturnOptimistic);
    const coastBody = el('div');
    coastBody.innerHTML = `
      <div class="muted small">Patrimonio liquido attuale: ${fmt(liquid)} · età: ${age.toFixed(1)}</div>
      <table class="mini"><tr><th></th><th>5%</th><th>7%</th></tr>
        <tr><td>Coast number @ ${f.coastAge}</td><td>${fmt(coastBase.coastNumberAtCoastAge)}</td><td>${fmt(coastOpt.coastNumberAtCoastAge)}</td></tr>
        <tr><td>Richiesto oggi</td><td>${fmt(coastBase.requiredToday)}</td><td>${fmt(coastOpt.requiredToday)}</td></tr>
        <tr><td>Gap oggi</td><td>${fmt(coastBase.gapToday)}</td><td>${fmt(coastOpt.gapToday)}</td></tr>
      </table>
      <div class="note">Se smetti di contribuire oggi, raggiungi il FIRE number a ${coastBase.ageIfStopNow ? coastBase.ageIfStopNow.toFixed(1) : '—'} anni (5%) / ${coastOpt.ageIfStopNow ? coastOpt.ageIfStopNow.toFixed(1) : '—'} (7%).</div>`;
    grid.appendChild(card('3.2 Coast FIRE', coastBody));

    // 3.3 On-track
    grid.appendChild(onTrackCard());

    // 3.4 Projection
    grid.appendChild(projectionCard());

    // 3.5 Monte Carlo
    grid.appendChild(monteCarloCard());

    // 3.6 What-if
    grid.appendChild(whatIfCard());
  }

  function lastMonthWith(ym) {
    const months = E.monthSeries(data).filter(m => E.ymCompare(m, ym) <= 0);
    return months.length ? months[months.length - 1] : ym;
  }

  function onTrackCard() {
    const body = el('div');
    const plans = data.plans || [];
    if (!plans.length) {
      body.innerHTML = `<p class="muted">Nessun piano salvato.</p>`;
      const b = el('button', 'btn', 'Crea baseline dal mese corrente');
      b.onclick = rebaseline; body.appendChild(b);
      return card('3.3 On-track check', body);
    }
    const plan = plans[plans.length - 1];
    const months = E.monthSeries(data).filter(m => E.ymCompare(m, plan.createdAt) >= 0);
    const curve = E.planProjectionCurve(plan, months);
    const actual = months.map(m => E.liquidNetWorth(data, m));
    body.appendChild(canvas('c-ontrack'));
    const lastActual = actual[actual.length - 1], lastPlan = curve[months[months.length - 1]];
    const diff = (lastActual != null) ? E.r2(lastActual - lastPlan) : null;
    body.appendChild(el('div', diff >= 0 ? 'note pos' : 'note neg',
      diff == null ? 'Dati insufficienti' :
        `Sei ${diff >= 0 ? 'avanti' : 'indietro'} di ${fmt(Math.abs(diff))} rispetto al piano salvato a ${E.monthLabelIT(plan.createdAt)}.`));
    const b = el('button', 'btn small', 'Re-baseline'); b.onclick = rebaseline;
    body.appendChild(b);
    setTimeout(() => {
      if (!$('#c-ontrack')) return;
      charts.ot = new Chart($('#c-ontrack'), {
        type: 'line',
        data: {
          labels: months.map(E.monthLabelIT),
          datasets: [
            { label: 'Reale', data: actual, borderColor: '#3498db', tension: .2, spanGaps: true },
            { label: 'Piano', data: months.map(m => curve[m]), borderColor: '#95a5a6', borderDash: [5, 3], pointRadius: 0 },
          ],
        }, options: baseLineOpts(),
      });
    }, 0);
    return card('3.3 On-track check', body);
  }
  function rebaseline() {
    const today = lastMonthWith(currentMonth());
    const liquid = E.liquidNetWorth(data, today) || 0;
    const plan = {
      createdAt: today,
      startingLiquidNetWorth: liquid,
      plannedMonthlyContribution: 2000,
      assumedRealReturn: data.settings.fire.realReturnBase,
    };
    data.plans = data.plans || [];
    data.plans.push(plan);
    if (data.plans.length > 5) data.plans = data.plans.slice(-5);
    save(); render();
  }

  let projState = null;
  function projectionCard() {
    const f = data.settings.fire;
    const today = currentMonth();
    if (!projState) projState = {
      start: E.liquidNetWorth(data, lastMonthWith(today)) || 0,
      monthly: 2000, applyBox3: true,
    };
    const body = el('div');
    body.innerHTML = `
      <div class="form-row"><label>Portafoglio attuale</label><input type="number" id="pj-start" value="${projState.start}"></div>
      <div class="form-row"><label>Contributo mensile</label><input type="number" id="pj-monthly" value="${projState.monthly}"></div>
      <label class="toggle"><input type="checkbox" id="pj-box3" ${projState.applyBox3 ? 'checked' : ''}> Applica Box 3 drag da ${f.box3StartDate}</label>
      <div id="pj-out"></div>`;
    body.appendChild(canvas('c-proj'));
    const recompute = () => {
      projState.start = parseFloat($('#pj-start').value) || 0;
      projState.monthly = parseFloat($('#pj-monthly').value) || 0;
      projState.applyBox3 = $('#pj-box3').checked;
      const fireN = E.fireNumberSimple(f);
      const common = {
        start: projState.start, monthlyContribution: projState.monthly,
        fireNumber: fireN, startYM: today, maxYears: 50,
        box3DragAnnual: f.box3DragAnnual, box3StartYM: f.box3StartDate,
      };
      const base = E.project(Object.assign({}, common, { annualReturn: f.realReturnBase, applyBox3: projState.applyBox3 }));
      const opt = E.project(Object.assign({}, common, { annualReturn: f.realReturnOptimistic, applyBox3: projState.applyBox3 }));
      const noBox3 = E.project(Object.assign({}, common, { annualReturn: f.realReturnBase, applyBox3: false }));
      const box3Impact = E.r2(noBox3.finalBalance - base.finalBalance);
      $('#pj-out').innerHTML =
        `<div class="kpi"><span>FIRE (base 5%)</span><b>${base.reachedYear || '—'}</b></div>
         <div class="kpi"><span>FIRE (ottimistico 7%)</span><b>${opt.reachedYear || '—'}</b></div>
         ${projState.applyBox3 ? `<div class="muted small">Impatto Box 3 sul capitale finale: −${fmt(box3Impact)}</div>` : ''}`;
      if (charts.pj) { try { charts.pj.destroy(); } catch (e) {} }
      const labels = base.series.filter((_, i) => i % 12 === 0).map(p => E.ymParts(p.ym).y);
      charts.pj = new Chart($('#c-proj'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Base 5%', data: base.series.filter((_, i) => i % 12 === 0).map(p => p.balance), borderColor: '#3498db', pointRadius: 0, tension: .2 },
            { label: 'Ottimistico 7%', data: opt.series.filter((_, i) => i % 12 === 0).map(p => p.balance), borderColor: '#27ae60', pointRadius: 0, tension: .2 },
            { label: 'FIRE number', data: labels.map(() => fireN), borderColor: NEG, borderDash: [2, 2], pointRadius: 0 },
          ],
        }, options: baseLineOpts(),
      });
    };
    setTimeout(() => {
      ['pj-start', 'pj-monthly'].forEach(id => $('#' + id).oninput = recompute);
      $('#pj-box3').onchange = recompute;
      recompute();
    }, 0);
    return card('3.4 Proiezione & Anni al FIRE', body);
  }

  function monteCarloCard() {
    const body = el('div');
    const b = el('button', 'btn', 'Esegui simulazione (1.000 run)');
    const out = el('div', '', '<p class="muted small">Metodo semplificato: rendimenti annui normali (Box-Muller). Non è consulenza.</p>');
    body.appendChild(b); body.appendChild(out); body.appendChild(canvas('c-mc'));
    b.onclick = () => {
      const f = data.settings.fire;
      const today = currentMonth();
      const age = E.ageAt(data.settings.birthDate, today);
      const res = E.monteCarlo({
        start: E.liquidNetWorth(data, lastMonthWith(today)) || 0,
        monthlyContribution: projState ? projState.monthly : 2000,
        currentAge: age, fireAge: f.fireAge, pensionStartAge: f.pensionStartAge,
        monthlyExpenseFire: f.monthlyExpenseFire, expectedPensionMonthly: f.expectedPensionMonthly,
        inflation: f.inflation, meanReturn: f.monteCarlo.meanReturn, stdDev: f.monteCarlo.stdDev,
        runs: f.monteCarlo.runs,
      });
      out.innerHTML = `
        <div class="kpi"><span>Probabilità di successo</span><b>${fmtP(res.successProbability)}</b></div>
        <div class="kpi"><span>Età mediana al FIRE number</span><b>${res.medianCrossingAge ? res.medianCrossingAge.toFixed(1) : '—'}</b></div>
        <div class="kpi"><span>Capitale mediano finale</span><b>${fmt(res.medianFinal)}</b></div>`;
      if (charts.mc) { try { charts.mc.destroy(); } catch (e) {} }
      charts.mc = new Chart($('#c-mc'), {
        type: 'line',
        data: {
          labels: res.fan.map(p => p.age.toFixed(0)),
          datasets: [
            { label: 'P90', data: res.fan.map(p => p.p90), borderColor: '#27ae60', pointRadius: 0, fill: false },
            { label: 'P75', data: res.fan.map(p => p.p75), borderColor: '#2ecc71', pointRadius: 0, fill: false },
            { label: 'P50', data: res.fan.map(p => p.p50), borderColor: '#3498db', pointRadius: 0, fill: false },
            { label: 'P25', data: res.fan.map(p => p.p25), borderColor: '#e67e22', pointRadius: 0, fill: false },
            { label: 'P10', data: res.fan.map(p => p.p10), borderColor: '#e74c3c', pointRadius: 0, fill: false },
          ],
        }, options: baseLineOpts(),
      });
    };
    return card('3.5 Monte Carlo', body);
  }

  function whatIfCard() {
    const f = data.settings.fire;
    const today = currentMonth();
    const start = E.liquidNetWorth(data, lastMonthWith(today)) || 0;
    const st = { contrib: 2000, ret: f.realReturnBase, exp: f.monthlyExpenseFire };
    const body = el('div');
    body.innerHTML = `
      <div class="form-row"><label>Contributo mensile: <b id="wi-c-l">${fmt(st.contrib)}</b></label>
        <input type="range" id="wi-c" min="0" max="4000" step="50" value="${st.contrib}"></div>
      <div class="form-row"><label>Rendimento reale: <b id="wi-r-l">${(st.ret * 100).toFixed(1)}%</b></label>
        <input type="range" id="wi-r" min="3" max="8" step="0.1" value="${st.ret * 100}"></div>
      <div class="form-row"><label>Spese FIRE: <b id="wi-e-l">${fmt(st.exp)}</b></label>
        <input type="range" id="wi-e" min="1500" max="3500" step="50" value="${st.exp}"></div>
      <div id="wi-out"></div>
      <hr>
      <div class="form-row"><label>Spesa una tantum oggi</label><input type="number" id="wi-oneoff" value="0"></div>
      <div id="wi-oneoff-out" class="muted small"></div>`;
    const recompute = () => {
      st.contrib = +$('#wi-c').value; st.ret = +$('#wi-r').value / 100; st.exp = +$('#wi-e').value;
      $('#wi-c-l').textContent = fmt(st.contrib);
      $('#wi-r-l').textContent = (st.ret * 100).toFixed(1) + '%';
      $('#wi-e-l').textContent = fmt(st.exp);
      const fireN = st.exp * 12 / f.swr;
      const base = E.project({ start, monthlyContribution: st.contrib, annualReturn: st.ret, fireNumber: fireN, startYM: today, maxYears: 60 });
      $('#wi-out').innerHTML = `<div class="kpi"><span>Arrivo al FIRE</span><b>${base.reachedYear || 'oltre 60 anni'}</b></div>
        <div class="muted small">FIRE number: ${fmt(fireN)}</div>`;
      const oneoff = +$('#wi-oneoff').value || 0;
      if (oneoff > 0) {
        const delayed = E.project({ start: start - oneoff, monthlyContribution: st.contrib, annualReturn: st.ret, fireNumber: fireN, startYM: today, maxYears: 60 });
        const dm = (base.reachedYM && delayed.reachedYM) ? E.monthsBetween(base.reachedYM, delayed.reachedYM) : null;
        $('#wi-oneoff-out').textContent = dm == null ? 'Impatto non calcolabile.' :
          `Una spesa di ${fmt(oneoff)} oggi ritarda il FIRE di ${dm} mesi.`;
      } else $('#wi-oneoff-out').textContent = '';
    };
    setTimeout(() => {
      ['wi-c', 'wi-r', 'wi-e', 'wi-oneoff'].forEach(id => $('#' + id).oninput = recompute);
      recompute();
    }, 0);
    return card('3.6 Scenario rapido (what-if)', body);
  }

  /* ========================== TAB 4 — Pensioni ====================== */
  function renderPensioni(main) {
    const pens = (data.accounts || []).filter(a => !E.isLiquid(a));
    if (!pens.length) { main.appendChild(el('div', 'empty', '<p>Nessun conto pensione.</p>')); return; }
    const months = E.monthSeries(data);
    const grid = el('div', 'grid');
    main.appendChild(grid);

    grid.appendChild(card('Totale montante', canvas('c-pension-total')));
    grid.appendChild(card('Contributi cumulativi (datore vs personale)', canvas('c-pension-contrib')));

    // total line + per fund
    setTimeout(() => {
      charts.pt = new Chart($('#c-pension-total'), {
        type: 'line',
        data: {
          labels: months.map(E.monthLabelIT),
          datasets: pens.map(a => ({
            label: a.name, borderColor: a.color, tension: .2, pointRadius: 0,
            data: months.map(m => { const s = E.getSnapshot(data, a.id, m); return s ? s.balancePayday : null; }),
          })).concat([{
            label: 'Totale', borderColor: '#2c3e50', borderWidth: 3, tension: .2, pointRadius: 0,
            data: months.map(m => E.lockedNetWorth(data, m)),
          }]),
        }, options: baseLineOpts(),
      });

      let cumEmp = 0, cumPers = 0;
      const emp = [], pers = [];
      months.forEach(m => {
        const entry = E.getEntry(data, m);
        (entry && entry.contributions || []).forEach(c => {
          const a = E.accountById(data, c.accountId);
          if (!a || E.isLiquid(a)) return;
          if (c.source === 'external') cumEmp += c.amount; else cumPers += c.amount;
        });
        emp.push(E.r2(cumEmp)); pers.push(E.r2(cumPers));
      });
      charts.pc = new Chart($('#c-pension-contrib'), {
        type: 'line',
        data: {
          labels: months.map(E.monthLabelIT),
          datasets: [
            { label: 'Datore (external)', data: emp, borderColor: '#2980b9', backgroundColor: 'rgba(41,128,185,.4)', fill: 'origin', pointRadius: 0, tension: .2 },
            { label: 'Personale', data: pers.map((v, i) => E.r2(v + emp[i])), borderColor: '#27ae60', backgroundColor: 'rgba(39,174,96,.4)', fill: '-1', pointRadius: 0, tension: .2 },
          ],
        }, options: baseLineOpts(),
      });
    }, 0);

    // monthly table
    const table = el('table', 'data-table');
    const header = ['Mese'].concat(pens.map(a => a.name)).concat(['Totale', 'Δ mese', 'Contributi del mese']);
    table.innerHTML = `<thead><tr>${header.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
    const tb = el('tbody');
    months.slice().reverse().forEach((m, idx, arr) => {
      const total = E.lockedNetWorth(data, m);
      const prevM = E.ymPrev(m);
      const prevTotal = E.lockedNetWorth(data, prevM);
      const entry = E.getEntry(data, m);
      let monthContrib = 0;
      (entry && entry.contributions || []).forEach(c => { const a = E.accountById(data, c.accountId); if (a && !E.isLiquid(a)) monthContrib += c.amount; });
      const tr = el('tr');
      tr.innerHTML = `<td>${E.monthLabelIT(m)}</td>` +
        pens.map(a => { const s = E.getSnapshot(data, a.id, m); return `<td>${s ? fmt(s.balancePayday) : '—'}</td>`; }).join('') +
        `<td>${fmt(total)}</td><td>${prevTotal != null && total != null ? fmt(E.r2(total - prevTotal)) : '—'}</td><td>${fmt(monthContrib)}</td>`;
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    main.appendChild(table);

    // summary card + lijfrente deduction
    const f = data.settings.fire;
    const today = currentMonth();
    const totalNow = E.lockedNetWorth(data, lastMonthWith(today)) || 0;
    // avg monthly contribution last 12m
    let sum = 0, cnt = 0;
    months.slice(-12).forEach(m => {
      const entry = E.getEntry(data, m); let mc = 0;
      (entry && entry.contributions || []).forEach(c => { const a = E.accountById(data, c.accountId); if (a && !E.isLiquid(a)) mc += c.amount; });
      sum += mc; cnt++;
    });
    const avg = cnt ? E.r2(sum / cnt) : 0;
    const age = E.ageAt(data.settings.birthDate, today);
    const yearsToPension = f.pensionStartAge - age;
    const proj = E.project({ start: totalNow, monthlyContribution: avg, annualReturn: f.realReturnBase, fireNumber: Infinity, startYM: today, maxYears: Math.max(0, Math.ceil(yearsToPension)) });
    const monthlyFromPension = E.r2(proj.finalBalance * f.swr / 12);

    const sumBody = el('div');
    sumBody.innerHTML = `
      <div class="kpi"><span>Totale a oggi</span><b>${fmt(totalNow)}</b></div>
      <div class="kpi"><span>Contributo medio (12m)</span><b>${fmt(avg)}</b></div>
      <div class="kpi"><span>Proiezione a ${f.pensionStartAge} (base)</span><b>${fmt(proj.finalBalance)}</b></div>
      <div class="muted small">≈ ${fmt(monthlyFromPension)}/mese al ${(f.swr * 100).toFixed(1)}% SWR</div>`;
    const useBtn = el('button', 'btn small', 'Usa questa stima come pensione attesa');
    useBtn.onclick = () => { f.expectedPensionMonthly = monthlyFromPension; save(); render(); };
    sumBody.appendChild(useBtn);
    grid.appendChild(card('Riepilogo', sumBody));

    // lijfrente deduction
    const yr = today.slice(0, 4);
    let lijfPersonal = 0;
    months.filter(m => m.startsWith(yr)).forEach(m => {
      const entry = E.getEntry(data, m);
      (entry && entry.contributions || []).forEach(c => {
        const a = E.accountById(data, c.accountId);
        if (a && !E.isLiquid(a) && c.source === 'current') lijfPersonal += c.amount;
      });
    });
    const ded = E.r2(lijfPersonal * f.marginalRateBox1);
    grid.appendChild(card('Deduzione fiscale lijfrente', el('div', '',
      `<div class="kpi"><span>Contributi personali ${yr}</span><b>${fmt(lijfPersonal)}</b></div>
       <div class="note">Deduzione Box 1 stimata: ${fmt(ded)} (× aliquota ${(f.marginalRateBox1 * 100).toFixed(0)}%).</div>
       <div class="muted small">Promemoria del beneficio fiscale, non consulenza.</div>`)));
  }

  /* ======================= TAB 5 — Impostazioni ===================== */
  function renderImpostazioni(main) {
    main.appendChild(el('h2', '', 'Impostazioni'));

    // Accounts
    const accBody = el('div');
    (data.accounts || []).forEach(a => {
      const row = el('div', 'acc-row');
      row.innerHTML = `
        <input type="color" value="${a.color}" data-color="${a.id}">
        <span class="acc-name">${a.name}</span>
        <span class="badge">${a.type}</span>
        <span class="badge ${E.isLiquid(a) ? 'liq' : 'lock'}">${E.isLiquid(a) ? 'liquid' : 'locked'}</span>
        <span class="muted small">${a.archivedAt ? 'archiviato ' + a.archivedAt : 'attivo'}</span>
        <span class="acc-actions">
          ${a.archivedAt ? `<button class="link" data-restore="${a.id}">ripristina</button>` : `<button class="link" data-archive="${a.id}">archivia</button>`}
          <button class="link neg" data-del="${a.id}">elimina</button>
        </span>`;
      accBody.appendChild(row);
    });
    const addForm = el('div', 'add-acc');
    addForm.innerHTML = `<input id="na-name" placeholder="Nome conto">
      <select id="na-type"><option value="current">current</option><option value="savings">savings</option><option value="broker">broker</option><option value="pension">pension</option></select>
      <button class="btn small" id="na-add">+ Aggiungi conto</button>`;
    accBody.appendChild(addForm);
    main.appendChild(card('Conti', accBody));
    bindAccountActions(accBody);

    // Params
    const f = data.settings.fire;
    const p = el('div', 'param-grid');
    const params = [
      ['defaultPaydayDayOfMonth', 'Giorno payday', data.settings.defaultPaydayDayOfMonth, 'settings'],
      ['birthDate', 'Data di nascita', data.settings.birthDate, 'settings', 'date'],
      ['monthlyExpenseFire', 'Spese FIRE/mese', f.monthlyExpenseFire, 'fire'],
      ['swr', 'SWR', f.swr, 'fire'],
      ['realReturnBase', 'Rend. reale base', f.realReturnBase, 'fire'],
      ['realReturnOptimistic', 'Rend. reale ottimistico', f.realReturnOptimistic, 'fire'],
      ['inflation', 'Inflazione', f.inflation, 'fire'],
      ['coastAge', 'Coast age', f.coastAge, 'fire'],
      ['fireAge', 'FIRE age', f.fireAge, 'fire'],
      ['pensionStartAge', 'Età pensione', f.pensionStartAge, 'fire'],
      ['expectedPensionMonthly', 'Pensione attesa/mese', f.expectedPensionMonthly, 'fire'],
      ['box3DragAnnual', 'Box 3 drag annuo', f.box3DragAnnual, 'fire'],
      ['box3StartDate', 'Box 3 da (YYYY-MM)', f.box3StartDate, 'fire', 'text'],
      ['marginalRateBox1', 'Aliquota marginale Box 1', f.marginalRateBox1, 'fire'],
    ];
    params.forEach(([key, label, val, scope, type]) => {
      const row = el('div', 'form-row');
      row.innerHTML = `<label>${label}</label><input type="${type || 'number'}" step="any" value="${val}" data-param="${key}" data-scope="${scope}">`;
      p.appendChild(row);
    });
    main.appendChild(card('Parametri', p));
    $$('[data-param]', p).forEach(inp => inp.onchange = () => {
      const key = inp.dataset.param, scope = inp.dataset.scope;
      let v = inp.type === 'number' ? parseFloat(inp.value) : inp.value;
      if (scope === 'fire') f[key] = v; else data.settings[key] = v;
      save();
    });

    // Milestones
    const ms = el('div');
    (data.settings.milestones || []).forEach(m => {
      const row = el('div', 'form-row');
      row.innerHTML = `<input value="${m.date}" data-ms-date="${m.id}" style="max-width:90px">
        <input value="${m.label}" data-ms-label="${m.id}" style="flex:1">
        <button class="link neg" data-ms-del="${m.id}">×</button>`;
      ms.appendChild(row);
    });
    const addMs = el('button', 'btn small', '+ Milestone');
    addMs.onclick = () => { data.settings.milestones.push({ id: uuid(), date: currentMonth(), label: 'Nuova milestone', note: null }); save(); render(); };
    ms.appendChild(addMs);
    main.appendChild(card('Milestone', ms));
    bindMilestones(ms);

    // Data
    const dataBody = el('div', 'row');
    const expBtn = el('button', 'btn', 'Esporta JSON'); expBtn.onclick = doExport;
    const impBtn = el('button', 'btn', 'Importa JSON');
    const impInput = el('input'); impInput.type = 'file'; impInput.accept = '.json'; impInput.style.display = 'none';
    impInput.onchange = doImport; impBtn.onclick = () => impInput.click();
    const demoBtn = el('button', 'btn', 'Carica dati demo'); demoBtn.onclick = () => { if (confirm('Sovrascrive i dati attuali con il demo?')) { seedDemo(); render(); } };
    const wipeBtn = el('button', 'btn neg', 'Cancella tutto'); wipeBtn.onclick = doWipe;
    [expBtn, impBtn, impInput, demoBtn, wipeBtn].forEach(b => dataBody.appendChild(b));
    main.appendChild(card('Dati', dataBody));
  }

  function bindAccountActions(root) {
    $$('[data-color]', root).forEach(i => i.onchange = () => { E.accountById(data, i.dataset.color).color = i.value; save(); render(); });
    $$('[data-archive]', root).forEach(b => b.onclick = () => archiveAccount(b.dataset.archive));
    $$('[data-restore]', root).forEach(b => b.onclick = () => { E.accountById(data, b.dataset.restore).archivedAt = null; save(); render(); });
    $$('[data-del]', root).forEach(b => b.onclick = () => deleteAccount(b.dataset.del));
    $('#na-add', root).onclick = () => {
      const name = $('#na-name').value.trim(); if (!name) return;
      data.accounts.push(mkAccount(name, $('#na-type').value)); save(); render();
    };
  }
  function archiveAccount(id) {
    const acc = E.accountById(data, id);
    const months = E.monthSeries(data);
    let lastBal = null;
    for (let i = months.length - 1; i >= 0; i--) { const s = E.getSnapshot(data, id, months[i]); if (s) { lastBal = s.balancePayday; break; } }
    if (lastBal) {
      if (!confirm(`Saldo finale ${fmt(lastBal)} — registra un trasferimento interno verso il conto di destinazione per non perdere la continuità del patrimonio. Procedere con l'archiviazione?`)) return;
    }
    acc.archivedAt = lastMonthWith(currentMonth());
    save(); render();
  }
  function deleteAccount(id) {
    const hasSnap = Object.values(data.snapshots).some(s => s.accountId === id);
    if (hasSnap) { alert('Eliminazione consentita solo senza snapshot. Archivia invece.'); return; }
    if (!confirm('Eliminare il conto?')) return;
    if (!confirm('Conferma definitiva: eliminare?')) return;
    data.accounts = data.accounts.filter(a => a.id !== id); save(); render();
  }
  function bindMilestones(root) {
    $$('[data-ms-date]', root).forEach(i => i.onchange = () => { findMs(i.dataset.msDate).date = i.value; save(); });
    $$('[data-ms-label]', root).forEach(i => i.onchange = () => { findMs(i.dataset.msLabel).label = i.value; save(); });
    $$('[data-ms-del]', root).forEach(b => b.onclick = () => { data.settings.milestones = data.settings.milestones.filter(m => m.id !== b.dataset.msDel); save(); render(); });
  }
  function findMs(id) { return data.settings.milestones.find(m => m.id === id); }

  /* ------------------------- export / import -------------------------- */
  function doExport() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `financial-dashboard-${d}.json`; a.click();
    URL.revokeObjectURL(url);
  }
  function doImport(ev) {
    const file = ev.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const migrated = migrate(parsed);
        const accDiff = (migrated.accounts || []).length;
        const monthDiff = E.monthSeries(migrated).length;
        if (confirm(`Importare? Conti: ${accDiff}, mesi: ${monthDiff}. Sostituisce i dati attuali.`)) {
          data = migrated; save(); render();
        }
      } catch (e) { alert('File non valido: ' + e.message); }
    };
    reader.readAsText(file);
  }
  function doWipe() {
    const t = prompt('Digita CONFERMA per cancellare tutti i dati.');
    if (t === 'CONFERMA') { data = defaultData(); save(); render(); }
  }

  /* =========================== Entry form ============================ */
  function openEntryForm(ym) {
    const existing = E.getEntry(data, ym);
    const entry = existing ? JSON.parse(JSON.stringify(existing)) : {
      yearMonth: ym, salaryNet: 0, extraSalary: 0, otherIncome: 0,
      paydayDayOfMonth: data.settings.defaultPaydayDayOfMonth,
      contributions: [], internalTransfers: [], flags: [],
    };
    const draftSnaps = {};
    (data.accounts || []).forEach(a => {
      const s = E.getSnapshot(data, a.id, ym);
      draftSnaps[a.id] = s ? Object.assign({}, s) : { accountId: a.id, yearMonth: ym, balancePayday: null, balancePaydayMinus1: null };
    });

    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');
    overlay.appendChild(modal);

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    const active = E.accountsActiveAt(data, ym);
    const liquidAccs = active.filter(a => E.isLiquid(a));
    const pensionAccs = active.filter(a => !E.isLiquid(a));
    const curAccs = active.filter(a => a.type === 'current');

    function buildBody() {
      modal.innerHTML = `<div class="modal-head"><h2>Mese ${E.monthLabelIT(ym)}</h2><button class="close" id="ef-close">×</button></div>
        <div class="modal-body">
          <section><h3>1. Entrate</h3>
            <div class="form-row"><label>Stipendio netto</label><input type="number" id="ef-salary" value="${entry.salaryNet || 0}"></div>
            <div class="form-row"><label>Extra (13ª/14ª/bonus)</label><input type="number" id="ef-extra" value="${entry.extraSalary || 0}"></div>
            <div class="form-row"><label>Altre entrate</label><input type="number" id="ef-other" value="${entry.otherIncome || 0}"></div>
            <div class="form-row"><label>Giorno payday</label><input type="number" id="ef-payday" value="${entry.paydayDayOfMonth}"></div>
          </section>
          <section><h3>2. Conto corrente</h3>
            ${curAccs.map(a => `
              <div class="form-row"><label>${a.name} — saldo giorno−1</label><input type="number" data-snap-minus1="${a.id}" value="${valOr(draftSnaps[a.id].balancePaydayMinus1)}"></div>
              <div class="form-row"><label>${a.name} — saldo payday</label><input type="number" data-snap-payday="${a.id}" value="${valOr(draftSnaps[a.id].balancePayday)}"></div>
            `).join('')}
          </section>
          <section><h3>3. Saldi conti</h3>
            ${liquidAccs.filter(a => a.type !== 'current').map(a => `
              <div class="form-row"><label>${a.name}</label><input type="number" data-snap-payday="${a.id}" value="${valOr(draftSnaps[a.id].balancePayday)}"></div>`).join('')}
            ${pensionAccs.length ? `<details open><summary>Pensioni</summary>
              ${pensionAccs.map(a => `<div class="form-row"><label>${a.name}</label><input type="number" data-snap-payday="${a.id}" value="${valOr(draftSnaps[a.id].balancePayday)}"></div>`).join('')}
            </details>` : ''}
          </section>
          <section><h3>4. Contributi</h3><div id="ef-contribs"></div>
            <button class="btn small" id="ef-add-contrib">+ Aggiungi contributo</button></section>
          <section><h3>5. Trasferimenti interni</h3><div id="ef-transfers"></div>
            <button class="btn small" id="ef-add-transfer">+ Aggiungi trasferimento</button></section>
        </div>
        <div class="modal-foot" id="ef-summary"></div>
        <div class="modal-actions"><button class="btn" id="ef-cancel">Annulla</button><button class="btn primary" id="ef-save">Salva</button></div>`;

      renderContribs(); renderTransfers(); updateSummary();
      $('#ef-close').onclick = close; $('#ef-cancel').onclick = close;
      $('#ef-add-contrib').onclick = () => { entry.contributions.push({ id: uuid(), accountId: (active.find(a => a.type !== 'current') || active[0]).id, amount: 0, kind: 'recurring', source: 'current' }); renderContribs(); updateSummary(); };
      $('#ef-add-transfer').onclick = () => { entry.internalTransfers.push({ id: uuid(), fromAccountId: curAccs[0] ? curAccs[0].id : active[0].id, toAccountId: active[1] ? active[1].id : active[0].id, amount: 0, note: null }); renderTransfers(); updateSummary(); };
      $('#ef-save').onclick = saveEntry;
      ['ef-salary', 'ef-extra', 'ef-other', 'ef-payday'].forEach(id => $('#' + id).oninput = readTop);
      $$('[data-snap-payday],[data-snap-minus1]').forEach(i => i.oninput = readSnaps);
    }

    function valOr(v) { return v == null ? '' : v; }
    function readTop() {
      entry.salaryNet = +$('#ef-salary').value || 0;
      entry.extraSalary = +$('#ef-extra').value || 0;
      entry.otherIncome = +$('#ef-other').value || 0;
      entry.paydayDayOfMonth = +$('#ef-payday').value || data.settings.defaultPaydayDayOfMonth;
      updateSummary();
    }
    function readSnaps() {
      $$('[data-snap-payday]').forEach(i => {
        const v = i.value === '' ? null : +i.value;
        draftSnaps[i.dataset.snapPayday].balancePayday = v;
      });
      $$('[data-snap-minus1]').forEach(i => {
        const v = i.value === '' ? null : +i.value;
        draftSnaps[i.dataset.snapMinus1].balancePaydayMinus1 = v;
      });
      updateSummary();
    }
    function renderContribs() {
      const box = $('#ef-contribs'); box.innerHTML = '';
      entry.contributions.forEach((c, idx) => {
        const row = el('div', 'multi-row');
        row.innerHTML = `
          <select data-c-acc="${idx}">${active.map(a => `<option value="${a.id}" ${a.id === c.accountId ? 'selected' : ''}>${a.name}</option>`).join('')}</select>
          <input type="number" data-c-amt="${idx}" value="${c.amount}" placeholder="importo" style="max-width:110px">
          <select data-c-kind="${idx}"><option value="recurring" ${c.kind === 'recurring' ? 'selected' : ''}>recurring</option><option value="one_off" ${c.kind === 'one_off' ? 'selected' : ''}>one-off</option></select>
          <select data-c-src="${idx}"><option value="current" ${c.source === 'current' ? 'selected' : ''}>current</option><option value="external" ${c.source === 'external' ? 'selected' : ''}>external</option></select>
          <button class="link neg" data-c-del="${idx}">×</button>`;
        box.appendChild(row);
      });
      box.querySelectorAll('[data-c-acc]').forEach(s => s.onchange = () => { entry.contributions[+s.dataset.cAcc].accountId = s.value; updateSummary(); });
      box.querySelectorAll('[data-c-amt]').forEach(s => s.oninput = () => { entry.contributions[+s.dataset.cAmt].amount = +s.value || 0; updateSummary(); });
      box.querySelectorAll('[data-c-kind]').forEach(s => s.onchange = () => { entry.contributions[+s.dataset.cKind].kind = s.value; });
      box.querySelectorAll('[data-c-src]').forEach(s => s.onchange = () => { entry.contributions[+s.dataset.cSrc].source = s.value; updateSummary(); });
      box.querySelectorAll('[data-c-del]').forEach(s => s.onclick = () => { entry.contributions.splice(+s.dataset.cDel, 1); renderContribs(); updateSummary(); });
    }
    function renderTransfers() {
      const box = $('#ef-transfers'); box.innerHTML = '';
      entry.internalTransfers.forEach((t, idx) => {
        const row = el('div', 'multi-row');
        row.innerHTML = `
          <select data-t-from="${idx}">${active.map(a => `<option value="${a.id}" ${a.id === t.fromAccountId ? 'selected' : ''}>${a.name}</option>`).join('')}</select>
          <span>→</span>
          <select data-t-to="${idx}">${active.map(a => `<option value="${a.id}" ${a.id === t.toAccountId ? 'selected' : ''}>${a.name}</option>`).join('')}</select>
          <input type="number" data-t-amt="${idx}" value="${t.amount}" placeholder="importo" style="max-width:110px">
          <input data-t-note="${idx}" value="${t.note || ''}" placeholder="nota" style="max-width:120px">
          <button class="link neg" data-t-del="${idx}">×</button>`;
        box.appendChild(row);
      });
      box.querySelectorAll('[data-t-from]').forEach(s => s.onchange = () => { entry.internalTransfers[+s.dataset.tFrom].fromAccountId = s.value; updateSummary(); });
      box.querySelectorAll('[data-t-to]').forEach(s => s.onchange = () => { entry.internalTransfers[+s.dataset.tTo].toAccountId = s.value; updateSummary(); });
      box.querySelectorAll('[data-t-amt]').forEach(s => s.oninput = () => { entry.internalTransfers[+s.dataset.tAmt].amount = +s.value || 0; updateSummary(); });
      box.querySelectorAll('[data-t-note]').forEach(s => s.oninput = () => { entry.internalTransfers[+s.dataset.tNote].note = s.value || null; });
      box.querySelectorAll('[data-t-del]').forEach(s => s.onclick = () => { entry.internalTransfers.splice(+s.dataset.tDel, 1); renderTransfers(); updateSummary(); });
    }
    function updateSummary() {
      // build a temp data with the draft to compute live metrics
      const temp = liveData();
      const liquid = E.liquidNetWorth(temp, ym);
      const prevLiquid = E.liquidNetWorth(temp, E.ymPrev(ym));
      const exp = E.estimatedExpenses(temp, ym);
      const rec = E.reconcile(temp, ym);
      let warns = [];
      if (exp.flags.includes('NEGATIVE_EXPENSES')) warns.push('⚠ spese negative — verifica entrate');
      if (exp.flags.includes('MISSING_SNAPSHOT')) warns.push('⚠ snapshot mancante');
      if (rec.mismatch) warns.push(`⚠ discrepanza contributi ${fmt(rec.diff)}`);
      $('#ef-summary').innerHTML = `
        <span>Patrimonio: <b>${fmt(liquid)}</b></span>
        <span>Δ mese: <b>${liquid != null && prevLiquid != null ? fmt(E.r2(liquid - prevLiquid)) : '—'}</b></span>
        <span>Spese stimate: <b>${exp.value == null ? '—' : fmt(exp.value)}</b></span>
        ${warns.length ? `<span class="warn">${warns.join(' · ')}</span>` : ''}`;
    }
    function liveData() {
      const temp = JSON.parse(JSON.stringify(data));
      temp.entries[ym] = entry;
      Object.values(draftSnaps).forEach(s => {
        if (s.balancePayday == null && s.balancePaydayMinus1 == null) return;
        temp.snapshots[s.accountId + '|' + ym] = s;
      });
      return temp;
    }
    function saveEntry() {
      // validate: each active liquid account has a balance
      const missing = liquidAccs.filter(a => draftSnaps[a.id].balancePayday == null);
      if (missing.length) {
        if (!confirm(`Conti senza saldo: ${missing.map(a => a.name).join(', ')}. Salvare comunque (marcati come saltati)?`)) return;
        entry.flags = entry.flags.filter(f => f !== 'MISSING_SNAPSHOT');
        entry.flags.push('MISSING_SNAPSHOT');
      }
      data.entries[ym] = entry;
      Object.values(draftSnaps).forEach(s => {
        const key = s.accountId + '|' + ym;
        if (s.balancePayday == null && s.balancePaydayMinus1 == null) { delete data.snapshots[key]; return; }
        data.snapshots[key] = s;
      });
      save(); close(); render();
    }

    // attach to the document BEFORE buildBody so the global `$('#ef-...')`
    // queries inside buildBody/renderContribs/renderTransfers resolve.
    document.body.appendChild(overlay);
    buildBody();
  }

  /* --------------------------- chart options -------------------------- */
  function baseLineOpts() {
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + fmt(c.parsed.y) } },
      },
      scales: { y: { ticks: { callback: v => fmt(v) } } },
    };
  }
  function pctLineOpts() {
    const o = baseLineOpts();
    o.scales = { y: { ticks: { callback: v => v + '%' } } };
    o.plugins.tooltip = { callbacks: { label: (c) => c.dataset.label + ': ' + (c.parsed.y == null ? '—' : c.parsed.y.toFixed(1) + '%') } };
    return o;
  }

  /* ------------------------------ boot -------------------------------- */
  load();
  window.addEventListener('DOMContentLoaded', render);
  if (document.readyState !== 'loading') render();
  // expose for debugging/tests in browser
  window.FD = { get data() { return data; }, save, render, seedDemo, go };
})();
