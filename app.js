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
  let chartCfg = {};

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
        // AI provider config (local only). 'artifact' = keyless in-artifact
        // endpoint; otherwise an Anthropic key or any OpenAI-compatible API
        // (DeepSeek, OpenAI, Groq, OpenRouter, local Ollama/LM Studio).
        ai: { provider: 'artifact', baseUrl: '', apiKey: '', model: '' },
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
    d.settings.ai = Object.assign(base.settings.ai, (d.settings && d.settings.ai) || {});
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
    { id: 'simulatore', label: 'Simulatore', icon: '🤖' },
    { id: 'tasse', label: 'Tasse', icon: '🧾' },
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
    charts = {}; chartCfg = {};

    if (E.monthSeries(data).length === 0 && activeTab !== 'impostazioni' && activeTab !== 'simulatore' && activeTab !== 'tasse') {
      main.appendChild(emptyState());
      return;
    }
    switch (activeTab) {
      case 'andamento': renderAndamento(main); break;
      case 'storico': renderStorico(main); break;
      case 'fire': renderFire(main); break;
      case 'simulatore': renderSimulatore(main); break;
      case 'tasse': renderTasse(main); break;
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
  // card(title, body, infoHtml?) — when infoHtml is given, a ⓘ button in the
  // header toggles a plain-language explanation panel.
  function card(title, bodyNode, infoHtml) {
    const c = el('div', 'card');
    if (title) {
      const head = el('div', 'card-head');
      head.appendChild(el('h3', 'card-title', title));
      if (infoHtml) {
        const info = el('button', 'info-btn', 'ⓘ'); info.type = 'button'; info.title = 'Cosa mostra';
        const pop = el('div', 'info-pop'); pop.innerHTML = infoHtml; pop.style.display = 'none';
        info.onclick = (e) => { e.stopPropagation(); pop.style.display = pop.style.display === 'none' ? 'block' : 'none'; };
        head.appendChild(info);
        c.appendChild(head); c.appendChild(pop);
      } else c.appendChild(head);
    }
    if (bodyNode) c.appendChild(bodyNode);
    return c;
  }
  // canvas(id) — chart container with an "enlarge" button that reopens the same
  // chart config in a large modal. Charts must be created via makeChart(id,cfg).
  function canvas(id) {
    const wrap = el('div', 'chart-wrap');
    const exp = el('button', 'enlarge-btn', '⤢'); exp.type = 'button'; exp.title = 'Ingrandisci';
    exp.onclick = () => openChartModal(id);
    const cv = document.createElement('canvas');
    cv.id = id; wrap.appendChild(cv); wrap.appendChild(exp); return wrap;
  }
  function makeChart(id, config) {
    if (charts[id]) { try { charts[id].destroy(); } catch (e) {} }
    chartCfg[id] = config;
    charts[id] = new Chart($('#' + id), config);
    return charts[id];
  }
  function openChartModal(id) {
    const cfg = chartCfg[id]; if (!cfg) return;
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal chart-modal');
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    modal.innerHTML = `<div class="modal-head"><h2>${id && chartTitles[id] || 'Grafico'}</h2><button class="close" id="cm-x">×</button></div>`;
    const big = el('div', 'chart-wrap big-chart');
    const cv = document.createElement('canvas'); big.appendChild(cv);
    modal.appendChild(big);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    modal.querySelector('#cm-x').onclick = close;
    // clone config so the modal chart is independent
    new Chart(cv, JSON.parse(JSON.stringify(cfg, cfgReplacer)));
  }
  // Chart configs contain function callbacks; strip them for the deep clone and
  // rely on defaults in the enlarged view (axes still format via the y options
  // we keep as data, tooltips fall back to Chart defaults).
  function cfgReplacer(k, v) { return typeof v === 'function' ? undefined : v; }
  const chartTitles = {
    'c-networth': 'Patrimonio nel tempo', 'c-contrib': 'Contributi vs Mercato',
    'c-monthly': 'Crescita mensile', 'c-savings': 'Savings rate',
    'c-expenses': 'Spese stimate', 'c-alloc': 'Allocazione',
  };
  const fmt = E.fmtEUR;
  const fmtP = E.fmtPct;

  /* ---- plain-language explanations shown via the ⓘ buttons ---- */
  const INFO = {
    networth: 'Il <b>patrimonio liquido</b> (linea piena) è la somma dei conti accessibili — corrente, depositi, broker — la base usata per i calcoli FIRE. Il <b>totale</b> (tratteggiato) aggiunge le pensioni. La linea grigia sono i <b>contributi cumulativi</b> (quanto hai versato), la riga rossa il tuo <b>FIRE number</b>.',
    contrib: 'Scompone la crescita degli investimenti in due parti cumulate: i <b>contributi</b> (soldi che hai versato tu) e la <b>crescita di mercato</b> (quanto hanno reso). La distanza fra le due aree è il guadagno del mercato.',
    monthly: 'Variazione del patrimonio liquido mese su mese (verde = su, rosso = giù). Nel tooltip la barra è divisa in <b>mercato</b> (rendimento) e <b>apporti netti</b> (versamenti e variazione di liquidità). I due si sommano alla barra.',
    savings: 'Quota del reddito che NON spendi: <code>(reddito − spese − variazione liquidità) / reddito</code>. La linea arancione è la media a 12 mesi, più stabile.',
    expenses: 'Spesa stimata del mese, ricavata dai saldi del conto corrente: <code>saldo iniziale + entrate − versamenti − trasferimenti − saldo finale</code>. NON la inserisci a mano. ⚠ Se in un mese sposti soldi tra conti senza registrarlo come trasferimento, qui può uscire un numero sbagliato (o negativo): registra il trasferimento per correggere.',
    alloc: 'Come è distribuito il patrimonio tra i conti, mese per mese (aree impilate). Utile per vedere il peso di ciascun broker/deposito nel tempo.',
  };

  const INFO_FIRE = {
    headline: 'Stima quando raggiungi il FIRE number partendo dal <b>capitale FIRE</b> di oggi e versando ogni mese l\'importo indicato (di default la <b>mediana</b> di quanto hai investito negli ultimi 12 mesi — robusta ai versamenti una-tantum). La barra mostra a che percentuale del FIRE number sei.',
    number: 'Il <b>FIRE number</b> è il capitale che ti rende finanziariamente indipendente: spese annue ÷ SWR (Safe Withdrawal Rate). La versione <b>a due fasi</b> tiene conto che dall\'età pensionabile in poi arrivano le pensioni, quindi serve meno capitale.',
    coast: '<b>Coast FIRE</b> = hai già abbastanza capitale investito perché, anche smettendo di versare oggi, la sola crescita composta ti porti al FIRE number entro l\'età obiettivo. Usa solo il capitale investito (broker), non la liquidità.',
    ontrack: 'Confronta il tuo capitale reale con la curva del <b>piano salvato</b> (una proiezione congelata al momento del salvataggio). Ti dice se sei avanti o indietro rispetto a quel piano, in € e in mesi.',
    projection: 'Proietta il capitale nel futuro al ritmo di versamento e al rendimento che imposti. Il <b>Box 3</b> è la patrimoniale olandese, applicata dalla data impostata. Cambia il contributo mensile: è un\'assunzione, non un dato fisso.',
    montecarlo: 'Simula 1.000 possibili futuri con rendimenti casuali (non un singolo scenario liscio). La <b>probabilità di successo</b> è la quota di simulazioni in cui i soldi non finiscono prima dei 90 anni. Il ventaglio mostra gli scenari da sfortunato (P10) a fortunato (P90).',
    whatif: 'Sposta i cursori per vedere subito l\'effetto sull\'anno di arrivo al FIRE, senza toccare i tuoi dati salvati. Utile per "e se versassi 500 in più?".',
    personal: 'Il rendimento reale del tuo portafoglio per anno (metodo Simple Dietz, approssimato), confrontato con l\'ipotesi che usi nelle proiezioni. Verde = hai fatto meglio dell\'ipotesi.',
  };

  /* ========================== TAB 1 — Andamento ===================== */
  function renderAndamento(main) {
    const months = E.monthSeries(data);
    const grid = el('div', 'grid');
    main.appendChild(grid);

    grid.appendChild(card('Patrimonio nel tempo', canvas('c-networth'), INFO.networth));
    grid.appendChild(card('Contributi vs Mercato', canvas('c-contrib'), INFO.contrib));
    grid.appendChild(card('Crescita mensile', canvas('c-monthly'), INFO.monthly));
    grid.appendChild(card('Savings rate', canvas('c-savings'), INFO.savings));
    grid.appendChild(card('Spese stimate', canvas('c-expenses'), INFO.expenses));
    grid.appendChild(card('Allocazione', allocationBlock(), INFO.alloc));
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
    makeChart('c-networth', {
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
    makeChart('c-contrib', {
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
    makeChart('c-monthly', {
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
                // Decompose so the parts sum to the bar exactly:
                // Δ liquido = mercato + apporti netti (versamenti + variazione liquidità).
                const i = items[0].dataIndex; const m = months[i];
                if (deltas[i] == null) return [];
                const mk = E.portfolioMarketGrowth(data, m) || 0;
                const apporti = E.r2(deltas[i] - mk);
                return ['Mercato: ' + fmt(mk), 'Apporti netti: ' + fmt(apporti)];
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
    makeChart('c-savings', {
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
    makeChart('c-expenses', {
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
    const accs = (data.accounts || []).filter(a => showArchived || !a.archivedAt || true);
    const datasets = accs.map(a => ({
      label: a.name,
      data: months.map(m => {
        const s = E.getSnapshot(data, a.id, m);
        return s && s.balancePayday != null ? s.balancePayday : null;
      }),
      borderColor: a.color, backgroundColor: a.color + '55', fill: true, tension: .2, pointRadius: 0,
    }));
    makeChart('c-alloc', {
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

    // Birth-date nudge: every age-based number is wrong until this is set.
    if (isPlaceholderBirthDate(data.settings.birthDate)) {
      const warn = el('div', 'note neg');
      warn.innerHTML = `⚠ La <b>data di nascita</b> è un segnaposto (${data.settings.birthDate}). Tutti i calcoli per età (Coast, Monte Carlo, due fasi) sono errati finché non la imposti in <b>Impostazioni → Parametri</b>.`;
      main.appendChild(warn);
    }

    // Headline: time-to-FIRE + progress, using actual savings pace.
    main.appendChild(fireHeadline());

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
    grid.appendChild(card('3.1 FIRE Number', fnBody, INFO_FIRE.number));
    $$('[data-swr]', fnBody).forEach(b => b.onclick = () => { f.swr = parseFloat(b.dataset.swr); save(); render(); });

    // 3.2 Coast FIRE — crisp version. Uses FIRE capital, not total liquid.
    const today = currentMonth();
    const liquid = E.fireCapital(data, lastMonthWith(today)) || 0;
    const age = E.ageAt(data.settings.birthDate, today);
    const coastBase = E.coastFire(f, liquid, age, f.realReturnBase);
    const coastOpt = E.coastFire(f, liquid, age, f.realReturnOptimistic);
    const coasting = liquid >= coastBase.requiredToday;
    const coastBody = el('div');
    coastBody.innerHTML = `
      ${fireCapitalCaption()}
      <div class="note ${coasting ? 'pos' : 'neg'}" style="font-size:15px">
        ${coasting
          ? `✓ <b>Sei in Coast FIRE.</b> Anche se smetti di versare oggi, il capitale cresce da solo fino al FIRE number entro i ${f.fireAge} anni.`
          : `Non ancora in Coast FIRE: ti manca <b>${fmt(coastBase.gapToday)}</b> di capitale per poter smettere di versare e arrivarci comunque.`}
      </div>
      <div class="kpi"><span>Capitale FIRE oggi</span><b>${fmt(liquid)}</b></div>
      <div class="kpi"><span>Capitale che basterebbe oggi (5% reale)</span><b>${fmt(coastBase.requiredToday)}</b></div>
      <div class="kpi"><span>Se smetti di versare oggi, FIRE a</span><b>${coastBase.ageIfStopNow ? coastBase.ageIfStopNow.toFixed(0) + ' anni' : '—'} <span class="muted" style="font-weight:400">(a ${(f.realReturnOptimistic * 100).toFixed(0)}%: ${coastOpt.ageIfStopNow ? coastOpt.ageIfStopNow.toFixed(0) : '—'})</span></b></div>`;
    grid.appendChild(card('3.2 Coast FIRE', coastBody, INFO_FIRE.coast));

    // 3.3 On-track
    grid.appendChild(onTrackCard());

    // 3.4 Projection
    grid.appendChild(projectionCard());

    // 3.5 Monte Carlo
    grid.appendChild(monteCarloCard());

    // 3.6 What-if
    grid.appendChild(whatIfCard());

    // 3.7 Rendimento personale (Simple Dietz)
    grid.appendChild(personalReturnCard());
  }

  function isPlaceholderBirthDate(bd) {
    return !bd || bd === '1990-01-01' || bd === '1990-01-15';
  }

  // Default monthly contribution for projections = the MEDIAN monthly invested
  // over the last 12 months. Median (not mean) so a couple of big one-off lump
  // deposits don't inflate it into an impossible "I save €7.700/mo". Always an
  // editable assumption, never a fixed truth.
  function actualMonthlyContribution() {
    const med = E.medianInvested(data, 12);
    if (med != null && med > 0) return Math.round(med);
    const v = E.trailingInvested(data, 12);
    return (v != null && v > 0) ? Math.round(v) : 2000;
  }

  // Big headline card: when you reach the FIRE number at your real pace + a
  // progress bar, plus Coast status.
  function fireHeadline() {
    const f = data.settings.fire;
    const today = currentMonth();
    const cap = E.fireCapital(data, lastMonthWith(today)) || 0;
    const fireN = E.fireNumberSimple(f);
    const monthly = actualMonthlyContribution();
    const age = E.ageAt(data.settings.birthDate, today);
    const proj = E.project({ start: cap, monthlyContribution: monthly, annualReturn: f.realReturnBase, fireNumber: fireN, startYM: today, maxYears: 70 });
    const pct = Math.max(0, Math.min(1, cap / fireN));
    let arrival = '—', arrivalAge = '';
    if (proj.reachedYM) {
      arrival = E.ymParts(proj.reachedYM).y;
      if (age != null) arrivalAge = ` · età ${(age + E.monthsBetween(today, proj.reachedYM) / 12).toFixed(0)}`;
    } else arrival = 'oltre 70 anni';
    const coast = E.coastFire(f, cap, age, f.realReturnBase);
    const coasting = cap >= coast.requiredToday;
    const body = el('div');
    body.innerHTML = `
      <div class="headline-row">
        <div><div class="muted small">Capitale FIRE</div><div class="big">${fmt(cap)}</div></div>
        <div><div class="muted small">FIRE number</div><div class="big">${fmt(fireN)}</div></div>
        <div><div class="muted small">Arrivo stimato</div><div class="big">${arrival}<span class="muted" style="font-size:14px">${arrivalAge}</span></div></div>
      </div>
      <div class="progress"><div class="progress-fill" style="width:${(pct * 100).toFixed(1)}%"></div><span class="progress-label">${(pct * 100).toFixed(1)}% verso il FIRE number</span></div>
      <div class="note ${coasting ? 'pos' : ''}">${coasting
        ? '✓ Sei già in <b>Coast FIRE</b>: anche senza nuovi contributi arrivi al FIRE number entro i ' + f.fireAge + ' anni.'
        : 'Non ancora in Coast FIRE — gap di ' + fmt(coast.gapToday) + ' rispetto al capitale che basterebbe smettendo oggi.'}</div>
      <div class="muted small">Ipotesi: versi <b>${fmt(monthly)}/mese</b> (mediana 12m) con rendimento ${(f.realReturnBase * 100).toFixed(1)}%. Cambia l'importo nella card "Proiezione".</div>`;
    return card('🔥 A che punto sei', body, INFO_FIRE.headline);
  }

  function personalReturnCard() {
    const body = el('div');
    const years = Array.from(new Set(E.monthSeries(data).map(m => m.slice(0, 4)))).sort();
    const f = data.settings.fire;
    let rows = '';
    years.forEach(y => {
      const pr = E.personalReturn(data, parseInt(y, 10));
      if (!pr) return;
      const cls = pr.ret >= f.realReturnBase ? 'pos' : 'neg';
      rows += `<tr><td>${y}</td><td class="${cls}">${fmtP(pr.ret)}</td><td>${fmt(pr.marketGrowth)}</td><td>${fmt(pr.netFlow)}</td></tr>`;
    });
    body.innerHTML = rows
      ? `<table class="mini"><tr><th>Anno</th><th>Rendimento</th><th>Mercato</th><th>Flussi netti</th></tr>${rows}</table>
         <div class="muted small">Simple Dietz sul capitale FIRE. Confronto con l'assunzione di ${(f.realReturnBase * 100).toFixed(1)}% (verde = sopra). Stima approssimata.</div>`
      : '<p class="muted small">Servono almeno due mesi di dati per stimare il rendimento.</p>';
    return card('3.7 Rendimento personale', body, INFO_FIRE.personal);
  }

  function lastMonthWith(ym) {
    const months = E.monthSeries(data).filter(m => E.ymCompare(m, ym) <= 0);
    return months.length ? months[months.length - 1] : ym;
  }

  // Small caption listing which accounts feed the FIRE math, so it's never a
  // mystery what "capitale FIRE" includes.
  function fireCapitalCaption() {
    const active = E.accountsActiveAt(data, lastMonthWith(currentMonth()));
    const incl = active.filter(a => E.includesInFire(a)).map(a => a.name);
    const txt = incl.length ? incl.join(', ') : 'nessun conto — configura in Impostazioni';
    return `<div class="note small">Capitale FIRE = <b>${txt}</b>. <span class="muted">Cash e risparmi esclusi (modifica in Impostazioni → Conti).</span></div>`;
  }

  function onTrackCard() {
    const body = el('div');
    const plans = data.plans || [];
    if (!plans.length) {
      body.innerHTML = `<div class="note">Nessun piano di riferimento salvato. Crea una <b>baseline</b> oggi: l'app congela una proiezione e da qui in poi ti dice se sei avanti o indietro.</div>`;
      const b = el('button', 'btn primary', 'Salva baseline da oggi');
      b.onclick = rebaseline; body.appendChild(b);
      return card('3.3 Sei in linea col piano?', body, INFO_FIRE.ontrack);
    }
    const plan = plans[plans.length - 1];
    const months = E.monthSeries(data).filter(m => E.ymCompare(m, plan.createdAt) >= 0);
    const curve = E.planProjectionCurve(plan, months);
    const actual = months.map(m => E.fireCapital(data, m));
    const lastActual = actual[actual.length - 1], lastPlan = curve[months[months.length - 1]];
    const diff = (lastActual != null) ? E.r2(lastActual - lastPlan) : null;
    // translate the € gap into "months ahead/behind" at the plan's pace
    const monthlyPace = plan.plannedMonthlyContribution || 1;
    const monthsOff = diff != null ? Math.round(diff / monthlyPace) : null;
    if (diff != null) {
      const ahead = diff >= 0;
      body.appendChild(el('div', ahead ? 'note pos' : 'note neg',
        `<span style="font-size:16px"><b>${ahead ? 'Sei avanti' : 'Sei indietro'} di ${fmt(Math.abs(diff))}</b></span>` +
        (monthsOff ? ` — circa <b>${Math.abs(monthsOff)} ${Math.abs(monthsOff) === 1 ? 'mese' : 'mesi'}</b> ${ahead ? "in anticipo" : "di ritardo"}` : '') +
        ` rispetto al piano di ${E.monthLabelIT(plan.createdAt)}.`));
    }
    body.appendChild(canvas('c-ontrack'));
    const b = el('button', 'btn small', 'Aggiorna baseline a oggi'); b.onclick = rebaseline;
    body.appendChild(b);
    setTimeout(() => {
      if (!$('#c-ontrack')) return;
      makeChart('c-ontrack', {
        type: 'line',
        data: {
          labels: months.map(E.monthLabelIT),
          datasets: [
            { label: 'Reale', data: actual, borderColor: '#3498db', borderWidth: 2.5, tension: .2, spanGaps: true },
            { label: 'Piano', data: months.map(m => curve[m]), borderColor: '#95a5a6', borderDash: [5, 3], pointRadius: 0 },
          ],
        }, options: baseLineOpts(),
      });
    }, 0);
    return card('3.3 Sei in linea col piano?', body, INFO_FIRE.ontrack);
  }
  function rebaseline() {
    const today = lastMonthWith(currentMonth());
    const liquid = E.fireCapital(data, today) || 0;
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
      start: E.fireCapital(data, lastMonthWith(today)) || 0,
      monthly: actualMonthlyContribution(), applyBox3: true,
    };
    const med = E.medianInvested(data, 12), mean = E.trailingInvested(data, 12);
    const body = el('div');
    body.innerHTML = `
      <div class="form-row"><label>Capitale FIRE attuale</label><input type="number" id="pj-start" value="${projState.start}"></div>
      <div class="form-row"><label>Contributo mensile <span class="muted">(modificabile)</span></label><input type="number" id="pj-monthly" value="${projState.monthly}"></div>
      ${med != null ? `<div class="muted small" style="margin:-2px 0 8px">Negli ultimi 12 mesi: mediana <b>${fmt(med)}</b>/mese${mean != null && Math.abs(mean - med) > 50 ? `, media ${fmt(mean)} (gonfiata dai versamenti una-tantom)` : ''}. È un'ipotesi: cambiala come vuoi.</div>` : ''}
      <label class="toggle"><input type="checkbox" id="pj-box3" ${projState.applyBox3 ? 'checked' : ''}> Applica Box 3 (patrimoniale NL) da ${f.box3StartDate}</label>
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
      const labels = base.series.filter((_, i) => i % 12 === 0).map(p => E.ymParts(p.ym).y);
      makeChart('c-proj', {
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
    return card('3.4 Proiezione & Anni al FIRE', body, INFO_FIRE.projection);
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
        start: E.fireCapital(data, lastMonthWith(today)) || 0,
        monthlyContribution: projState ? projState.monthly : actualMonthlyContribution(),
        currentAge: age, fireAge: f.fireAge, pensionStartAge: f.pensionStartAge,
        monthlyExpenseFire: f.monthlyExpenseFire, expectedPensionMonthly: f.expectedPensionMonthly,
        inflation: f.inflation, meanReturn: f.monteCarlo.meanReturn, stdDev: f.monteCarlo.stdDev,
        runs: f.monteCarlo.runs,
      });
      out.innerHTML = `
        <div class="kpi"><span>Probabilità di successo</span><b>${fmtP(res.successProbability)}</b></div>
        <div class="kpi"><span>Età mediana al FIRE number</span><b>${res.medianCrossingAge ? res.medianCrossingAge.toFixed(1) : '—'}</b></div>
        <div class="kpi"><span>Capitale mediano finale</span><b>${fmt(res.medianFinal)}</b></div>`;
      makeChart('c-mc', {
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
    return card('3.5 Monte Carlo', body, INFO_FIRE.montecarlo);
  }

  function whatIfCard() {
    const f = data.settings.fire;
    const today = currentMonth();
    const start = E.fireCapital(data, lastMonthWith(today)) || 0;
    const st = { contrib: actualMonthlyContribution(), ret: f.realReturnBase, exp: f.monthlyExpenseFire };
    const body = el('div');
    body.innerHTML = `
      <div class="form-row"><label>Contributo mensile: <b id="wi-c-l">${fmt(st.contrib)}</b></label>
        <input type="range" id="wi-c" min="0" max="8000" step="50" value="${st.contrib}"></div>
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
    return card('3.6 Scenario rapido (what-if)', body, INFO_FIRE.whatif);
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
        ${E.isLiquid(a) ? `<label class="toggle small" title="Includi nel capitale per i calcoli FIRE"><input type="checkbox" data-fire="${a.id}" ${E.includesInFire(a) ? 'checked' : ''}> FIRE</label>` : ''}
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
    const impInput = el('input'); impInput.type = 'file'; impInput.accept = '.json'; impInput.style.display = 'none';
    impInput.onchange = doImport;
    const impBtn = el('button', 'btn', 'Importa (sostituisci)');
    impBtn.onclick = () => { impInput.dataset.mode = 'replace'; impInput.click(); };
    const mergeBtn = el('button', 'btn', 'Importa e unisci');
    mergeBtn.onclick = () => { impInput.dataset.mode = 'merge'; impInput.click(); };
    const demoBtn = el('button', 'btn', 'Carica dati demo'); demoBtn.onclick = () => { if (confirm('Sovrascrive i dati attuali con il demo?')) { seedDemo(); render(); } };
    const wipeBtn = el('button', 'btn neg', 'Cancella tutto'); wipeBtn.onclick = doWipe;
    [expBtn, impBtn, mergeBtn, impInput, demoBtn, wipeBtn].forEach(b => dataBody.appendChild(b));
    main.appendChild(card('Dati', dataBody));

    // ---- AI / Modelli ----
    main.appendChild(aiSettingsCard());
  }

  function aiSettingsCard() {
    const ai = data.settings.ai || (data.settings.ai = { provider: 'artifact', baseUrl: '', apiKey: '', model: '' });
    const body = el('div');
    const opts = Object.keys(AI_PRESETS).map(k => `<option value="${k}" ${ai.provider === k ? 'selected' : ''}>${AI_PRESETS[k].label}</option>`).join('');
    body.innerHTML = `
      <div class="form-row"><label>Provider</label><select id="ai-prov">${opts}</select></div>
      <div class="form-row"><label>Endpoint (Base URL)</label><input id="ai-url" value="${ai.baseUrl || ''}" placeholder="(preset)"></div>
      <div class="form-row"><label>Modello</label><input id="ai-model" value="${ai.model || ''}" placeholder="(preset)"></div>
      <div class="form-row"><label>Chiave API</label><input id="ai-key" type="password" value="${ai.apiKey || ''}" placeholder="solo nel tuo browser" autocomplete="off"></div>
      <div class="row"><button class="btn small" id="ai-test">Prova connessione</button><span id="ai-status" class="muted small"></span></div>
      <div class="muted small" style="margin-top:8px">La chiave resta <b>solo in questo browser</b> (localStorage), mai nel codice. Esempi senza chiave: <b>Artifacts</b> o <b>Ollama</b> locale. OpenAI-compatible copre DeepSeek, OpenAI, Groq, OpenRouter, LM Studio. La chiamata diretta dal browser espone la chiave sul tuo PC: non condividere il file.</div>`;
    const sync = () => {
      ai.provider = $('#ai-prov', body).value;
      ai.baseUrl = $('#ai-url', body).value.trim();
      ai.model = $('#ai-model', body).value.trim();
      ai.apiKey = $('#ai-key', body).value.trim();
      save();
    };
    // prefill placeholders from preset when provider changes
    $('#ai-prov', body).onchange = () => {
      const p = AI_PRESETS[$('#ai-prov', body).value];
      if (p) { $('#ai-url', body).value = p.baseUrl; $('#ai-model', body).value = p.model; }
      sync();
    };
    ['ai-url', 'ai-model', 'ai-key'].forEach(id => $('#' + id, body).onchange = sync);
    $('#ai-test', body).onclick = async () => {
      sync();
      const st = $('#ai-status', body); st.textContent = 'Provo…'; st.className = 'muted small';
      try {
        const out = await callModel('parse', { system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }] });
        st.textContent = '✓ Connessione riuscita' + (out ? ' (' + out.slice(0, 24).replace(/\s+/g, ' ') + '…)' : '');
        st.className = 'pos small';
      } catch (e) {
        st.textContent = '✗ Non raggiungibile: ' + e.message + (aiCfg().provider === 'artifact' ? ' — da file locale serve una chiave o Ollama.' : '');
        st.className = 'neg small';
      }
    };
    return card('AI / Modelli', body,
      'Scegli dove gira l\'AI dei tab Simulatore e Tasse. <b>Artifacts</b>: senza chiave, solo dentro claude.ai. <b>Anthropic/OpenAI/DeepSeek/Groq/OpenRouter</b>: incolla la tua chiave. <b>Ollama</b>: modello locale sul tuo PC, senza chiave. Il motore deterministico funziona comunque, con o senza AI.');
  }

  function bindAccountActions(root) {
    $$('[data-color]', root).forEach(i => i.onchange = () => { E.accountById(data, i.dataset.color).color = i.value; save(); render(); });
    $$('[data-archive]', root).forEach(b => b.onclick = () => archiveAccount(b.dataset.archive));
    $$('[data-restore]', root).forEach(b => b.onclick = () => { E.accountById(data, b.dataset.restore).archivedAt = null; save(); render(); });
    $$('[data-del]', root).forEach(b => b.onclick = () => deleteAccount(b.dataset.del));
    $$('[data-fire]', root).forEach(c => c.onchange = () => { E.accountById(data, c.dataset.fire).includeInFire = c.checked; save(); render(); });
    $('#na-add', root).onclick = () => {
      const name = $('#na-name').value.trim(); if (!name) return;
      data.accounts.push(mkAccount(name, $('#na-type').value)); save(); render();
    };
  }
  function archiveAccount(id) {
    const acc = E.accountById(data, id);
    const months = E.monthSeries(data);
    let lastBal = null, lastMonth = null;
    for (let i = months.length - 1; i >= 0; i--) { const s = E.getSnapshot(data, id, months[i]); if (s) { lastBal = s.balancePayday; lastMonth = months[i]; break; } }
    if (lastBal) {
      // Non-zero final balance: offer to record a transfer to a destination so
      // the money's continuity is preserved (spec §1.1).
      openArchiveModal(acc, lastBal, lastMonth);
      return;
    }
    acc.archivedAt = lastMonthWith(currentMonth());
    save(); render();
  }

  // Mini modal: "register a transfer of the closing balance to ___" then archive.
  function openArchiveModal(acc, lastBal, lastMonth) {
    const dest = E.accountsActiveAt(data, lastMonth).filter(a => a.id !== acc.id);
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal'); modal.style.maxWidth = '460px';
    overlay.appendChild(modal);
    const close = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    modal.innerHTML = `<div class="modal-head"><h2>Archivia ${acc.name}</h2><button class="close" id="am-x">×</button></div>
      <div class="modal-body">
        <p>Saldo finale <b>${fmt(lastBal)}</b> a ${E.monthLabelIT(lastMonth)}. Registra un trasferimento verso il conto di destinazione per non perdere la continuità del patrimonio.</p>
        <div class="form-row"><label>Destinazione</label>
          <select id="am-dest">${dest.map(a => `<option value="${a.id}">${a.name}</option>`).join('')}</select></div>
        <div class="form-row"><label>Mese</label><input id="am-month" value="${lastMonth}" style="max-width:110px"></div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="am-skip">Archivia senza trasferimento</button>
        <button class="btn primary" id="am-go">Registra trasferimento e archivia</button>
      </div>`;
    modal.querySelector('#am-x').onclick = close;
    modal.querySelector('#am-skip').onclick = () => { acc.archivedAt = lastMonth; save(); close(); render(); };
    modal.querySelector('#am-go').onclick = () => {
      const destId = modal.querySelector('#am-dest').value;
      const m = modal.querySelector('#am-month').value || lastMonth;
      if (destId) {
        const e = E.getEntry(data, m) || { yearMonth: m, salaryNet: 0, extraSalary: 0, otherIncome: 0, paydayDayOfMonth: data.settings.defaultPaydayDayOfMonth, contributions: [], internalTransfers: [], flags: [] };
        e.internalTransfers = e.internalTransfers || [];
        e.internalTransfers.push({ id: uuid(), fromAccountId: acc.id, toAccountId: destId, amount: lastBal, note: 'chiusura ' + acc.name });
        data.entries[m] = e;
      }
      acc.archivedAt = m;
      save(); close(); render();
    };
    if (!dest.length) { modal.querySelector('#am-go').disabled = true; }
    document.body.appendChild(overlay);
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
    const mode = ev.target.dataset.mode || 'replace';
    const file = ev.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const migrated = migrate(parsed);
        if (mode === 'merge') {
          const before = { acc: data.accounts.length, snaps: Object.keys(data.snapshots).length, months: E.monthSeries(data).length };
          const merged = mergeData(data, migrated);
          const addedAcc = merged.accounts.length - before.acc;
          const addedSnaps = Object.keys(merged.snapshots).length - before.snaps;
          const addedMonths = E.monthSeries(merged).length - before.months;
          if (confirm(`Unisci? +${addedAcc} conti, +${addedMonths} mesi, ${addedSnaps >= 0 ? '+' : ''}${addedSnaps} saldi (i valori importati sovrascrivono quelli esistenti per gli stessi id/mesi).`)) {
            data = merged; save(); render();
          }
        } else {
          const accDiff = (migrated.accounts || []).length;
          const monthDiff = E.monthSeries(migrated).length;
          if (confirm(`Importare? Conti: ${accDiff}, mesi: ${monthDiff}. SOSTITUISCE tutti i dati attuali.`)) {
            data = migrated; save(); render();
          }
        }
      } catch (e) { alert('File non valido: ' + e.message); }
      ev.target.value = '';
    };
    reader.readAsText(file);
  }
  // Merge imported data into current, keyed by id (accounts) and key (snapshots
  // / entries). Imported values win on collision; nothing is deleted.
  function mergeData(cur, inc) {
    const out = JSON.parse(JSON.stringify(cur));
    const haveAcc = new Set(out.accounts.map(a => a.id));
    (inc.accounts || []).forEach(a => { if (!haveAcc.has(a.id)) out.accounts.push(a); });
    Object.assign(out.snapshots, inc.snapshots || {});
    Object.assign(out.entries, inc.entries || {});
    return out;
  }
  function doWipe() {
    const t = prompt('Digita CONFERMA per cancellare tutti i dati.');
    if (t === 'CONFERMA') { data = defaultData(); save(); render(); }
  }

  /* ===================== TAB — Simulatore FIRE (AI) =================== */
  // Schema is extended additively: data.fireSim seeded lazily from existing
  // accounts + FIRE settings the first time the tab is opened.
  const FIRE_CLASS_DEFAULTS = [
    { id: 'us_lc', name: 'Azionario USA large cap', realReturn: 0.05, volatility: 0.16, kind: 'liquid', w: 0.35 },
    { id: 'eu', name: 'Azionario Europa', realReturn: 0.05, volatility: 0.17, kind: 'liquid', w: 0.20 },
    { id: 'em', name: 'Mercati emergenti', realReturn: 0.055, volatility: 0.20, kind: 'liquid', w: 0.12 },
    { id: 'scv', name: 'Small cap value', realReturn: 0.06, volatility: 0.19, kind: 'liquid', w: 0.08 },
    { id: 'gov', name: 'Obblig. governative EU', realReturn: 0.005, volatility: 0.06, kind: 'liquid', w: 0.15 },
    { id: 'corp', name: 'Obblig. corporate (scad. 2030)', realReturn: 0.015, volatility: 0.05, kind: 'liquid', w: 0.10 },
    { id: 'cash', name: 'Liquidità', realReturn: 0, volatility: 0.01, kind: 'liquid', w: 0 },
    { id: 'pen_nl', name: 'Pensione occupazionale NL', realReturn: 0.03, volatility: 0.08, kind: 'pension', w: 0 },
    { id: 'pen_it', name: 'Pensione privata IT', realReturn: 0.025, volatility: 0.07, kind: 'pension', w: 0 },
  ];

  function ensureFireSim() {
    if (data.fireSim && data.fireSim.classes) return;
    const f = data.settings.fire;
    const lastM = lastMonthWith(currentMonth());
    const brokerTotal = E.fireCapital(data, lastM) || 0;
    let cash = 0;
    (data.accounts || []).forEach(a => {
      if (a.type === 'savings' || a.type === 'current') {
        const s = E.getSnapshot(data, a.id, lastM); if (s && s.balancePayday != null) cash += s.balancePayday;
      }
    });
    const pensionTotal = E.lockedNetWorth(data, lastM) || 0;
    const classes = FIRE_CLASS_DEFAULTS.map(c => {
      let value = 0;
      if (c.id === 'cash') value = E.r2(cash);
      else if (c.id === 'pen_it') value = E.r2(pensionTotal);   // Generali is the IT pension in this ledger
      else if (c.kind === 'liquid') value = E.r2(brokerTotal * c.w);
      return { id: c.id, name: c.name, value, realReturn: c.realReturn, volatility: c.volatility, kind: c.kind };
    });
    const age = E.ageAt(data.settings.birthDate, currentMonth());
    const med = E.medianInvested(data, 12);
    data.fireSim = {
      classes,
      profile: {
        currentAge: age != null ? Math.round(age) : 36,
        retirementAge: f.fireAge || 55,
        statePensionAge: 70,
        endAge: 90,
        annualContribution: med != null && med > 0 ? Math.round(med * 12) : 24000,
        annualSpend: Math.round((f.monthlyExpenseFire || 2500) * 12),
        statePensionAnnual: Math.round((f.expectedPensionMonthly || 0) * 12),
        shock: { enabled: false, atAge: f.fireAge || 55, severity: 0.35 },
      },
    };
    save();
  }

  /* ---- AI abstraction: provider-agnostic, graceful fallback ----
     Providers:
       'artifact'  → keyless in-artifact Anthropic endpoint (default; works in
                     Claude Artifacts, unreachable from a plain local file)
       'anthropic' → Anthropic Messages API with your x-api-key
       'openai'    → any OpenAI-compatible /chat/completions API: OpenAI,
                     DeepSeek, Groq, OpenRouter, Together, local Ollama/LM Studio
     Role→model map is used only when no explicit model is configured. */
  const AI_MODELS = {
    parse: 'claude-sonnet-4-6', reason: 'claude-opus-4-8', review: 'claude-opus-4-8',
    optimizer: 'claude-sonnet-4-6', reviewer: 'claude-opus-4-8', reconciler: 'claude-opus-4-8',
  };
  const AI_PRESETS = {
    artifact:  { label: 'Claude Artifacts (senza chiave)', shape: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '' },
    anthropic: { label: 'Anthropic (chiave)', shape: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' },
    openai:    { label: 'OpenAI', shape: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    deepseek:  { label: 'DeepSeek', shape: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    groq:      { label: 'Groq', shape: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    openrouter:{ label: 'OpenRouter', shape: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
    ollama:    { label: 'Ollama (locale, senza chiave)', shape: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    custom:    { label: 'Personalizzato (OpenAI-compatible)', shape: 'openai', baseUrl: '', model: '' },
  };
  let _aiState = 'unknown'; // 'unknown' | 'ok' | 'down'

  function aiCfg() {
    const c = (data.settings && data.settings.ai) || { provider: 'artifact' };
    const preset = AI_PRESETS[c.provider] || AI_PRESETS.artifact;
    return {
      provider: c.provider || 'artifact',
      shape: preset.shape,
      baseUrl: (c.baseUrl || preset.baseUrl || '').replace(/\/+$/, ''),
      apiKey: c.apiKey || '',
      model: c.model || preset.model || '',
    };
  }

  function aiStatusLine() {
    const cfg = aiCfg();
    const label = (AI_PRESETS[cfg.provider] || {}).label || cfg.provider;
    const model = cfg.model || 'auto';
    const configured = cfg.provider !== 'artifact' || cfg.apiKey;
    const d = el('div', 'muted small ai-status');
    d.innerHTML = `AI: <b>${label}</b> · modello <b>${model}</b>${cfg.provider === 'artifact' ? ' <span class="muted">(da file locale serve una chiave o Ollama — configura in Impostazioni → AI / Modelli)</span>' : ''}`;
    return d;
  }

  async function callModel(role, { system, messages, tools }) {
    const cfg = aiCfg();
    const model = cfg.model || AI_MODELS[role] || 'claude-sonnet-4-6';
    let url, headers, body, extract;
    if (cfg.shape === 'openai') {
      url = cfg.baseUrl + '/chat/completions';
      headers = { 'content-type': 'application/json' };
      if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
      body = { model, max_tokens: 1000, messages: [{ role: 'system', content: system }].concat(messages) };
      extract = (j) => ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    } else {
      url = cfg.baseUrl + '/v1/messages';
      headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
      if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;
      body = { model, max_tokens: 1000, system, messages };
      if (tools) body.tools = tools; // web_search etc. (Anthropic only)
      extract = (j) => ((j.content || []).map(b => b.text || '').join(''));
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    _aiState = 'ok';
    return extract(j);
  }
  function stripFences(s) { return String(s || '').replace(/```(?:json)?/gi, '').trim(); }
  function safeJSON(s) { try { return JSON.parse(stripFences(s)); } catch (e) { return null; } }

  let simScenario = null; // active what-if overlay (not persisted)

  function renderSimulatore(main) {
    ensureFireSim();
    const fs = data.fireSim;

    main.appendChild(el('div', 'note small disclaimer',
      '⚠ Strumento di simulazione, <b>non consulenza finanziaria</b>. Tutti i numeri sono calcolati da un motore deterministico in euro reali (potere d\'acquisto di oggi); l\'AI può solo tradurre le tue frasi in parametri e commentare i numeri prodotti dal motore, non li inventa.'));
    main.appendChild(aiStatusLine());

    // ---- AI "what if" box ----
    main.appendChild(whatIfBox(fs));

    // ---- results (baseline + optional scenario overlay) ----
    const baseRes = computeSim(fs.profile, fs.classes);
    const scenRes = simScenario ? computeSim(simScenario.profile, simScenario.classes) : null;
    main.appendChild(simResults(fs, baseRes, scenRes));

    // ---- crisis stress test ----
    main.appendChild(stressCard(fs));

    // ---- assumptions editor ----
    main.appendChild(simEditor(fs));
  }

  // Crisis stress test: compare the plan WITHOUT a crash vs WITH a one-off
  // market crash at a chosen age. Shows sequence-of-returns risk explicitly.
  function stressCard(fs) {
    if (!fs.profile.shock) fs.profile.shock = { enabled: false, atAge: fs.profile.retirementAge, severity: 0.35 };
    const sh = fs.profile.shock;
    const body = el('div');
    const ageInput = el('input'); ageInput.type = 'number'; ageInput.id = 'sk-age'; ageInput.value = sh.atAge; ageInput.style.maxWidth = '90px';
    const sevInput = el('input'); sevInput.type = 'range'; sevInput.id = 'sk-sev'; sevInput.min = '0.1'; sevInput.max = '0.6'; sevInput.step = '0.05'; sevInput.value = sh.severity;
    const sevLabel = el('b'); sevLabel.textContent = (sh.severity * 100).toFixed(0) + '%';
    const r1 = el('div', 'form-row'); r1.appendChild(el('label', '', 'Età del crollo')); r1.appendChild(ageInput);
    const r2 = el('div', 'form-row'); const l2 = el('label'); l2.append('Severità (calo azionario): '); l2.appendChild(sevLabel); r2.appendChild(l2); r2.appendChild(sevInput);
    const outDiv = el('div');
    const applyBtn = el('button', 'btn small', '');
    body.appendChild(r1); body.appendChild(r2); body.appendChild(outDiv); body.appendChild(canvas('c-sim-stress')); body.appendChild(applyBtn);

    function compute(drawChart) {
      const atAge = parseFloat(ageInput.value) || fs.profile.retirementAge;
      const severity = parseFloat(sevInput.value) || 0.35;
      sevLabel.textContent = (severity * 100).toFixed(0) + '%';
      const no = computeSim(Object.assign({}, fs.profile, { shock: { enabled: false } }), fs.classes);
      const cr = computeSim(Object.assign({}, fs.profile, { shock: { enabled: true, atAge, severity } }), fs.classes);
      const noFinal = no.det.years[no.det.years.length - 1].total;
      const crFinal = cr.det.years[cr.det.years.length - 1].total;
      const drop = noFinal > 0 ? (1 - crFinal / noFinal) : 0;
      outDiv.innerHTML = `
        <div class="kpi"><span>Capitale a ${fs.profile.endAge} — senza crisi</span><b>${fmt(noFinal)}</b></div>
        <div class="kpi"><span>… con un crollo del ${(severity * 100).toFixed(0)}% a ${Math.round(atAge)} anni</span><b class="neg">${fmt(crFinal)} <span class="muted" style="font-weight:400">(−${(drop * 100).toFixed(0)}%)</span></b></div>
        <div class="kpi"><span>Tiene fino a ${fs.profile.endAge}?</span><b>${no.det.success ? 'sì' : 'no'} → <span class="${cr.det.success ? '' : 'neg'}">${cr.det.success ? 'sì' : 'esaurito a ' + cr.det.depletedAge}</span></b></div>
        <div class="kpi"><span>Successo Monte Carlo</span><b>${(no.mc.successProbability * 100).toFixed(0)}% → <span class="${cr.mc.successProbability < no.mc.successProbability ? 'neg' : ''}">${(cr.mc.successProbability * 100).toFixed(0)}%</span></b></div>
        <div class="muted small">Un crollo vicino al pensionamento pesa molto più di uno a metà carriera (rischio di sequenza dei rendimenti): prova a spostare l'età.</div>`;
      applyBtn.textContent = sh.enabled ? 'Togli la crisi dallo scenario principale' : 'Applica la crisi allo scenario principale';
      if (drawChart) makeChart('c-sim-stress', {
        type: 'line',
        data: {
          labels: no.det.years.map(y => y.age),
          datasets: [
            { label: 'Senza crisi', data: no.det.years.map(y => y.total), borderColor: '#95a5a6', borderDash: [5, 3], pointRadius: 0, tension: .15 },
            { label: 'Con crollo ' + (severity * 100).toFixed(0) + '% @ ' + Math.round(atAge), data: cr.det.years.map(y => y.total), borderColor: '#e74c3c', borderWidth: 2.5, pointRadius: 0, tension: .15 },
          ],
        }, options: baseLineOpts(),
      });
    }
    ageInput.onchange = () => compute(true);
    sevInput.oninput = () => { sevLabel.textContent = (parseFloat(sevInput.value) * 100).toFixed(0) + '%'; };
    sevInput.onchange = () => compute(true);
    applyBtn.onclick = () => {
      fs.profile.shock = { enabled: !sh.enabled, atAge: parseFloat(ageInput.value) || fs.profile.retirementAge, severity: parseFloat(sevInput.value) || 0.35 };
      save(); simScenario = null; render();
    };
    compute(false);                       // synchronous KPI/text (chart needs DOM)
    setTimeout(() => compute(true), 0);   // draw chart once canvas is in document
    return card('🌪️ Stress test — crisi finanziaria', body,
      'Simula un crollo di mercato una tantum a una certa età e lo confronta con lo scenario senza crisi. Il colpo è proporzionale alla volatilità di ogni classe (le azioni cadono più della liquidità), poi il recupero avviene con la normale crescita composta. "Applica" rende la crisi parte dello scenario principale (grafici e Monte Carlo qui sopra).');
  }

  function computeSim(profile, classes) {
    const det = E.simulateFireDeterministic(profile, classes);
    const coast = E.coastFireAge(profile, classes);
    const mc = E.monteCarloFire(profile, classes, 1000, 20260101);
    return { det, coast, mc, totals: E.fireClassTotals(classes) };
  }

  function whatIfBox(fs) {
    const c = el('div', 'card');
    c.appendChild(el('div', 'card-head', '<h3 class="card-title">🤖 "E se…" — scenario in linguaggio naturale</h3>'));
    const ta = el('textarea', 'whatif-input'); ta.placeholder = 'Es: "vado in pensione a 53", "azioni al 4% reale", "+500/mese di contributi", "crollo del 35% quando vado in pensione"';
    ta.rows = 2;
    const btn = el('button', 'btn primary', 'Simula');
    const status = el('div', 'muted small'); status.style.marginTop = '6px';
    const out = el('div', 'whatif-out');
    c.appendChild(ta);
    const bar = el('div', 'row'); bar.appendChild(btn);
    const clearBtn = el('button', 'btn small', 'Azzera scenario'); clearBtn.onclick = () => { simScenario = null; render(); };
    if (simScenario) bar.appendChild(clearBtn);
    c.appendChild(bar); c.appendChild(status); c.appendChild(out);
    // re-show the active scenario's summary after a re-render
    if (simScenario && simScenario.intent) {
      out.innerHTML = `<div class="note"><b>Scenario:</b> ${escapeHtml(simScenario.intent)}<br><span class="muted small">Assunzioni modificate: ${(simScenario.touched || []).map(escapeHtml).join(', ') || '—'}</span></div>
        <div class="muted small">${simScenario.narration || ''}</div>`;
    }

    btn.onclick = async () => {
      const text = ta.value.trim(); if (!text) return;
      status.textContent = 'Interpreto la richiesta…'; btn.disabled = true;
      let paramChanges = null, intent = text, touched = [];
      try {
        const sys = 'Converti una richiesta "what if" in modifiche di parametri per un simulatore FIRE. Rispondi SOLO con JSON, nessun testo, nessun fence. Schema: {"intent":string,"paramChanges":{...},"assumptionsTouched":[string],"explanationRequest":string}. Parametri ammessi in paramChanges: retirementAge, statePensionAge, endAge, annualContribution (€/anno), annualSpend (€/anno), statePensionAnnual (€/anno), classReturns (oggetto {classId: realReturn decimale}), shock (oggetto {enabled:true, atAge:int, severity:decimale 0-0.6} per simulare un crollo/crisi finanziaria a una certa età). classId disponibili: ' + fs.classes.map(c => c.id).join(', ') + '. NON calcolare risultati.';
        const usr = 'Profilo attuale: ' + JSON.stringify(fs.profile) + '\nClassi: ' + JSON.stringify(fs.classes.map(c => ({ id: c.id, realReturn: c.realReturn }))) + '\nRichiesta: ' + text;
        const raw = await callModel('parse', { system: sys, messages: [{ role: 'user', content: usr }] });
        const j = safeJSON(raw);
        if (j && j.paramChanges) { paramChanges = j.paramChanges; intent = j.intent || text; touched = j.assumptionsTouched || Object.keys(j.paramChanges); }
        else throw new Error('parse');
      } catch (e) {
        _aiState = 'down';
        status.innerHTML = '<span class="neg">AI non disponibile in locale</span> (l\'endpoint Anthropic richiede l\'ambiente Artifacts o un proxy). Modifica i parametri manualmente nella sezione "Ipotesi" qui sotto.';
        btn.disabled = false; return;
      }
      // apply paramChanges to a COPY (deterministic), rerun, narrate engine numbers
      const scen = applyParamChanges(fs, paramChanges);
      const res = computeSim(scen.profile, scen.classes);
      scen.intent = intent; scen.touched = touched; scen.narration = deterministicNarration(res);
      simScenario = scen;
      status.textContent = '';
      btn.disabled = false;
      render(); // redraw with overlay; whatIfBox re-shows the stored summary
    };
    return c;
  }

  function applyParamChanges(fs, pc) {
    const profile = Object.assign({}, fs.profile);
    const classes = fs.classes.map(c => Object.assign({}, c));
    ['retirementAge', 'statePensionAge', 'endAge', 'annualContribution', 'annualSpend', 'statePensionAnnual'].forEach(k => {
      if (pc[k] != null && isFinite(pc[k])) profile[k] = Number(pc[k]);
    });
    if (pc.classReturns && typeof pc.classReturns === 'object') {
      classes.forEach(c => { if (pc.classReturns[c.id] != null && isFinite(pc.classReturns[c.id])) c.realReturn = Number(pc.classReturns[c.id]); });
    }
    if (pc.shock && typeof pc.shock === 'object') {
      profile.shock = {
        enabled: pc.shock.enabled !== false,
        atAge: pc.shock.atAge != null ? Number(pc.shock.atAge) : profile.retirementAge,
        severity: pc.shock.severity != null ? Number(pc.shock.severity) : 0.35,
      };
    }
    return { profile, classes, changed: pc };
  }

  function deterministicNarration(res) {
    const d = res.det;
    const atRetire = d.years.find(y => y.phase === 'decum');
    const survives = d.depletedAge == null;
    return `Al pensionamento il capitale liquido è ${fmt(atRetire ? atRetire.liquidTotal : null)}. ` +
      (survives ? `Il piano regge fino a ${res.det.years[res.det.years.length - 1].age} anni (nessun esaurimento). ` : `Il capitale liquido si esaurisce a ${d.depletedAge} anni. `) +
      `Probabilità di successo Monte Carlo: ${(res.mc.successProbability * 100).toFixed(0)}%. ` +
      (res.coast != null ? `Coast-FIRE: potresti smettere di versare a ${res.coast} anni.` : `Coast-FIRE non raggiunto con queste ipotesi.`);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function simResults(fs, base, scen) {
    const wrap = el('div', 'grid');
    // KPI card
    const kpiBody = el('div');
    const r = scen || base;
    kpiBody.innerHTML = `
      <div class="kpi"><span>Capitale oggi</span><b>${fmt(r.totals.total)}</b></div>
      <div class="kpi"><span>Esito piano</span><b class="${r.det.success ? 'pos' : 'neg'}">${r.det.success ? 'Regge fino a ' + fs.profile.endAge : 'Esaurito a ' + r.det.depletedAge + ' anni'}</b></div>
      <div class="kpi"><span>Coast-FIRE</span><b>${r.coast != null ? r.coast + ' anni' : '—'}</b></div>
      <div class="kpi"><span>Successo Monte Carlo (1.000 run)</span><b>${(r.mc.successProbability * 100).toFixed(0)}%</b></div>
      ${scen ? '<div class="note small">Stai vedendo lo <b>scenario</b> (linea piena) confrontato con la baseline (tratteggio).</div>' : ''}`;
    wrap.appendChild(card(scen ? 'Risultati — scenario vs baseline' : 'Risultati', kpiBody, 'I numeri vengono dal motore deterministico in euro reali. La barra Monte Carlo simula 1.000 sequenze di rendimenti casuali per classe e conta in quante il capitale non si esaurisce prima di ' + fs.profile.endAge + ' anni.'));

    wrap.appendChild(card('Patrimonio nel tempo (accumulo → decumulo)', canvas('c-sim-net'), 'Capitale totale anno per anno: cresce coi contributi fino al pensionamento, poi cala con i prelievi. Il segnale verticale è il pensionamento.'));
    wrap.appendChild(card('Il gap ' + fs.profile.retirementAge + '→' + fs.profile.statePensionAge, canvas('c-sim-gap'), 'Nella fase di decumulo: quanto prelevi dal portafoglio (rosso) e quanta pensione statale arriva (verde) dall\'età della pensione. Nel "gap" prima della pensione vivi solo di portafoglio.'));
    wrap.appendChild(card('Monte Carlo (ventaglio P10–P50–P90)', canvas('c-sim-mc'), 'Scenari da sfortunato (P10) a fortunato (P90). Se la banda bassa resta sopra zero a 90 anni, il piano è robusto.'));

    // show-the-numbers
    const tblWrap = el('div');
    const toggle = el('button', 'btn small', 'Mostra i numeri');
    const tbl = el('div'); tbl.style.display = 'none';
    toggle.onclick = () => { tbl.style.display = tbl.style.display === 'none' ? 'block' : 'none'; toggle.textContent = tbl.style.display === 'none' ? 'Mostra i numeri' : 'Nascondi i numeri'; };
    tbl.appendChild(numbersTable(r.det));
    tblWrap.appendChild(toggle); tblWrap.appendChild(tbl);
    wrap.appendChild(card('Tabella anno per anno', tblWrap, 'Ogni cifra dei grafici è verificabile qui: età, fase, contributo, prelievo, pensione, capitale liquido e totale.'));

    setTimeout(() => drawSimCharts(fs, base, scen), 0);
    return wrap;
  }

  function numbersTable(det) {
    const t = el('table', 'data-table');
    t.innerHTML = '<thead><tr><th>Età</th><th>Fase</th><th>Contributo</th><th>Prelievo</th><th>Pensione</th><th>Liquido</th><th>Totale</th></tr></thead>';
    const tb = el('tbody');
    det.years.forEach(y => {
      const tr = el('tr');
      tr.innerHTML = `<td>${y.age}</td><td>${y.phase === 'accum' ? 'accumulo' : 'decumulo'}</td><td>${y.contribution ? fmt(y.contribution) : '—'}</td><td>${y.withdrawal ? fmt(y.withdrawal) : '—'}</td><td>${y.pensionIncome ? fmt(y.pensionIncome) : '—'}</td><td>${fmt(y.liquidTotal)}</td><td>${fmt(y.total)}</td>`;
      if (y.shortfall > 0) tr.classList.add('shortfall-row');
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    return t;
  }

  function drawSimCharts(fs, base, scen) {
    const ages = base.det.years.map(y => y.age);
    const retAge = fs.profile.retirementAge;
    // net worth
    const ds = [{ label: scen ? 'Baseline' : 'Patrimonio', data: base.det.years.map(y => y.total), borderColor: '#95a5a6', borderDash: scen ? [5, 3] : [], pointRadius: 0, tension: .15 }];
    if (scen) ds.unshift({ label: 'Scenario', data: scen.det.years.map(y => y.total), borderColor: '#3498db', borderWidth: 2.5, pointRadius: 0, tension: .15 });
    makeChart('c-sim-net', { type: 'line', data: { labels: ages, datasets: ds }, options: baseLineOpts() });
    // gap (withdrawal vs pension income), scenario if present else base
    const g = (scen || base).det.years;
    makeChart('c-sim-gap', {
      type: 'bar',
      data: {
        labels: g.map(y => y.age),
        datasets: [
          { label: 'Prelievo dal portafoglio', data: g.map(y => y.withdrawal), backgroundColor: 'rgba(231,76,60,.7)' },
          { label: 'Pensione statale', data: g.map(y => y.pensionIncome), backgroundColor: 'rgba(46,204,113,.7)' },
        ],
      }, options: Object.assign(baseLineOpts(), { scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: v => fmt(v) } } } }),
    });
    // monte carlo fan
    const mc = (scen || base).mc;
    makeChart('c-sim-mc', {
      type: 'line',
      data: {
        labels: mc.bands.map(b => b.age),
        datasets: [
          { label: 'P90', data: mc.bands.map(b => b.p90), borderColor: '#27ae60', pointRadius: 0, fill: false, tension: .15 },
          { label: 'P50 (mediana)', data: mc.bands.map(b => b.p50), borderColor: '#3498db', pointRadius: 0, fill: false, tension: .15 },
          { label: 'P10', data: mc.bands.map(b => b.p10), borderColor: '#e74c3c', pointRadius: 0, fill: false, tension: .15 },
        ],
      }, options: baseLineOpts(),
    });
  }

  function simEditor(fs) {
    const body = el('div');
    const p = fs.profile;
    const fields = [
      ['currentAge', 'Età attuale'], ['retirementAge', 'Età pensionamento'], ['statePensionAge', 'Età pensione statale'],
      ['endAge', 'Orizzonte (età)'], ['annualContribution', 'Contributo annuo (€)'], ['annualSpend', 'Spesa annua reale (€)'],
      ['statePensionAnnual', 'Pensione statale annua (€)'],
    ];
    const pg = el('div', 'param-grid');
    fields.forEach(([k, lab]) => {
      const row = el('div', 'form-row');
      row.innerHTML = `<label>${lab}</label><input type="number" step="any" data-pf="${k}" value="${p[k]}">`;
      pg.appendChild(row);
    });
    body.appendChild(pg);
    body.appendChild(el('h4', '', 'Classi di attività'));
    const tbl = el('table', 'data-table');
    tbl.innerHTML = '<thead><tr><th>Classe</th><th>Valore €</th><th>Rend. reale %</th><th>Volatilità %</th><th>Tipo</th></tr></thead>';
    const tb = el('tbody');
    fs.classes.forEach((c, i) => {
      const tr = el('tr');
      tr.innerHTML = `<td>${c.name}</td>
        <td><input type="number" data-cl="${i}" data-clf="value" value="${c.value}" style="width:110px"></td>
        <td><input type="number" step="0.001" data-cl="${i}" data-clf="realReturn" value="${c.realReturn}" style="width:80px"></td>
        <td><input type="number" step="0.001" data-cl="${i}" data-clf="volatility" value="${c.volatility}" style="width:80px"></td>
        <td>${c.kind === 'pension' ? 'pensione' : 'liquido'}</td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); body.appendChild(tbl);
    body.appendChild(el('div', 'muted small', 'Valori in euro reali. I rendimenti sono reali (al netto dell\'inflazione). Modifica e i grafici si aggiornano.'));

    $$('[data-pf]', body).forEach(inp => inp.onchange = () => { p[inp.dataset.pf] = parseFloat(inp.value) || 0; save(); simScenario = null; render(); });
    $$('[data-cl]', body).forEach(inp => inp.onchange = () => { fs.classes[+inp.dataset.cl][inp.dataset.clf] = parseFloat(inp.value) || 0; save(); simScenario = null; render(); });
    return card('Ipotesi (modificabili)', body, 'Tutti i parametri del motore. Cambiali a mano oppure usa la casella "E se…" in alto: l\'AI traduce la frase in queste stesse modifiche.');
  }

  /* ==================== TAB — Tax Assistant (3 agents) ================
     Multi-agent ensemble over the Anthropic endpoint, each a distinct role:
     Optimizer → Compliance/Risk Reviewer → Reconciler. Structured JSON hand-off
     (proposals carry ids; the Reviewer addresses each by id; the Reconciler
     ranks by id). The AI never does arithmetic — the deterministic facts panel
     is computed in JS and passed to the agents as context. Per-tab history is
     persisted. Degrades gracefully when the endpoint is unreachable (local file).
     ==================================================================== */
  const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
  let taxWebSearch = true;

  function ensureTaxAssist() {
    if (!data.taxAssist) data.taxAssist = { history: [] };
    if (!Array.isArray(data.taxAssist.history)) data.taxAssist.history = [];
  }

  // Deterministic tax facts (JS, never from the model) — also fed to the agents.
  function taxFacts() {
    const f = data.settings.fire;
    const today = currentMonth();
    const ruling = (data.settings.milestones || []).find(m => /30\s*%|ruling/i.test(m.label));
    const rulingDate = ruling ? ruling.date : '2027-05';
    const yr = today.slice(0, 4);
    let lijf = 0;
    E.monthSeries(data).filter(m => m.slice(0, 4) === yr).forEach(m => {
      const e = E.getEntry(data, m);
      (e && e.contributions || []).forEach(c => { const a = E.accountById(data, c.accountId); if (a && !E.isLiquid(a) && c.source === 'current') lijf += Number(c.amount) || 0; });
    });
    return {
      rulingDate, monthsToRuling: E.monthsBetween(today, rulingDate),
      box3StartDate: f.box3StartDate, box3DragAnnual: f.box3DragAnnual,
      marginalRate: f.marginalRateBox1,
      lijfThisYear: E.r2(lijf), lijfDeduction: E.r2(lijf * f.marginalRateBox1),
      pensionExpectedMonthly: f.expectedPensionMonthly,
    };
  }

  async function callAgent(role, { system, user, tools }) {
    return await callModel(role, { system, messages: [{ role: 'user', content: user }], tools });
  }

  function taxContext(facts, question) {
    return [
      'PROFILO FISCALE (expat NL, cittadino IT). Fatti DETERMINISTICI (non ricalcolarli):',
      `- 30% ruling: scadenza ${facts.rulingDate} (${facts.monthsToRuling} mesi). Valutare cosa cambia dopo.`,
      `- Box 3 (tassazione patrimonio): drag ~${(facts.box3DragAnnual * 100).toFixed(2)}%/anno da ${facts.box3StartDate}. Sistema in evoluzione legale: SENSIBILE ALLA DATA.`,
      `- Regime parziale non residente (Art. 2.6): SENSIBILE ALLA DATA — abrogato per il futuro con regole transitorie; verificare, non assumere.`,
      `- Lijfrente (Meesman): deferral Box 1 + spazio deducibile. Contributi personali quest'anno: ${E.fmtEUR(facts.lijfThisYear)} → deduzione stimata ${E.fmtEUR(facts.lijfDeduction)} (aliquota ${(facts.marginalRate * 100).toFixed(0)}%).`,
      `- Pensione privata IT: interazione cross-border con NL.`,
      `Aliquota marginale Box 1 assunta: ${(facts.marginalRate * 100).toFixed(0)}%.`,
      `DOMANDA UTENTE: ${question}`,
    ].join('\n');
  }

  const OPT_SYS = 'Sei l\'OPTIMIZER di un ensemble fiscale per un expat NL/cittadino IT. Proponi mosse concrete di ottimizzazione fiscale calibrate sul profilo. NON dare consulenza definitiva e NON fare affermazioni categoriche sulla legge vigente. Rispondi SOLO con JSON valido (niente prosa, niente ```): {"proposals":[{"id":"p1","title":"...","rationale":"...","assumptions":["..."],"recencySensitive":true|false}]}. Massimo 5 proposte.';
  const REV_SYS = 'Sei il COMPLIANCE/RISK REVIEWER. Per OGNI proposta (riferendoti al suo id) valuta: legalità, solidità delle assunzioni, dipendenza dalla legge olandese vigente, ed elementi SENSIBILI ALLA DATA (30% ruling, Art. 2.6, Box 3). Se disponibile, usa web_search per regole attuali. Rispondi SOLO JSON: {"reviews":[{"id":"p1","verdict":"ok|cautela|rischioso","risks":["..."],"recencyFlags":["..."],"confidence":0.0}]}.';
  const REC_SYS = 'Sei il RECONCILER. Sintetizza proposte e revisioni in una raccomandazione bilanciata e ORDINATA per priorità, con confidenza per azione. Mostra l\'equilibrio, non una sola risposta sicura. Rispondi SOLO JSON: {"ranked":[{"id":"p1","action":"...","confidence":0.0,"why":"..."}],"verify":["verifica con il Belastingdienst ...","consulta un commercialista/adviser ..."]}. La lista "verify" è obbligatoria.';

  async function askTax(question) {
    ensureTaxAssist();
    const facts = taxFacts();
    const turn = { q: question, ts: Date.now(), status: 'running', proposals: null, reviews: null, reconciliation: null };
    data.taxAssist.history.unshift(turn); save(); render();
    try {
      const ctx = taxContext(facts, question);
      const optRaw = await callAgent('optimizer', { system: OPT_SYS, user: ctx });
      const opt = safeJSON(optRaw); turn.proposals = (opt && opt.proposals) || [];
      const revRaw = await callAgent('reviewer', { system: REV_SYS, user: ctx + '\n\nPROPOSTE DA RIVEDERE:\n' + JSON.stringify(turn.proposals), tools: taxWebSearch ? [WEB_SEARCH_TOOL] : null });
      const rev = safeJSON(revRaw); turn.reviews = (rev && rev.reviews) || [];
      const recRaw = await callAgent('reconciler', { system: REC_SYS, user: ctx + '\n\nPROPOSTE:\n' + JSON.stringify(turn.proposals) + '\n\nREVISIONI:\n' + JSON.stringify(turn.reviews) });
      const rec = safeJSON(recRaw); turn.reconciliation = rec || null;
      turn.status = 'done';
    } catch (e) {
      turn.status = 'error';
      turn.error = 'AI non disponibile in locale: l\'endpoint Anthropic non è raggiungibile da un file aperto nel browser. Le tre fasi (Optimizer → Reviewer → Reconciler) vengono eseguite dove l\'endpoint è attivo (es. Claude Artifacts).';
    }
    save(); render();
  }

  function renderTasse(main) {
    ensureTaxAssist();
    const facts = taxFacts();

    main.appendChild(el('div', 'note small disclaimer',
      '⚠ <b>Non è consulenza fiscale.</b> Gli agenti non fanno affermazioni categoriche sulla legge vigente e segnalano gli elementi sensibili alla data. La raccomandazione finale termina sempre con una lista di verifiche da fare con un professionista / il Belastingdienst. I numeri mostrati sono calcolati in JS, non dall\'AI.'));
    main.appendChild(aiStatusLine());

    // deterministic facts panel
    const fb = el('div');
    fb.innerHTML = `
      <div class="kpi"><span>30% ruling — scadenza</span><b>${facts.rulingDate} <span class="muted" style="font-weight:400">(${facts.monthsToRuling} mesi)</span></b></div>
      <div class="kpi"><span>Box 3 — drag da</span><b>${facts.box3StartDate} · ~${(facts.box3DragAnnual * 100).toFixed(2)}%/anno</b></div>
      <div class="kpi"><span>Lijfrente personale ${currentMonth().slice(0, 4)}</span><b>${fmt(facts.lijfThisYear)}</b></div>
      <div class="kpi"><span>Deduzione Box 1 stimata</span><b>${fmt(facts.lijfDeduction)} <span class="muted" style="font-weight:400">(@ ${(facts.marginalRate * 100).toFixed(0)}%)</span></b></div>
      <div class="muted small">Elementi sensibili alla data: 30% ruling, regime Art. 2.6 (parziale non residente), Box 3 — verificare le regole attuali.</div>`;
    main.appendChild(card('Contesto fiscale (deterministico)', fb, 'Questi valori sono calcolati dall\'app dai tuoi dati/impostazioni e passati agli agenti come contesto. L\'AI non li ricalcola.'));

    // chat input
    const chat = el('div', 'card');
    chat.appendChild(el('div', 'card-head', '<h3 class="card-title">Chiedi ai 3 agenti</h3>'));
    const ta = el('textarea', 'whatif-input'); ta.rows = 2;
    ta.placeholder = 'Es: "Conviene aumentare i contributi lijfrente prima della scadenza del 30% ruling?" · "Cosa cambia per il Box 3 dopo il 2027?"';
    chat.appendChild(ta);
    const bar = el('div', 'row');
    const ask = el('button', 'btn primary', 'Analizza (Optimizer → Reviewer → Reconciler)');
    ask.onclick = () => { const q = ta.value.trim(); if (q) askTax(q); };
    const ws = el('label', 'toggle small', `<input type="checkbox" id="tax-ws" ${taxWebSearch ? 'checked' : ''}> web_search sul Reviewer`);
    bar.appendChild(ask); bar.appendChild(ws);
    chat.appendChild(bar);
    main.appendChild(chat);
    const wsCb = $('#tax-ws', chat); if (wsCb) wsCb.onchange = () => { taxWebSearch = wsCb.checked; };

    // history (newest first)
    (data.taxAssist.history || []).forEach(turn => main.appendChild(renderTaxTurn(turn)));
  }

  function renderTaxTurn(turn) {
    const c = el('div', 'card tax-turn');
    c.appendChild(el('div', 'tax-q', '🗨️ ' + escapeHtml(turn.q)));
    if (turn.status === 'running') { c.appendChild(el('div', 'muted small', 'Gli agenti stanno lavorando…')); return c; }
    if (turn.status === 'error') { c.appendChild(el('div', 'note neg', turn.error)); }

    // Layer 1 — Optimizer
    c.appendChild(agentLayer('1 · Optimizer', 'proposte', (turn.proposals || []).length
      ? (turn.proposals || []).map(p => `<div class="proposal"><b>${escapeHtml(p.title || p.id)}</b> ${p.recencySensitive ? '<span class="badge warn-badge">sensibile alla data</span>' : ''}<div class="muted small">${escapeHtml(p.rationale || '')}</div>${(p.assumptions || []).length ? `<div class="muted small">Assunzioni: ${(p.assumptions || []).map(escapeHtml).join('; ')}</div>` : ''}<div class="muted small">id: ${escapeHtml(p.id || '')}</div></div>`).join('')
      : '<span class="muted small">—</span>'));

    // Layer 2 — Reviewer (addresses each proposal by id)
    c.appendChild(agentLayer('2 · Compliance / Risk Reviewer', 'revisione', (turn.reviews || []).length
      ? (turn.reviews || []).map(r => {
        const cls = r.verdict === 'rischioso' ? 'neg' : r.verdict === 'ok' ? 'pos' : '';
        return `<div class="proposal"><b>${escapeHtml(r.id || '')}</b> <span class="${cls}">${escapeHtml(r.verdict || '')}</span>${r.confidence != null ? ` <span class="muted small">conf. ${(Number(r.confidence) * 100).toFixed(0)}%</span>` : ''}${(r.risks || []).length ? `<div class="muted small">Rischi: ${(r.risks || []).map(escapeHtml).join('; ')}</div>` : ''}${(r.recencyFlags || []).length ? `<div class="warn small">⚠ Recency: ${(r.recencyFlags || []).map(escapeHtml).join('; ')}</div>` : ''}</div>`;
      }).join('')
      : '<span class="muted small">—</span>'));

    // Layer 3 — Reconciler (ranked + verify list)
    const rec = turn.reconciliation;
    c.appendChild(agentLayer('3 · Reconciler', 'raccomandazione', rec
      ? `${(rec.ranked || []).map((a, i) => `<div class="proposal"><b>${i + 1}. ${escapeHtml(a.action || a.id || '')}</b>${a.confidence != null ? ` <span class="muted small">conf. ${(Number(a.confidence) * 100).toFixed(0)}%</span>` : ''}<div class="muted small">${escapeHtml(a.why || '')}</div></div>`).join('')}
         <div class="note verify-list"><b>Verifica con un professionista:</b><ul>${(rec.verify || ['Verifica gli elementi sensibili alla data con il Belastingdienst o un commercialista.']).map(v => `<li>${escapeHtml(v)}</li>`).join('')}</ul></div>`
      : '<span class="muted small">—</span>'));
    return c;
  }

  function agentLayer(title, kind, innerHtml) {
    const d = el('div', 'agent-layer');
    d.innerHTML = `<div class="agent-head">${title}</div><div class="agent-body">${innerHtml}</div>`;
    return d;
  }

  /* =========================== Entry form ============================ */
  function openEntryForm(ym) {
    const existing = E.getEntry(data, ym);
    const entry = existing ? JSON.parse(JSON.stringify(existing)) : {
      yearMonth: ym, salaryNet: 0, extraSalary: 0, otherIncome: 0,
      paydayDayOfMonth: data.settings.defaultPaydayDayOfMonth,
      contributions: [], internalTransfers: [], flags: [],
    };
    // Prefill: for a brand-new month, carry forward each account's last balance
    // (editable). Existing months keep their saved values untouched.
    const prevYM = E.ymPrev(ym);
    const isNewMonth = !existing && !E.monthSeries(data).includes(ym);
    const draftSnaps = {};
    (data.accounts || []).forEach(a => {
      const s = E.getSnapshot(data, a.id, ym);
      if (s) { draftSnaps[a.id] = Object.assign({}, s); return; }
      const prev = isNewMonth ? E.getSnapshot(data, a.id, prevYM) : null;
      draftSnaps[a.id] = {
        accountId: a.id, yearMonth: ym,
        balancePayday: prev && prev.balancePayday != null ? prev.balancePayday : null,
        balancePaydayMinus1: null,
      };
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
            <div class="form-row"><label>Stipendio netto</label><input type="number" id="ef-salary" value="${entry.salaryNet || 0}"><button class="suggest" id="ef-salary-suggest" title="Saldo payday − saldo giorno−1 dei conti correnti"></button></div>
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
          <section><h3>4. Contributi</h3><div id="ef-ghosts"></div><div id="ef-contribs"></div>
            <button class="btn small" id="ef-add-contrib">+ Aggiungi contributo</button></section>
          <section><h3>5. Trasferimenti interni</h3><div id="ef-transfers"></div>
            <button class="btn small" id="ef-add-transfer">+ Aggiungi trasferimento</button></section>
        </div>
        <div class="modal-foot" id="ef-summary"></div>
        <div class="modal-actions"><button class="btn" id="ef-cancel">Annulla</button><button class="btn primary" id="ef-save">Salva</button></div>`;

      renderContribs(); renderTransfers(); renderGhosts(); refreshSalarySuggest(); updateSummary();
      $('#ef-close').onclick = close; $('#ef-cancel').onclick = close;
      $('#ef-salary-suggest').onclick = () => {
        const v = suggestedSalary();
        if (v != null) { entry.salaryNet = v; $('#ef-salary').value = v; updateSummary(); }
      };
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
      refreshSalarySuggest();
      updateSummary();
    }
    // salaryNet ≈ Σ(payday) − Σ(day−1) across current accounts this month.
    function suggestedSalary() {
      let payday = 0, minus1 = 0, ok = false;
      curAccs.forEach(a => {
        const d = draftSnaps[a.id];
        if (d.balancePayday != null && d.balancePaydayMinus1 != null) { payday += d.balancePayday; minus1 += d.balancePaydayMinus1; ok = true; }
      });
      return ok ? Math.round(payday - minus1) : null;
    }
    function refreshSalarySuggest() {
      const btn = $('#ef-salary-suggest'); if (!btn) return;
      const v = suggestedSalary();
      btn.textContent = v == null ? '' : `usa ${fmt(v)}`;
      btn.style.display = v == null || v === (+($('#ef-salary').value) || 0) ? 'none' : '';
    }
    function renderGhosts() {
      const box = $('#ef-ghosts'); if (!box) return;
      const prev = E.getEntry(data, prevYM);
      const recurring = (prev && prev.contributions || []).filter(c => c.kind === 'recurring');
      if (!recurring.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<div class="ghost">Ricorrenti del mese scorso: ${recurring.map((c, i) => {
        const a = E.accountById(data, c.accountId);
        return `${a ? a.name : '?'} ${fmt(c.amount)}<button class="link" data-ghost="${i}">copia</button>`;
      }).join(' · ')}<button class="link" data-ghost-all>copia tutti</button></div>`;
      const copy = (c) => { entry.contributions.push({ id: uuid(), accountId: c.accountId, amount: c.amount, kind: 'recurring', source: c.source || 'current' }); };
      box.querySelectorAll('[data-ghost]').forEach(b => b.onclick = () => { copy(recurring[+b.dataset.ghost]); renderContribs(); updateSummary(); });
      const all = box.querySelector('[data-ghost-all]');
      if (all) all.onclick = () => { recurring.forEach(copy); renderContribs(); updateSummary(); };
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
  window.FD = { get data() { return data; }, load, save, render, seedDemo, go, openEntry: openEntryForm, callModel, aiCfg };
})();
