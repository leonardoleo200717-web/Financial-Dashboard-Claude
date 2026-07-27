/* =========================================================================
   Financial Dashboard — Calculation Engine (schema v2)
   -------------------------------------------------------------------------
   Pure, DOM-free, side-effect-free. Implements the derived metrics defined
   in CLAUDE.md §2 (net worth, estimated expenses, invested amount, savings
   rate, market growth) and the FIRE math of §3.

   This file is inlined verbatim into index.html (single-file deliverable)
   AND consumed directly by the Node test harness in tests/. Keep it free of
   any browser/Chart.js/DOM references.
   ========================================================================= */
(function (root, factory) {
  const Engine = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  root.Engine = Engine;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ----------------------------- helpers ------------------------------- */

  const MONTHS_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
    'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

  const eurFmt = (typeof Intl !== 'undefined')
    ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' })
    : null;

  function fmtEUR(n) {
    if (n == null || isNaN(n)) return '—';
    if (eurFmt) return eurFmt.format(n);
    return '€ ' + Number(n).toFixed(2);
  }

  function fmtPct(n, digits) {
    if (n == null || isNaN(n)) return '—';
    return (n * 100).toFixed(digits == null ? 1 : digits).replace('.', ',') + '%';
  }

  // round to cents to avoid floating point noise in comparisons/flags
  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  /* ---------------------------- ym utilities --------------------------- */

  function ymParts(ym) {
    const [y, m] = ym.split('-').map(Number);
    return { y, m };
  }
  function ymPrev(ym) {
    let { y, m } = ymParts(ym);
    m -= 1; if (m === 0) { m = 12; y -= 1; }
    return y + '-' + String(m).padStart(2, '0');
  }
  function ymNext(ym) {
    let { y, m } = ymParts(ym);
    m += 1; if (m === 13) { m = 1; y += 1; }
    return y + '-' + String(m).padStart(2, '0');
  }
  function ymCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function monthsBetween(a, b) {
    const pa = ymParts(a), pb = ymParts(b);
    return (pb.y - pa.y) * 12 + (pb.m - pa.m);
  }
  function monthLabelIT(ym) {
    const { y, m } = ymParts(ym);
    return MONTHS_IT[m - 1] + ' ' + y;
  }
  // fractional age at the payday of a given month
  function ageAt(birthDate, ym) {
    if (!birthDate) return null;
    const [by, bm] = birthDate.split('-').map(Number);
    const { y, m } = ymParts(ym);
    return (y - by) + (m - bm) / 12;
  }

  /* --------------------------- data accessors -------------------------- */

  function accountById(data, id) {
    return (data.accounts || []).find(a => a.id === id) || null;
  }
  function snapKey(accId, ym) { return accId + '|' + ym; }
  function getSnapshot(data, accId, ym) {
    return (data.snapshots && data.snapshots[snapKey(accId, ym)]) || null;
  }
  function getEntry(data, ym) {
    return (data.entries && data.entries[ym]) || null;
  }
  function isLiquid(acc) {
    if (acc.liquidity) return acc.liquidity === 'liquid';
    return acc.type !== 'pension';
  }

  // Accounts considered "active" for entry/current-state at a given month:
  // created on/before ym and (not archived OR archived in a later month).
  function accountsActiveAt(data, ym) {
    return (data.accounts || []).filter(a => {
      if (a.createdAt && ymCompare(a.createdAt, ym) > 0) return false;
      if (a.archivedAt && ymCompare(a.archivedAt, ym) < 0) return false;
      return true;
    });
  }
  function currentAccounts(data) {
    return (data.accounts || []).filter(a => a.type === 'current');
  }

  // All months that have either a snapshot or an entry, ascending.
  function monthSeries(data) {
    const set = new Set();
    Object.values(data.snapshots || {}).forEach(s => set.add(s.yearMonth));
    Object.keys(data.entries || {}).forEach(ym => set.add(ym));
    return Array.from(set).sort(ymCompare);
  }

  /* --------------------------- §2.1 net worth -------------------------- */

  // Sum balancePayday over accounts matching a predicate that have a snapshot
  // for the month. Archived accounts naturally drop out once snapshots stop.
  function sumBalances(data, ym, pred) {
    let sum = 0, any = false;
    for (const acc of data.accounts || []) {
      if (!pred(acc)) continue;
      const s = getSnapshot(data, acc.id, ym);
      if (!s || s.balancePayday == null) {
        // pots without statements (e.g. PME): estimated from contributions
        if (acc.estimateFromContributions) {
          const est = estimatedPensionBalance(data, acc, ym);
          if (est != null) { sum += est; any = true; }
        }
        continue;
      }
      sum += s.balancePayday; any = true;
    }
    return any ? r2(sum) : null;
  }
  function liquidNetWorth(data, ym) {
    return sumBalances(data, ym, isLiquid);
  }
  // Whether an account counts toward FIRE capital (the compounding investment
  // base used for projections/Coast/Monte Carlo). Cash buffers (current) and
  // savings sit idle and should NOT be projected at market returns, so the
  // default is broker-only. A per-account `includeInFire` boolean overrides.
  function defaultIncludeInFire(acc) {
    return acc.type === 'broker';
  }
  function includesInFire(acc) {
    if (!isLiquid(acc)) return false; // pensions are the separate post-67 pillar
    return acc.includeInFire == null ? defaultIncludeInFire(acc) : !!acc.includeInFire;
  }
  // Investable capital used for all FIRE math (≠ liquid net worth, which also
  // includes idle cash/savings).
  function fireCapital(data, ym) {
    return sumBalances(data, ym, includesInFire);
  }
  function lockedNetWorth(data, ym) {
    return sumBalances(data, ym, a => !isLiquid(a));
  }
  function totalNetWorth(data, ym) {
    const l = liquidNetWorth(data, ym);
    const k = lockedNetWorth(data, ym);
    if (l == null && k == null) return null;
    return r2((l || 0) + (k || 0));
  }

  /* --------------- current-account snapshot aggregation ---------------- */

  // field: 'balancePayday' | 'balancePaydayMinus1'
  function sumCurrent(data, ym, field) {
    let sum = 0, missing = false, any = false;
    for (const acc of currentAccounts(data)) {
      // only count current accounts that are active that month
      if (acc.createdAt && ymCompare(acc.createdAt, ym) > 0) continue;
      if (acc.archivedAt && ymCompare(acc.archivedAt, ym) < 0) continue;
      const s = getSnapshot(data, acc.id, ym);
      if (!s || s[field] == null) { missing = true; continue; }
      sum += s[field]; any = true;
    }
    return { sum: r2(sum), missing, any };
  }

  /* --------------- contribution / transfer aggregation ----------------- */

  // Returns split of contributions in an entry.
  function contributionSplit(entry) {
    let depositsFromCurrent = 0;   // source=current, amount>0  (cash leaving CC)
    let withdrawalsToCurrent = 0;  // source=current, amount<0  (cash back to CC), abs
    let externalNet = 0;           // source=external, signed
    (entry && entry.contributions || []).forEach(c => {
      const amt = Number(c.amount) || 0;
      if (c.source === 'external') { externalNet += amt; return; }
      if (amt >= 0) depositsFromCurrent += amt;
      else withdrawalsToCurrent += -amt;
    });
    return {
      depositsFromCurrent: r2(depositsFromCurrent),
      withdrawalsToCurrent: r2(withdrawalsToCurrent),
      externalNet: r2(externalNet),
      // Σ contributions with source=current (signed) — used for reconciliation
      currentNet: r2(depositsFromCurrent - withdrawalsToCurrent),
    };
  }

  // Net transfers in/out of the set of CURRENT accounts for an entry.
  function transferCurrentSplit(data, entry) {
    const curIds = new Set(currentAccounts(data).map(a => a.id));
    let out = 0, into = 0;
    (entry && entry.internalTransfers || []).forEach(t => {
      const amt = Number(t.amount) || 0;
      const fromCur = curIds.has(t.fromAccountId);
      const toCur = curIds.has(t.toAccountId);
      if (fromCur) out += amt;
      if (toCur) into += amt;
    });
    // a current→current transfer adds to both and nets to zero — correct.
    return { out: r2(out), into: r2(into), net: r2(out - into) };
  }

  // Net contributions hitting a single account's balance (all sources, signed).
  function contributionsForAccount(entry, accId) {
    let s = 0;
    (entry && entry.contributions || []).forEach(c => {
      if (c.accountId === accId) s += Number(c.amount) || 0;
    });
    return r2(s);
  }
  // Net transfers into a single account (in − out).
  function transfersForAccount(entry, accId) {
    let s = 0;
    (entry && entry.internalTransfers || []).forEach(t => {
      const amt = Number(t.amount) || 0;
      if (t.toAccountId === accId) s += amt;
      if (t.fromAccountId === accId) s -= amt;
    });
    return r2(s);
  }

  /* --------------------- §2.2 estimated expenses ----------------------- */

  /*
    expenses(m) = balancePayday_current(m-1)              // cash at cycle start
                + otherIncome(m)
                + Σ withdrawals back to current (abs)
                − Σ contributions(source=current) deposits
                − (transfers out of current − transfers into current)
                − balancePaydayMinus1_current(m)          // cash left at cycle end
  */
  function estimatedExpenses(data, ym) {
    const flags = [];
    const prev = ymPrev(ym);
    const entry = getEntry(data, ym);

    // Bank-statement truth beats the residual estimate: when the import set
    // entry.expensesActual, use it (flag ACTUAL is informational, not a warning).
    if (entry && entry.expensesActual != null && isFinite(entry.expensesActual)) {
      return { value: r2(entry.expensesActual), flags: ['ACTUAL'] };
    }

    const start = sumCurrent(data, prev, 'balancePayday');   // cycle start cash
    const end = sumCurrent(data, ym, 'balancePaydayMinus1'); // cycle end cash

    if (!start.any || start.missing || !end.any || end.missing) {
      flags.push('MISSING_SNAPSHOT');
      return { value: null, flags };
    }

    const otherIncome = entry ? (Number(entry.otherIncome) || 0) : 0;
    const cs = contributionSplit(entry);
    const ts = transferCurrentSplit(data, entry);

    const value = r2(
      start.sum
      + otherIncome
      + cs.withdrawalsToCurrent
      - cs.depositsFromCurrent
      - ts.net
      - end.sum
    );

    if (value < 0) flags.push('NEGATIVE_EXPENSES');
    return { value, flags };
  }

  /* ------------- §2.3 invested amount & savings rate ------------------- */

  function totalIncome(entry) {
    if (!entry) return 0;
    return r2((Number(entry.salaryNet) || 0)
      + (Number(entry.extraSalary) || 0)
      + (Number(entry.otherIncome) || 0));
  }

  function investedAndSavings(data, ym) {
    const flags = [];
    const prev = ymPrev(ym);
    const entry = getEntry(data, ym);

    const exp = estimatedExpenses(data, ym);
    const endCur = sumCurrent(data, ym, 'balancePaydayMinus1');
    const prevCur = sumCurrent(data, prev, 'balancePaydayMinus1');

    if (exp.value == null || !endCur.any || endCur.missing || !prevCur.any || prevCur.missing) {
      exp.flags.forEach(f => flags.push(f));
      if (!flags.includes('MISSING_SNAPSHOT')) flags.push('MISSING_SNAPSHOT');
      return { invested: null, savingsRate: null, totalIncome: totalIncome(entry), deltaCash: null, expenses: exp.value, flags };
    }

    const deltaCash = r2(endCur.sum - prevCur.sum);
    const inc = totalIncome(entry);
    const invested = r2(inc - exp.value - deltaCash);
    const savingsRate = inc > 0 ? invested / inc : null;

    exp.flags.forEach(f => flags.push(f));
    return { invested, savingsRate, totalIncome: inc, deltaCash, expenses: exp.value, flags };
  }

  // §2.3 reconciliation: registered investment flows vs balance-derived
  // invested, compared like-for-like.
  //   Registered = current-sourced contributions + net internal transfers out
  //   of current accounts (funding a broker via a transfer is a registered
  //   flow, not a data-quality problem).
  //   Timing adjustment: invested(m) is balance-derived on the payday cycle,
  //   so by construction it equals registered flows PLUS the month-over-month
  //   salary delta (income lands at the cycle end). Without adjusting for that
  //   known delta the flag mostly measures salary variation — on real data it
  //   fired on 13/17 months. diff ≠ 0 now means genuinely unexplained money.
  function reconcile(data, ym) {
    const is = investedAndSavings(data, ym);
    if (is.invested == null) return { mismatch: false, diff: null, contributions: null, invested: null };
    const entry = getEntry(data, ym);
    const prevEntry = getEntry(data, ymPrev(ym));
    const contrib = r2(contributionSplit(entry).currentNet + transferCurrentSplit(data, entry).net);
    const pay = e => e ? (Number(e.salaryNet) || 0) + (Number(e.extraSalary) || 0) : null;
    const salaryDelta = (entry && prevEntry) ? r2(pay(entry) - pay(prevEntry)) : null;
    if (salaryDelta == null) {
      // can't compare like-for-like without both months' income — don't guess
      return { mismatch: false, diff: null, contributions: contrib, invested: is.invested };
    }
    const diff = r2(contrib + salaryDelta - is.invested);
    return {
      mismatch: Math.abs(diff) > 50,
      diff,
      contributions: contrib,
      invested: is.invested,
    };
  }

  /* ----------------- §2.4 market growth vs contributions --------------- */

  function marketGrowthForAccount(data, ym, accId) {
    const prev = ymPrev(ym);
    const cur = getSnapshot(data, accId, ym);
    const pre = getSnapshot(data, accId, prev);
    if (!cur || cur.balancePayday == null || !pre || pre.balancePayday == null) return null;
    const entry = getEntry(data, ym);
    const contrib = contributionsForAccount(entry, accId);
    const transf = transfersForAccount(entry, accId);
    return r2(cur.balancePayday - pre.balancePayday - contrib - transf);
  }

  // Portfolio market growth = Σ over non-current accounts.
  function portfolioMarketGrowth(data, ym) {
    let sum = 0, any = false;
    for (const acc of data.accounts || []) {
      if (acc.type === 'current') continue;
      const g = marketGrowthForAccount(data, ym, acc.id);
      if (g == null) continue;
      sum += g; any = true;
    }
    return any ? r2(sum) : null;
  }

  // Net flow into a single account from an entry (contributions + transfers).
  function netFlowForAccount(entry, accId) {
    return r2(contributionsForAccount(entry, accId) + transfersForAccount(entry, accId));
  }

  // Trailing average of monthly invested amount (§2.3) over the last n months
  // that have a computable value. Used to seed projections with the user's
  // *actual* savings pace instead of a hardcoded guess.
  function trailingInvested(data, n) {
    const ms = monthSeries(data);
    const vals = [];
    for (let i = ms.length - 1; i >= 0 && vals.length < (n || 12); i--) {
      const is = investedAndSavings(data, ms[i]);
      if (is.invested != null && isFinite(is.invested)) vals.push(is.invested);
    }
    if (!vals.length) return null;
    return r2(vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  // Median monthly invested over the last n months — robust to one-off lumps
  // (a few big deposits won't drag it up the way the mean does). Better default
  // for "sustainable monthly contribution" in projections.
  function medianInvested(data, n) {
    const ms = monthSeries(data);
    const vals = [];
    for (let i = ms.length - 1; i >= 0 && vals.length < (n || 12); i--) {
      const is = investedAndSavings(data, ms[i]);
      if (is.invested != null && isFinite(is.invested)) vals.push(is.invested);
    }
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return r2(vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2);
  }

  // §2.5 Approximate annualized personal return (Simple Dietz) for one calendar
  // year over the accounts matching `pred` (default: FIRE-capital accounts).
  //   return ≈ marketGrowth_year / (startBalance + netFlow_year / 2)
  function personalReturn(data, year, pred) {
    pred = pred || (a => includesInFire(a));
    const accs = (data.accounts || []).filter(pred);
    if (!accs.length) return null;
    const yStr = String(year);
    const ms = monthSeries(data).filter(m => m.slice(0, 4) === yStr);
    if (!ms.length) return null;

    // start value = portfolio at the month before the first in-year month.
    // If that month has no data (e.g. the very first tracked year), fall back to
    // using the first in-year month as the baseline and count growth from there.
    let start = 0, startAny = false;
    const firstPrev = ymPrev(ms[0]);
    accs.forEach(a => {
      const s = getSnapshot(data, a.id, firstPrev);
      if (s && s.balancePayday != null) { start += s.balancePayday; startAny = true; }
    });
    let growthMonths = ms;
    if (!startAny) {
      accs.forEach(a => {
        const s = getSnapshot(data, a.id, ms[0]);
        if (s && s.balancePayday != null) { start += s.balancePayday; startAny = true; }
      });
      growthMonths = ms.slice(1); // first month is the baseline
    }
    if (!startAny || !growthMonths.length) return null;

    let mg = 0, flow = 0;
    growthMonths.forEach(m => {
      const entry = getEntry(data, m);
      accs.forEach(a => {
        const g = marketGrowthForAccount(data, m, a.id);
        if (g != null) mg += g;
        flow += netFlowForAccount(entry, a.id);
      });
    });
    const denom = start + flow / 2;
    if (!denom) return null;
    return { year, ret: mg / denom, marketGrowth: r2(mg), netFlow: r2(flow), startBalance: r2(start) };
  }

  // Net contributions across portfolio (source=current only → "money I saved").
  function portfolioContributions(data, ym) {
    const entry = getEntry(data, ym);
    let s = 0;
    (entry && entry.contributions || []).forEach(c => {
      if (c.source === 'external') return;
      s += Number(c.amount) || 0;
    });
    return r2(s);
  }

  /* ----------------------- monthly table (Tab 2) ----------------------- */

  function buildMonthlyTable(data) {
    const months = monthSeries(data);
    return months.map(ym => {
      const prev = ymPrev(ym);
      const liquid = liquidNetWorth(data, ym);
      const prevLiquid = liquidNetWorth(data, prev);
      const exp = estimatedExpenses(data, ym);
      const is = investedAndSavings(data, ym);
      const rec = reconcile(data, ym);
      const entry = getEntry(data, ym);
      const flags = new Set([...(exp.flags || []), ...(is.flags || [])]);
      if (rec.mismatch) flags.add('RECONCILE_MISMATCH');
      if (entry && Array.isArray(entry.flags)) entry.flags.forEach(f => flags.add(f));
      const delta = (liquid != null && prevLiquid != null) ? r2(liquid - prevLiquid) : null;
      const deltaPct = (delta != null && prevLiquid) ? delta / prevLiquid : null;
      return {
        ym,
        label: monthLabelIT(ym),
        liquid,
        delta,
        deltaPct,
        contributions: portfolioContributions(data, ym),
        market: portfolioMarketGrowth(data, ym),
        expenses: exp.value,
        invested: is.invested,
        savingsRate: is.savingsRate,
        totalIncome: is.totalIncome,
        flags: Array.from(flags),
      };
    });
  }

  // Rolling N-month average over a numeric series (nulls skipped).
  function rollingAvg(values, ym2idx, months, n) {
    // values: array aligned to months; returns array of same length
    return values.map((_, i) => {
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - n + 1); j <= i; j++) {
        if (values[j] != null) { sum += values[j]; cnt++; }
      }
      return cnt ? sum / cnt : null;
    });
  }

  /* ================= Statement import (ABN AMRO / Scalable) ============
     Pure parsers + monthly digest. The dashboard cannot read binary XLS;
     ABN users must download the TXT (TAB) format, which has the exact same
     8 columns: accountNumber, mutationcode, transactiondate(YYYYMMDD),
     valuedate, startsaldo, endsaldo, amount, description.
     Scalable Broker CSV: ';'-separated, decimal comma, header
     date;time;status;reference;description;assetType;type;isin;shares;price;
     amount;fee;tax;currency.
     ==================================================================== */

  // "1.234,56" | "1234,56" | "1234.56" | 1234.56 → number
  function parseAmount(v) {
    if (typeof v === 'number') return v;
    let s = String(v == null ? '' : v).trim();
    if (!s) return 0;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }
  function ymdToIso(v) { // 20260703 / "20260703" → "2026-07-03"
    const s = String(v).replace(/\.0$/, '').trim();
    if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return null;
  }
  function extractIban(description) {
    // Uppercase-only body (no /i): ABN prints IBANs unspaced in caps; a
    // case-insensitive class would swallow following lowercase words.
    // Two formats: classic "IBAN: NL12..." and (from apr-2026 exports)
    // structured "/TRTP/SEPA OVERBOEKING/IBAN/NL12.../BIC/...".
    const m = String(description || '').match(/IBAN[:\s\/]*([A-Z]{2}\d{2}[A-Z0-9]{6,30})/);
    return m ? m[1] : null;
  }

  // Shared row-object mapping for a single ABN row given as a cell array
  // (columns: accountNumber, mutationcode, transactiondate, valuedate,
  // startsaldo, endsaldo, amount, description). Cells may be strings (text
  // export, possibly "20260102.0") or numbers (binary XLS read via SheetJS,
  // e.g. 20260102) — both ymdToIso/parseAmount accept either. Returns null
  // for header/blank/malformed rows.
  function abnRowFromCells(cells) {
    if (!cells || cells.length < 8) return null;
    if (/accountNumber/i.test(String(cells[0]))) return null; // header
    const date = ymdToIso(cells[2]);
    if (!date) return null;
    return {
      account: String(cells[0]).replace(/\.0$/, '').trim(),
      date, ym: date.slice(0, 7),
      start: parseAmount(cells[4]), end: parseAmount(cells[5]),
      amount: parseAmount(cells[6]),
      description: String(cells[7] == null ? '' : cells[7]).trim(),
      counterIban: extractIban(cells[7]),
    };
  }

  // → [{account, date:"YYYY-MM-DD", ym, start, end, amount, description, counterIban}]
  // Text export (TSV/CSV, as downloaded or converted from Excel "save as text").
  function parseABNStatement(text) {
    const rows = [];
    String(text || '').split(/\r?\n/).forEach(line => {
      if (!line.trim()) return;
      const cells = line.split('\t').length >= 8 ? line.split('\t') : line.split(';');
      const row = abnRowFromCells(cells);
      if (row) rows.push(row);
    });
    rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    return rows;
  }

  // Same output, from an array-of-arrays (one row per statement line, cells
  // already split — e.g. XLSX.utils.sheet_to_json(sheet, {header:1, raw:true})
  // when reading a genuine binary .xls export in the browser via SheetJS).
  function parseABNRows(rowsArray) {
    const rows = [];
    (rowsArray || []).forEach(cells => {
      const row = abnRowFromCells(cells);
      if (row) rows.push(row);
    });
    rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    return rows;
  }

  // → [{date, ym, status, reference, description, assetType, type, isin, amount, fee}]
  function parseScalableCSV(text) {
    const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const out = [];
    lines.forEach((line, i) => {
      if (i === 0 && /^date;/i.test(line)) return;
      const c = line.split(';').map(s => s.replace(/^"|"$/g, ''));
      if (c.length < 11) return;
      const date = ymdToIso(c[0]);
      if (!date) return;
      out.push({
        date, ym: date.slice(0, 7), status: c[2], reference: c[3] || null, description: c[4],
        assetType: c[5], type: c[6], isin: c[7] || null,
        amount: parseAmount(c[10]), fee: parseAmount(c[11]),
      });
    });
    return out.filter(r => r.status === 'Executed')
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  }

  // Counterparty name from an ABN description: classic "Naam: G OTTOBONI ..."
  // or structured "/TRTP/.../NAME/WTC Brands/..." (export format from apr-2026).
  function extractCounterparty(desc) {
    let m = String(desc || '').match(/Naam:\s*(.+?)(?=\s{2,}|\s*(?:Machtiging|Kenmerk|Omschrijving|IBAN|BIC):|$)/);
    if (m) return m[1].trim();
    m = String(desc || '').match(/\/NAME\/([^\/]+)/);
    return m ? m[1].trim() : null;
  }

  /* An ABN export can contain SEVERAL accounts (main + joint + savings).
     Summarize each with a guessed role so the UI can map them:
     - 'main'    → receives the salary (opts.salaryMatch, default /ASML/)
     - 'cj'      → joint account: ≥2 distinct persons paying in repeatedly
     - 'savings' → few movements, credit interest lines
     - 'unknown' → let the user decide. */
  function abnAccountsInStatement(rows, opts) {
    const salaryMatch = (opts && opts.salaryMatch) || /ASML/i;
    const by = {};
    rows.forEach(r => { (by[r.account] = by[r.account] || []).push(r); });
    return Object.entries(by).map(([account, rs]) => {
      const credits = rs.filter(r => r.amount > 0);
      const hasSalary = credits.some(r => salaryMatch.test(r.description));
      const payerCounts = {};
      credits.forEach(r => {
        const p = extractCounterparty(r.description);
        if (p) payerCounts[p] = (payerCounts[p] || 0) + 1;
      });
      const recurringPayers = Object.keys(payerCounts).filter(p => payerCounts[p] >= 2);
      const hasInterest = rs.some(r => /CREDIT INTEREST/i.test(r.description));
      let role = 'unknown';
      if (hasSalary) role = 'main';
      else if (recurringPayers.length >= 2) role = 'cj';
      else if (rs.length <= 25 && hasInterest) role = 'savings';
      // The own IBAN embeds the account number (NL43ABNA0124103138 ⊃ 124103138):
      // recover it from any counter-IBAN seen anywhere in the export.
      let iban = null;
      for (const r of rows) {
        if (r.counterIban && r.counterIban.indexOf(account) >= 0) { iban = r.counterIban; break; }
      }
      return {
        account, iban, role, txCount: rs.length,
        from: rs[0].date, to: rs[rs.length - 1].date,
        lastBalance: rs[rs.length - 1].end,
        payers: Object.keys(payerCounts),
      };
    });
  }

  /* §7.4 coherence check: per account, endsaldo of the last row must equal
     startsaldo of the first row + Σ amounts. A mismatch means the export is
     incomplete (missing rows) and balances/expenses would be wrong. */
  function abnValidateContinuity(rows) {
    const by = {};
    rows.forEach(r => { (by[r.account] = by[r.account] || []).push(r); });
    return Object.entries(by).map(([account, rs]) => {
      const sum = rs.reduce((s, r) => s + r.amount, 0);
      const expected = r2(rs[0].start + sum);
      const actual = r2(rs[rs.length - 1].end);
      return { account, ok: Math.abs(expected - actual) < 0.02, expected, actual, diff: r2(actual - expected) };
    });
  }

  // Balance at end of a given ISO date = endsaldo of the last row on/before it.
  function abnBalanceAt(rows, isoDate) {
    let bal = null;
    for (const r of rows) { if (r.date <= isoDate) bal = r.end; else break; }
    return bal;
  }
  function isoDate(ym, day) {
    const { y, m } = ymParts(ym);
    const last = new Date(y, m, 0).getDate();
    return ym + '-' + String(Math.min(Math.max(1, day), last)).padStart(2, '0');
  }
  function isoAddDays(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /* Monthly digest of an ABN statement.
     ownIbans: { IBAN → accountId } for the user's OTHER accounts (savings,
     Scalable, second savings…). Transfers to/from those are internal moves,
     not spending/income.
     sharedExpenseIbans: { IBAN → label } for accounts where a partner also
     contributes (e.g. common household account). Credits FROM those IBANs
     are the partner's contribution and must be excluded from otherIncome —
     they are not the user's money.
     Salary heuristic: largest non-own credit within [payday−3, payday+1];
     always shown in a preview for the user to amend.
     actualExpenses(m): Σ debits in cycle [payday(m−1), payday(m)−1] excluding
     transfers to own IBANs — replaces the residual estimate with bank truth. */
  function abnMonthlyDigest(rows, opts) {
    const paydayDay = (opts && opts.paydayDay) || 25;
    const ownIbans = (opts && opts.ownIbans) || {};
    const sharedExpenseIbans = (opts && opts.sharedExpenseIbans) || {};
    // Joint-account (CJ) IBANs: debits TO them are a real expense ("Spese
    // condivise" — §3 opzione A); credits FROM them are residual/closure moves,
    // never income. All transactions ON the CJ account itself must not be in
    // `rows` at all (filter by accountNumber before calling).
    const cjIbans = (opts && opts.cjIbans) || {};
    const categoryRules = (opts && opts.categoryRules) || [];
    // If the export mixes several accounts, restrict to one.
    if (opts && opts.accountNumber) rows = rows.filter(r => r.account === opts.accountNumber);
    const own = iban => iban && ownIbans[iban] != null;
    const shared = iban => iban && sharedExpenseIbans[iban] != null;
    const cj = iban => iban && cjIbans[iban] != null;
    const months = Array.from(new Set(rows.map(r => r.ym))).sort();
    // Pass 1 — identify each month's salary ROW (largest credit near payday,
    // not from own/shared/CJ). Tracking the row (not the amount) lets pass 2
    // exclude it from otherIncome of ANY cycle: salary(m−1) lands exactly on
    // the first day of cycle m and must not appear as "altre entrate" there.
    const salaryRowByYm = {};
    const salaryRows = new Set();
    months.forEach(ym => {
      const payday = isoDate(ym, paydayDay);
      let best = null;
      rows.forEach(r => {
        if (r.amount > 0 && !own(r.counterIban) && !shared(r.counterIban) && !cj(r.counterIban)
          && r.date >= isoAddDays(payday, -3) && r.date <= isoAddDays(payday, 1)
          && (!best || r.amount > best.amount)) best = r;
      });
      if (best) { salaryRowByYm[ym] = best; salaryRows.add(best); }
    });
    const out = {};
    months.forEach(ym => {
      const payday = isoDate(ym, paydayDay);
      const prevYmVal = ymPrev(ym);
      const prevPayday = isoDate(prevYmVal, paydayDay);
      const balancePayday = abnBalanceAt(rows, payday);
      const balancePaydayMinus1 = abnBalanceAt(rows, isoAddDays(payday, -1));
      const salary = salaryRowByYm[ym] ? salaryRowByYm[ym].amount : 0;
      // own-account transfers dated in this calendar month
      const transfers = rows.filter(r => r.ym === ym && own(r.counterIban)).map(r => ({
        date: r.date, amount: r2(Math.abs(r.amount)),
        direction: r.amount < 0 ? 'out' : 'in',
        counterAccountId: ownIbans[r.counterIban],
      }));
      // actual spending over the cycle prevPayday … payday−1
      let spent = 0, otherIncome = 0, partnerContributions = 0, cjReturns = 0;
      const categories = {};
      rows.forEach(r => {
        if (r.date >= prevPayday && r.date < payday) {
          if (r.amount < 0 && !own(r.counterIban)) {
            spent += -r.amount;
            const cat = cj(r.counterIban) ? 'Spese condivise'
              : categorizeTransaction(r.description, categoryRules);
            categories[cat] = (categories[cat] || 0) + (-r.amount);
          }
          if (r.amount > 0 && !own(r.counterIban) && !salaryRows.has(r)) {
            if (cj(r.counterIban)) cjReturns += r.amount;          // residuo/chiusura CJ: mai income
            else if (shared(r.counterIban)) partnerContributions += r.amount;
            else otherIncome += r.amount;
          }
        }
      });
      out[ym] = {
        ym, balancePayday, balancePaydayMinus1,
        salary: r2(salary), otherIncome: r2(otherIncome),
        partnerContributions: r2(partnerContributions), cjReturns: r2(cjReturns),
        actualExpenses: r2(spent), transfers,
        categories: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, r2(v)])),
      };
    });
    if (months.length) out[months[0]].partial = true;
    return out;
  }

  /* Category from an ABN description. `rules` (user-defined, persisted in
     settings) win over the built-ins: [{match: "N26"|"NL97...", category}] —
     case-insensitive substring match on the full description. Unmatched plain
     SEPA transfers fall back to "Da classificare" so the UI can offer the user
     a way to classify them (and save a rule for future imports). */
  function categorizeTransaction(desc, rules) {
    if (!desc) return 'Altro';
    const d = desc.toUpperCase();
    for (const r of (rules || [])) {
      if (r && r.match && d.indexOf(String(r.match).toUpperCase()) >= 0) return r.category;
    }
    if (/ALBERT HEIJN|AH TO GO|JUMBO|LIDL|ALDI|PLUS |SPAR |DIRK|COOP /i.test(d)) return 'Spesa alimentare';
    if (/THUISBEZORGD|UBER\s*EATS|DELIVEROO|DOMINOS|MCDONALDS/i.test(d)) return 'Food delivery';
    if (/RISTORANTE|RESTAURANT|CAFE|COFFEE|STARBUCKS|BAR /i.test(d)) return 'Ristoranti e bar';
    if (/NS GROEP|NS REIZIGERS|GVB|OV-CHIPKAART|TRANSAVIA|KLM|RYANAIR|BOOKING|AIRBNB/i.test(d)) return 'Trasporti e viaggi';
    if (/ZILVEREN KRUIS|ZORGVERZEK|APOTHEEK|HUISARTS/i.test(d)) return 'Salute';
    if (/HUUR|RENT|HYPOTHEEK|HOOFTLAAN/i.test(d)) return 'Affitto/casa';
    if (/BUDGET ENERGIE|ENECO|VATTENFALL|BRABANT WATER|ZIGGO|KPN|T-MOBILE|BUDGET INTERNET/i.test(d)) return 'Utenze';
    if (/NETFLIX|SPOTIFY|DISNEY|YOUTUBE|PLAYSTATION|STEAM|PRIME/i.test(d)) return 'Abbonamenti';
    if (/ANWB|VERZEKER|ABN AMRO SCHADEV/i.test(d)) return 'Assicurazioni';
    if (/GEMEENTE|BELASTING/i.test(d)) return 'Tasse e imposte';
    if (/SPORT|GYM|BOULDE|ATLETIEK|FITNESS/i.test(d)) return 'Sport';
    if (/TIKKIE/i.test(d)) return 'Condivise/partner';
    if (/SEPA\s+INCASSO/i.test(d)) return 'Incassi automatici';
    // plain bank transfer to an unknown counterparty → let the user decide
    if (/SEPA\s+OVERBOEKING/i.test(d)) return 'Da classificare';
    return 'Altro';
  }

  /* Scalable digest: net personal cash in/out per month (Deposits −
     Withdrawals) and portfolio-internal items (fees, interest, dividends).
     Used to corroborate/fill contributions — the ABN side is authoritative
     for transfers to avoid double counting. */
  function scalableMonthlyDigest(rows) {
    // A cash Distribution that shares its reference with a Security-side
    // Corporate action is a PRINCIPAL repayment (e.g. iBonds maturity):
    // internal asset→cash, NOT dividend income (§6 FLUSSI_CONTI).
    const caRefs = new Set(rows
      .filter(r => r.assetType !== 'Cash' && r.type === 'Corporate action' && r.reference)
      .map(r => r.reference));
    const out = {};
    rows.forEach(r => {
      const o = out[r.ym] || (out[r.ym] = { ym: r.ym, deposits: 0, withdrawals: 0, fees: 0, interest: 0, dividends: 0, maturities: 0 });
      if (r.assetType === 'Cash') {
        if (r.type === 'Deposit') o.deposits += r.amount;
        else if (r.type === 'Withdrawal' || r.type === 'Cash Transfer Out') o.withdrawals += Math.abs(r.amount);
        else if (r.type === 'Fee') o.fees += Math.abs(r.amount);
        else if (r.type === 'Interest') o.interest += r.amount;
        else if (r.type === 'Distribution') {
          if (r.reference && caRefs.has(r.reference)) o.maturities += r.amount;
          else o.dividends += r.amount;  // CANCEL-* rows are negative and net out here
        }
      }
      // 'Security transfer' (migrazione titoli in natura) e 'Corporate action'
      // lato Security non sono flussi di cassa: ignorati per costruzione.
    });
    Object.values(out).forEach(o => ['deposits', 'withdrawals', 'fees', 'interest', 'dividends', 'maturities'].forEach(k => o[k] = r2(o[k])));
    return out;
  }

  /* Merge an ABN digest into the dataset (additive; existing manual values win
     unless overwrite=true). Creates/updates snapshots for the current account,
     entry income fields, actualExpenses, and internal transfers (deduped by
     month+amount+counterAccount). Returns a change log for the preview. */
  function applyAbnDigest(data, digest, currentAccountId, opts) {
    const overwrite = !!(opts && opts.overwrite);
    const balancesOnly = !!(opts && opts.balancesOnly); // savings/other accounts: only snapshots
    const log = [];
    Object.values(digest).forEach(mo => {
      const ym = mo.ym;
      const key = currentAccountId + '|' + ym;
      const snap = data.snapshots[key] || { accountId: currentAccountId, yearMonth: ym, balancePayday: null, balancePaydayMinus1: null };
      if (mo.balancePayday != null && (overwrite || snap.balancePayday == null)) { snap.balancePayday = mo.balancePayday; log.push(ym + ': saldo payday ' + mo.balancePayday); }
      if (mo.balancePaydayMinus1 != null && (overwrite || snap.balancePaydayMinus1 == null)) { snap.balancePaydayMinus1 = mo.balancePaydayMinus1; }
      data.snapshots[key] = snap;
      if (balancesOnly) return;
      const entry = data.entries[ym] || {
        yearMonth: ym, salaryNet: 0, extraSalary: 0, otherIncome: 0,
        paydayDayOfMonth: (data.settings && data.settings.defaultPaydayDayOfMonth) || 25,
        contributions: [], internalTransfers: [], flags: [],
      };
      if (mo.salary && (overwrite || !entry.salaryNet)) { entry.salaryNet = mo.salary; log.push(ym + ': stipendio ' + mo.salary); }
      if (mo.otherIncome && (overwrite || !entry.otherIncome)) entry.otherIncome = mo.otherIncome;
      if (mo.actualExpenses != null && !mo.partial && (overwrite || entry.expensesActual == null)) {
        entry.expensesActual = mo.actualExpenses; log.push(ym + ': spese reali ' + mo.actualExpenses);
      }
      (mo.transfers || []).forEach(t => {
        const fromId = t.direction === 'out' ? currentAccountId : t.counterAccountId;
        const toId = t.direction === 'out' ? t.counterAccountId : currentAccountId;
        const dup = (entry.internalTransfers || []).some(x =>
          x.fromAccountId === fromId && x.toAccountId === toId && Math.abs(x.amount - t.amount) < 0.01);
        if (!dup) {
          entry.internalTransfers.push({ id: 'imp-' + ym + '-' + fromId.slice(-4) + '-' + Math.round(t.amount * 100), fromAccountId: fromId, toAccountId: toId, amount: t.amount, note: 'import estratto ' + t.date });
          log.push(ym + ': trasferimento ' + t.amount);
        }
      });
      data.entries[ym] = entry;
    });
    return log;
  }

  /* ---------- pension pots without statements (e.g. PME) ---------------
     account.estimateFromContributions = true → when a month has no snapshot,
     its balance is ESTIMATED as all registered contributions compounded
     monthly at account.assumedAnnualReturn (default 3% real). Clearly labeled
     a stima in the UI; a real snapshot always wins. */
  function estimatedPensionBalance(data, acc, ym) {
    const mRet = Math.pow(1 + (acc.assumedAnnualReturn != null ? acc.assumedAnnualReturn : 0.03), 1 / 12) - 1;
    const months = monthSeries(data).filter(m => ymCompare(m, ym) <= 0);
    let bal = 0, seeded = false;
    months.forEach(m => {
      const s = getSnapshot(data, acc.id, m);
      if (s && s.balancePayday != null) { bal = s.balancePayday; seeded = true; return; }
      bal = bal * (1 + mRet) + contributionsForAccount(getEntry(data, m), acc.id) + transfersForAccount(getEntry(data, m), acc.id);
    });
    if (!seeded && bal === 0) return null;
    return r2(bal);
  }

  /* ------------- lijfrente planner (Box 1 deduction + Box 3) -----------
     Deterministic arithmetic only — the jaarruimte (deduction space) depends
     on income and pension accrual and MUST be verified with the
     Belastingdienst; this is a reminder, not advice. */
  function lijfrentePlan(fire, annualContribution) {
    const a = Math.max(0, Number(annualContribution) || 0);
    const box1Refund = r2(a * (fire.marginalRateBox1 || 0.37));
    const box3AnnualSaving = r2(a * (fire.box3DragAnnual || 0));
    return {
      annualContribution: a,
      box1Refund,
      box3AnnualSaving,          // recurring: assets moved out of Box 3 base
      firstYearBenefit: r2(box1Refund + box3AnnualSaving),
      netCost: r2(a - box1Refund),
      // Box 3 saving compounds: after n years of contributing `a`, the base
      // removed is n×a → saving that year ≈ n×a×drag
      box3SavingAfterYears: n => r2(a * n * (fire.box3DragAnnual || 0)),
    };
  }

  /* ============================ §3 FIRE math ========================== */

  // Present value at fireAge of an annuity paying `annual` per year for
  // `years` years, discounted at real return r (annual). End-of-year payments.
  function annuityPV(annual, years, r) {
    if (years <= 0) return 0;
    if (r === 0) return annual * years;
    return annual * (1 - Math.pow(1 + r, -years)) / r;
  }

  function fireNumberSimple(fire) {
    return r2(fire.monthlyExpenseFire * 12 / fire.swr);
  }

  // Two-phase: bridge (fireAge→pensionStartAge full expenses) + perpetual
  // capital at pension age covering (expenses − pension), discounted to fireAge.
  function fireNumberTwoPhase(fire) {
    const annualExp = fire.monthlyExpenseFire * 12;
    const bridgeYears = Math.max(0, fire.pensionStartAge - fire.fireAge);
    const r = fire.realReturnBase;
    const bridgeCapital = annuityPV(annualExp, bridgeYears, r);
    const postPensionAnnualNeed = Math.max(0, (fire.monthlyExpenseFire - fire.expectedPensionMonthly) * 12);
    const legacyAtPension = postPensionAnnualNeed / fire.swr;
    const legacyCapital = legacyAtPension / Math.pow(1 + r, bridgeYears);
    const total = r2(bridgeCapital + legacyCapital);
    const simple = fireNumberSimple(fire);
    return {
      twoPhase: total,
      simple,
      pensionSaving: r2(simple - total),
      bridgeCapital: r2(bridgeCapital),
      legacyCapital: r2(legacyCapital),
    };
  }

  // targetNumber (optional) overrides the default simple FIRE number — pass
  // fireNumberTwoPhase().twoPhase to make Coast pension-aware.
  function coastFire(fire, currentLiquid, currentAge, realReturn, targetNumber) {
    const number = targetNumber != null ? targetNumber : fireNumberSimple(fire);
    const yearsToFire = fire.fireAge - currentAge;
    const yearsToCoast = fire.coastAge - currentAge;
    // capital required today so that, with no further contributions, you hit
    // the FIRE number at fireAge:
    const requiredToday = number / Math.pow(1 + realReturn, Math.max(0, yearsToFire));
    const coastNumberAtCoastAge = number / Math.pow(1 + realReturn, Math.max(0, fire.fireAge - fire.coastAge));
    let ageIfStopNow = null;
    if (currentLiquid >= number) {
      ageIfStopNow = currentAge;
    } else if (currentLiquid > 0 && realReturn > 0) {
      // with r ≤ 0 the capital never grows to the target — leave null
      ageIfStopNow = currentAge + Math.log(number / currentLiquid) / Math.log(1 + realReturn);
    }
    return {
      number,
      requiredToday,
      coastNumberAtCoastAge,
      gapToday: r2(requiredToday - currentLiquid),
      ageIfStopNow,
      yearsToCoast,
    };
  }

  // Deterministic accumulation projection. Returns month-by-month series and
  // the month the balance first reaches the FIRE number.
  function project(opts) {
    const {
      start, monthlyContribution, annualReturn, fireNumber,
      startYM, maxYears = 60,
      applyBox3 = false, box3DragAnnual = 0, box3StartYM = null,
    } = opts;
    const mRet = Math.pow(1 + annualReturn, 1 / 12) - 1;
    let balance = start;
    let ym = startYM;
    const series = [{ ym, balance: r2(balance) }];
    let reachedYM = balance >= fireNumber ? ym : null;
    const maxMonths = maxYears * 12;
    for (let i = 0; i < maxMonths; i++) {
      balance = balance * (1 + mRet) + monthlyContribution;
      ym = ymNext(ym);
      if (applyBox3 && box3StartYM && ymCompare(ym, box3StartYM) >= 0) {
        balance -= balance * (box3DragAnnual / 12);
      }
      series.push({ ym, balance: r2(balance) });
      if (reachedYM == null && balance >= fireNumber) reachedYM = ym;
    }
    return {
      series,
      reachedYM,
      reachedYear: reachedYM ? ymParts(reachedYM).y : null,
      finalBalance: r2(balance),
    };
  }

  /* -------------------------- Monte Carlo (§3.5) ----------------------- */

  function gaussian(mean, std, rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + std * z;
  }

  // Simple seeded RNG (mulberry32) for reproducible tests.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function monteCarlo(opts) {
    const {
      start, monthlyContribution, currentAge, fireAge,
      pensionStartAge, monthlyExpenseFire, expectedPensionMonthly,
      inflation, meanReturn, stdDev, runs = 1000, endAge = 90, seed = 12345,
    } = opts;
    const rng = mulberry32(seed);
    const accumMonths = Math.round((fireAge - currentAge) * 12);
    const totalMonths = Math.round((endAge - currentAge) * 12);
    const pensionMonth = Math.round((pensionStartAge - currentAge) * 12);

    const finals = [];
    const crossings = []; // age at which balance first reaches the fire number
    const failAges = [];
    const fireNumber = monthlyExpenseFire * 12 / 0.035;
    let successes = 0;
    // record balance percentiles at yearly checkpoints
    const checkpoints = [];
    for (let y = 0; y <= (endAge - currentAge); y++) checkpoints.push(y * 12);
    const cpData = checkpoints.map(() => []);

    for (let run = 0; run < runs; run++) {
      let balance = start;
      let crossed = null;
      let failed = false;
      let failAge = null;
      let cpIdx = 0;
      let mRet = 0;
      for (let m = 0; m <= totalMonths; m++) {
        if (cpIdx < checkpoints.length && m === checkpoints[cpIdx]) {
          cpData[cpIdx].push(balance); cpIdx++;
        }
        const age = currentAge + m / 12;
        if (crossed == null && balance >= fireNumber) crossed = age;
        if (m === totalMonths) break;
        // Annual return drawn ONCE per 12 months, applied monthly. Redrawing
        // every month would average 12 independent draws and collapse the
        // realized annual volatility to stdDev/√12 (~4% instead of 15%),
        // silently overstating the success probability.
        if (m % 12 === 0) {
          const annual = gaussian(meanReturn, stdDev, rng);
          mRet = Math.pow(1 + Math.max(-0.95, annual), 1 / 12) - 1;
        }
        balance = balance * (1 + mRet);
        if (m < accumMonths) {
          balance += monthlyContribution;
        } else {
          // withdrawal phase: inflation-adjusted FIRE expenses, less pension
          const yearsFromNow = m / 12;
          const infl = Math.pow(1 + inflation, yearsFromNow);
          let need = monthlyExpenseFire * infl;
          if (m >= pensionMonth) need -= expectedPensionMonthly * infl;
          balance -= Math.max(0, need);
          if (balance < 0 && !failed) { failed = true; failAge = age; }
        }
      }
      finals.push(balance);
      if (crossed != null) crossings.push(crossed);
      if (!failed) successes++; else failAges.push(failAge);
    }

    function pct(arr, p) {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
      return s[idx];
    }
    const fan = checkpoints.map((cp, i) => ({
      age: currentAge + cp / 12,
      p10: pct(cpData[i], 10), p25: pct(cpData[i], 25), p50: pct(cpData[i], 50),
      p75: pct(cpData[i], 75), p90: pct(cpData[i], 90),
    }));

    return {
      runs,
      successProbability: successes / runs,
      medianCrossingAge: pct(crossings, 50),
      medianFinal: pct(finals, 50),
      failAges,
      fan,
      fireNumber: r2(fireNumber),
    };
  }

  /* ==================== FIRE Simulator engine (real €) ================
     Deterministic, asset-class-level year-by-year projection to endAge.
     Everything is in REAL (today's) euros: per-class returns are real, spend
     and pension income are real. The AI layer never touches these numbers — it
     only emits parameter changes that get fed back into these functions.

     AssetClass: { id, name, value, realReturn, volatility, kind:'liquid'|'pension' }
     FireProfile: {
       currentAge, retirementAge, statePensionAge, endAge,
       annualContribution, annualSpend, statePensionAnnual
     }
     ==================================================================== */

  function fireClassTotals(classes) {
    let liquid = 0, pension = 0;
    (classes || []).forEach(c => {
      const v = Number(c.value) || 0;
      if (c.kind === 'pension') pension += v; else liquid += v;
    });
    return { liquid: r2(liquid), pension: r2(pension), total: r2(liquid + pension) };
  }

  // Crisis / stress-test shock. profile.shock = {enabled, atAge, severity} where
  // severity ~ the equity drawdown (e.g. 0.35). Each class is hit in proportion
  // to its volatility (16% = equity reference), capped at −80%, so cash barely
  // moves and high-vol classes fall more. Recovery is the normal compounding
  // afterwards — which is exactly what makes a crash near retirement (sequence-
  // of-returns risk) so much worse than one mid-career.
  function fireShock(profile) {
    const s = profile && profile.shock;
    if (!s || !s.enabled || !(Number(s.severity) > 0)) return null;
    return { atAge: Math.round(Number(s.atAge)), severity: Number(s.severity) };
  }
  function shockMult(vol, severity) {
    const f = (Number(vol) || 0) / 0.16;
    return Math.max(0.2, 1 - severity * f);
  }

  // One deterministic path. Contributions are allocated to liquid classes by
  // current weight; withdrawals are taken from liquid classes by weight.
  // Pension pots grow but are never drawn (second pillar); from statePensionAge
  // the state/annuity income (statePensionAnnual) reduces the withdrawal need.
  function simulateFireDeterministic(profile, classes, overrideReturns) {
    const p = profile;
    const shock = fireShock(p);
    let bal = (classes || []).map((c, i) => ({
      kind: c.kind === 'pension' ? 'pension' : 'liquid',
      ret: overrideReturns ? overrideReturns[i] : (Number(c.realReturn) || 0),
      vol: Number(c.volatility) || 0,
      bal: Number(c.value) || 0,
    }));
    const years = [];
    let depletedAge = null;
    for (let age = p.currentAge; age <= p.endAge; age++) {
      // 1) grow every class, then apply a crisis shock in the shock year
      bal.forEach(b => { b.bal = b.bal * (1 + b.ret); });
      if (shock && age === shock.atAge) bal.forEach(b => { b.bal *= shockMult(b.vol, shock.severity); });
      const phase = age < p.retirementAge ? 'accum' : 'decum';
      let contribution = 0, withdrawal = 0, pensionIncome = 0;
      const liquidIdx = bal.map((b, i) => b.kind === 'liquid' ? i : -1).filter(i => i >= 0);
      const liquidSum = () => liquidIdx.reduce((s, i) => s + bal[i].bal, 0);

      if (phase === 'accum') {
        contribution = Math.max(0, Number(p.annualContribution) || 0);
        const ls = liquidSum();
        liquidIdx.forEach(i => {
          const w = ls > 0 ? bal[i].bal / ls : 1 / liquidIdx.length;
          bal[i].bal += contribution * w;
        });
      } else {
        let need = Math.max(0, Number(p.annualSpend) || 0);
        if (age >= p.statePensionAge) {
          pensionIncome = Math.max(0, Number(p.statePensionAnnual) || 0);
          need = Math.max(0, need - pensionIncome);
        }
        const ls = liquidSum();
        withdrawal = Math.min(need, Math.max(0, ls));
        if (ls > 0 && withdrawal > 0) {
          liquidIdx.forEach(i => { bal[i].bal -= withdrawal * (bal[i].bal / ls); });
        }
        if (need > ls + 0.005 && depletedAge == null) depletedAge = age;
      }

      const liquidTotal = r2(liquidSum());
      const pensionTotal = r2(bal.filter(b => b.kind === 'pension').reduce((s, b) => s + b.bal, 0));
      years.push({
        age, phase,
        total: r2(liquidTotal + pensionTotal), liquidTotal, pensionTotal,
        contribution: r2(contribution), withdrawal: r2(withdrawal), pensionIncome: r2(pensionIncome),
        shortfall: phase === 'decum' ? r2(Math.max(0, (Number(p.annualSpend) || 0) - pensionIncome - withdrawal)) : 0,
      });
    }
    return { years, depletedAge, success: depletedAge == null };
  }

  // Earliest age at which contributions could stop and the plan still survives
  // to endAge (no liquid depletion during decumulation). null if even full
  // contributions until retirement still deplete.
  function coastFireAge(profile, classes) {
    for (let stop = profile.currentAge; stop <= profile.retirementAge; stop++) {
      if (simulateStopImpl(profile, classes, stop).success) return stop;
    }
    return null;
  }
  function simulateStopImpl(p, classes, stopAge) {
    const shock = fireShock(p);
    let bal = (classes || []).map(c => ({ kind: c.kind === 'pension' ? 'pension' : 'liquid', ret: Number(c.realReturn) || 0, vol: Number(c.volatility) || 0, bal: Number(c.value) || 0 }));
    let depletedAge = null;
    for (let age = p.currentAge; age <= p.endAge; age++) {
      bal.forEach(b => { b.bal *= (1 + b.ret); });
      if (shock && age === shock.atAge) bal.forEach(b => { b.bal *= shockMult(b.vol, shock.severity); });
      const phase = age < p.retirementAge ? 'accum' : 'decum';
      const liquidIdx = bal.map((b, i) => b.kind === 'liquid' ? i : -1).filter(i => i >= 0);
      const ls = () => liquidIdx.reduce((s, i) => s + bal[i].bal, 0);
      if (phase === 'accum') {
        const contribution = age < stopAge ? Math.max(0, Number(p.annualContribution) || 0) : 0;
        const s = ls();
        liquidIdx.forEach(i => { const w = s > 0 ? bal[i].bal / s : 1 / liquidIdx.length; bal[i].bal += contribution * w; });
      } else {
        let need = Math.max(0, Number(p.annualSpend) || 0);
        if (age >= p.statePensionAge) need = Math.max(0, need - (Number(p.statePensionAnnual) || 0));
        const s = ls();
        const wd = Math.min(need, Math.max(0, s));
        if (s > 0 && wd > 0) liquidIdx.forEach(i => { bal[i].bal -= wd * (bal[i].bal / s); });
        if (need > s + 0.005 && depletedAge == null) depletedAge = age;
      }
    }
    return { depletedAge, success: depletedAge == null };
  }

  // Monte Carlo: each class draws an annual real return ~ N(realReturn, vol)
  // per year. Success = liquid never depletes before endAge. Returns success
  // probability and P10/P50/P90 bands of total net worth per age.
  function monteCarloFire(profile, classes, runs, seed) {
    runs = runs || 1000;
    const rng = mulberry32((seed || 20260101) >>> 0);
    const shock = fireShock(profile);
    const ages = [];
    for (let age = profile.currentAge; age <= profile.endAge; age++) ages.push(age);
    const totalsByAge = ages.map(() => []);
    let successes = 0;
    const depletionAges = [];

    for (let run = 0; run < runs; run++) {
      let bal = (classes || []).map(c => ({ kind: c.kind === 'pension' ? 'pension' : 'liquid', mean: Number(c.realReturn) || 0, sd: Number(c.volatility) || 0, bal: Number(c.value) || 0 }));
      let depleted = null;
      for (let ai = 0; ai < ages.length; ai++) {
        const age = ages[ai];
        // One shared market shock per year: class return = mean + vol × z.
        // Independent per-class draws would grant diversification that highly
        // correlated equity classes (US/EU/EM/SCV) don't actually provide, and
        // measurably overstate the success probability. Full correlation is
        // the conservative, honest simplification.
        const z = gaussian(0, 1, rng);
        bal.forEach(b => { const r = b.mean + b.sd * z; b.bal *= (1 + Math.max(-0.95, r)); });
        if (shock && age === shock.atAge) bal.forEach(b => { b.bal *= shockMult(b.sd, shock.severity); });
        const phase = age < profile.retirementAge ? 'accum' : 'decum';
        const liquidIdx = bal.map((b, i) => b.kind === 'liquid' ? i : -1).filter(i => i >= 0);
        const ls = () => liquidIdx.reduce((s, i) => s + bal[i].bal, 0);
        if (phase === 'accum') {
          const c = Math.max(0, Number(profile.annualContribution) || 0); const s = ls();
          liquidIdx.forEach(i => { const w = s > 0 ? bal[i].bal / s : 1 / liquidIdx.length; bal[i].bal += c * w; });
        } else {
          let need = Math.max(0, Number(profile.annualSpend) || 0);
          if (age >= profile.statePensionAge) need = Math.max(0, need - (Number(profile.statePensionAnnual) || 0));
          const s = ls(); const wd = Math.min(need, Math.max(0, s));
          if (s > 0 && wd > 0) liquidIdx.forEach(i => { bal[i].bal -= wd * (bal[i].bal / s); });
          if (need > s + 0.005 && depleted == null) depleted = age;
        }
        totalsByAge[ai].push(bal.reduce((s, b) => s + b.bal, 0));
      }
      if (depleted == null) successes++; else depletionAges.push(depleted);
    }
    const pct = (arr, q) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
    const bands = ages.map((age, i) => ({
      age, p10: r2(pct(totalsByAge[i], 0.10)), p50: r2(pct(totalsByAge[i], 0.50)), p90: r2(pct(totalsByAge[i], 0.90)),
    }));
    return { runs, successProbability: successes / runs, bands, medianDepletionAge: pct(depletionAges, 0.5) };
  }

  /* -------------------------- on-track (§3.3) -------------------------- */

  function planProjectionCurve(plan, months) {
    // months: array of YYYY-MM ascending starting at plan.createdAt
    const mRet = Math.pow(1 + plan.assumedRealReturn, 1 / 12) - 1;
    let balance = plan.startingLiquidNetWorth;
    const out = {};
    months.forEach((ym, i) => {
      if (i > 0) balance = balance * (1 + mRet) + plan.plannedMonthlyContribution;
      out[ym] = r2(balance);
    });
    return out;
  }

  /* ------------------------------ exports ------------------------------ */

  return {
    // helpers
    MONTHS_IT, fmtEUR, fmtPct, r2,
    ymParts, ymPrev, ymNext, ymCompare, monthsBetween, monthLabelIT, ageAt,
    // accessors
    accountById, getSnapshot, getEntry, isLiquid, accountsActiveAt,
    currentAccounts, monthSeries,
    // §2
    liquidNetWorth, lockedNetWorth, totalNetWorth,
    defaultIncludeInFire, includesInFire, fireCapital,
    sumCurrent, contributionSplit, transferCurrentSplit,
    contributionsForAccount, transfersForAccount,
    estimatedExpenses, totalIncome, investedAndSavings, reconcile,
    marketGrowthForAccount, portfolioMarketGrowth, portfolioContributions,
    netFlowForAccount, trailingInvested, medianInvested, personalReturn,
    buildMonthlyTable, rollingAvg,
    // §3
    annuityPV, fireNumberSimple, fireNumberTwoPhase, coastFire,
    project, monteCarlo, planProjectionCurve, mulberry32,
    // FIRE simulator (asset-class, real €)
    fireClassTotals, simulateFireDeterministic, coastFireAge, monteCarloFire,
    // statement import + pension estimate + lijfrente planner
    parseAmount, ymdToIso, extractIban, extractCounterparty, parseABNStatement, parseABNRows, parseScalableCSV,
    abnAccountsInStatement, abnValidateContinuity,
    abnMonthlyDigest, scalableMonthlyDigest, applyAbnDigest, categorizeTransaction,
    estimatedPensionBalance, lijfrentePlan,
  };
});
