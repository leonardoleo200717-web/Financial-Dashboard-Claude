# Financial Dashboard — Software Requirements (v2)

> Personal finance tracking and FIRE planning dashboard for a single user (Leonardo).
> UI language: Italian. Currency: EUR only. Data entry: manual, monthly cadence (no broker/bank APIs).
> Persistence: localStorage with versioned JSON export/import.
> Stack: single HTML file, Chart.js via CDN, no build step.

---

## 0. Design Principles

1. **Snapshots are truth, flows are annotations.** Account balances entered by the user are the source of truth. Salary, contributions, and transfers annotate the month and enable derived metrics (expenses, market growth, savings rate). If flows are missing for a month, balance-based views still work; derived metrics show "—" rather than wrong numbers.
2. **Liquid vs locked capital are separate worlds.** Pension assets (PME, lijfrente, Italian fondo pensione) are tracked but excluded from FIRE-before-67 math. They appear as a second pillar that reduces post-67 spending needs.
3. **Never silently produce a wrong number.** When inputs are incomplete or an estimated expense is negative, flag it visibly instead of plotting it.

---

## 1. Data Model

### 1.1 Account

```ts
Account {
  id: string                  // UUID, immutable
  name: string
  type: "current" | "savings" | "broker" | "pension"
  liquidity: "liquid" | "locked"   // auto: pension → locked, others → liquid (overridable)
  color: string               // assigned at creation, stable across all charts
  createdAt: "YYYY-MM"
  archivedAt: "YYYY-MM" | null
}
```

**Archiving rules:**
- Archived accounts remain in all historical aggregates and charts up to and including `archivedAt`.
- From the month after `archivedAt`: hidden from entry forms, projections, and current-state views.
- Restore = clear `archivedAt`. Hard delete allowed only with zero snapshots, double confirmation.
- Archiving an account with a non-zero last balance triggers a warning: "Saldo finale € X — registra un trasferimento interno verso il conto di destinazione per non perdere la continuità del patrimonio."

### 1.2 MonthlySnapshot

One per account per month.

```ts
MonthlySnapshot {
  accountId: string
  yearMonth: "YYYY-MM"
  balancePayday: number              // all account types
  balancePaydayMinus1: number | null // current accounts only — used in expense calc (§2)
}
```

### 1.3 MonthlyEntry

One per month.

```ts
MonthlyEntry {
  yearMonth: "YYYY-MM"
  salaryNet: number               // net credited on payday
  extraSalary: number             // 13th/14th month, bonus — credited this month
  otherIncome: number             // refunds, sales, gifts, cashback — anything non-salary
  paydayDayOfMonth: number        // prefilled from Settings, overridable
  contributions: Contribution[]
  internalTransfers: InternalTransfer[]
  flags: string[]                 // auto-set warnings, e.g. "NEGATIVE_EXPENSES", "MISSING_SNAPSHOT"
}

Contribution {
  id: string
  accountId: string
  amount: number                  // >0 deposit, <0 withdrawal back to current account
  kind: "recurring" | "one_off"
  source: "current" | "external"  // external = e.g. employer pension contribution,
                                  // does NOT leave the current account → excluded from §2
}

InternalTransfer {
  id: string
  fromAccountId: string
  toAccountId: string
  amount: number
  note: string | null
}
```

- Multiple contributions to the same account in the same month: stored individually, displayed aggregated with expandable detail.
- Employer PME contribution (~€550/mo) is a `source: "external"` contribution to a pension account — tracked for net worth, invisible to expense logic.

### 1.4 Settings

```ts
Settings {
  defaultPaydayDayOfMonth: number
  birthDate: "YYYY-MM-DD"
  fire: FIREParams
  milestones: Milestone[]
}

FIREParams {
  monthlyExpenseFire: number        // target spending in FIRE, today's EUR
  swr: number                       // default 0.035
  realReturnBase: number            // 0.05
  realReturnOptimistic: number      // 0.07
  inflation: number                 // 0.025
  coastAge: number                  // 45
  fireAge: number                   // 55
  pensionStartAge: number           // 67 (AOW + PME)
  expectedPensionMonthly: number    // estimated PME+AOW+other at 67, today's EUR
  box3DragAnnual: number            // e.g. 0.0212 (= 5.88% × 36%), applied to liquid
                                    // taxable assets in projections from box3StartDate
  box3StartDate: "YYYY-MM"          // default 2027-05
  marginalRateBox1: number          // default 0.37 — used for lijfrente deduction card (Tab 4)
  monteCarlo: { meanReturn: number, stdDev: number, runs: 1000 }
}

Milestone {
  id: string
  date: "YYYY-MM"
  label: string                     // e.g. "Scadenza 30% ruling", "iBonds maturity"
  note: string | null
}
```

Default milestones seeded on first run: **2027-05 "Scadenza 30% ruling + Box 3"**, **2030-12 "iBonds Dec 2030 maturity — riallocare"**. Milestones render as vertical markers on all time charts and as a countdown card on the Charts tab.

### 1.5 Saved Plan (baseline for on-track check)

```ts
SavedPlan {
  createdAt: "YYYY-MM"
  startingLiquidNetWorth: number
  plannedMonthlyContribution: number
  assumedRealReturn: number
  // Generates a deterministic projection curve, frozen at save time.
}
```

The user can re-baseline at any time (old plan kept in history, max 5).

---

## 2. Derived Metrics

### 2.1 Net Worth

- **Liquid net worth** = Σ balancePayday of liquid accounts (the number used for all FIRE math).
- **Total net worth** = liquid + locked.
- Both plotted; FIRE targets compare against **liquid** only.

### 2.2 Estimated Monthly Expenses

The spending cycle runs payday(m−1) → payday−1(m). Using both current-account snapshots:

```
expenses(m) = balancePaydayMinus1_current(m−1 cycle start, i.e. balancePayday of m−1)
            + otherIncome(m)
            + Σ withdrawals credited back to current (negative contributions, abs value)
            − Σ contributions with source="current" (deposits, outgoing)
            − Σ internalTransfers out of current accounts (+ Σ transfers into current)
            − balancePaydayMinus1_current(m)
```

Simplified: **cash in − cash out − what's left = what was spent.**

- `extraSalary` lands on payday and therefore belongs to the *next* cycle's starting balance — no special handling needed; it's captured in `balancePayday`.
- If result < 0 → set flag `NEGATIVE_EXPENSES`, display "⚠ verifica entrate non registrate" instead of the number, exclude from averages.
- If any required snapshot missing → "—", flag `MISSING_SNAPSHOT`.

### 2.3 Invested Amount & Savings Rate (balance-derived)

Because the current account returns to a stable baseline each cycle, the invested amount is derived from snapshots — independent of manually entered contributions:

```
ΔCash(m)      = balancePaydayMinus1(m) − balancePaydayMinus1(m−1)   // baseline drift
invested(m)   = totalIncome(m) − expenses(m) − ΔCash(m)
savingsRate(m)= invested(m) / totalIncome(m)
  where totalIncome = salaryNet + extraSalary + otherIncome
```

Displayed monthly + rolling 12-month. **Headline metric.**

**Reconciliation check:** manually entered contributions (source="current") are compared against `invested(m)`. If `|Σ contributions − invested| > €50` → flag `RECONCILE_MISMATCH`, shown as ⚠ "Discrepanza € X — contributo non registrato o entrata mancante?". This turns redundant manual entry into a data-quality check. Mid-month contributions entered late (in the next month's session) don't corrupt expense math — it's balance-based — they only surface here until registered.

Manual contributions remain required for **per-account attribution** (where the money went) and the market-growth decomposition (§2.4).

### 2.4 Market Growth vs Contributions

For each non-current account:

```
marketGrowth(m) = balancePayday(m) − balancePayday(m−1) − netContributions(m) − netTransfers(m)
```

Aggregated across portfolio: answers "how much did the market do for me vs how much did I save?" Cumulative view: stacked area of (cumulative contributions) + (cumulative market growth) = net worth.

### 2.5 Annualized Personal Return (approximate)

Simple Dietz per calendar year on the broker aggregate:
`return ≈ marketGrowth_year / (startBalance + netContributions_year / 2)`.
Label clearly as approximation.

---

## 3. Tabs

### Tab 1 — Andamento (Charts)

1. **Patrimonio nel tempo** — liquid net worth (solid) + total incl. pensions (dashed), cumulative contributions line, FIRE number and Coast FIRE number horizontal lines, milestone vertical markers.
2. **Contributi vs Mercato** — stacked area: cumulative contributions + cumulative market growth.
3. **Crescita mensile** — bar chart, Δ liquid net worth per month, green/red. Tooltip splits contribution vs market.
4. **Savings rate** — line, monthly + 12-month rolling average.
5. **Spese stimate** — line + 3-month rolling avg; flagged months shown as hollow points.
6. **Allocazione** — stacked area per account; toggle "mostra conti archiviati" (default off for current state, archived always included historically).
7. **Countdown card** — next milestone with months remaining.

### Tab 2 — Storico (Overview)

Monthly table, newest first:

| Mese | Patrimonio liquido | Δ mese | Δ % | Contributi | Mercato | Spese stimate | Savings rate |
|---|---|---|---|---|---|---|---|

- Row click → account-level breakdown + entry detail for that month.
- Annual rollup rows (bold, auto-inserted at year boundaries): totals + YoY %.
- Cells with flags show ⚠ with tooltip.
- "+" button per month → entry form (§4).

### Tab 3 — FIRE

**3.1 FIRE Number**
- Itemised monthly expense rows (add/remove), auto-sum.
- SWR selector (3% / 3.5% / 4%), 3.5% default. One result card, others as small print.
- **Pension offset:** FIRE number is computed in two phases —
  - capital needed to cover spending from fireAge → pensionStartAge (full expenses),
  - plus capital for pensionStartAge+ covering only `expenses − expectedPensionMonthly`.
  - Both a simple version (expenses × 12 / SWR) and the two-phase version displayed, with the difference highlighted: "Le pensioni riducono il tuo fabbisogno di € X."

**3.2 Coast FIRE**
- Auto-filled current liquid net worth (editable), age (auto), coastAge, fireAge, both return scenarios side by side (5% / 7%).
- Output: Coast number at coastAge, gap today, and "se smetti di contribuire oggi, a che età arrivi al FIRE number?"

**3.3 On-track check (vs Saved Plan)**
- Chart: actual liquid net worth vs frozen plan projection.
- Card: ahead/behind in € and months. "Sei 4 mesi avanti rispetto al piano salvato a gennaio 2026."
- Button: re-baseline.

**3.4 Proiezione & Anni al FIRE**
- Inputs: current portfolio, monthly contribution, real return, **Box 3 drag applied automatically from box3StartDate** (toggleable, shows impact in € of final capital).
- Output: FIRE arrival year at base and optimistic returns; chart with both curves + milestones.

**3.5 Monte Carlo (accumulo + decumulo)**
- Simulates the full path: from today with monthly contributions until fireAge, then withdrawals (FIRE expenses, inflation-adjusted) until age 90. Pension income added from pensionStartAge.
- Normal-distribution annual returns (Box-Muller), 1,000 runs, client-side, with a "metodo semplificato" disclaimer.
- Output: success probability, fan chart (P10/P25/P50/P75/P90), median age at FIRE-number crossing, distribution of failure ages.

**3.6 Scenario rapido (what-if)**
- Three sliders, instant recompute of 3.4: monthly contribution (0–4.000), real return (3–8%), FIRE expenses (1.500–3.500).
- Answers "se investo 1.000 invece di 2.000?" without touching saved settings.
- One-off expense simulator: "spesa una tantum di € X oggi → FIRE ritarda di Y mesi."

### Tab 4 — Pensioni

Dedicated view for locked (pillar 2/3) assets — excluded from FIRE-before-67 math but tracked in full.

1. **Totale montante** — line chart: sum of all pension accounts over time (PME, lijfrente Meesman, fondo Generali), one line per fund + total.
2. **Contributi cumulativi** — stacked area per fund: employer contributions (source="external") vs personal contributions (lijfrente, source="current"), so the split "quanto ci metto io vs il datore" is always visible.
3. **Tabella mensile:**

| Mese | PME | Lijfrente | Generali | Totale | Δ mese | Contributi del mese |
|---|---|---|---|---|---|---|

4. **Card riepilogo:** totale a oggi, contributo medio mensile (12m), proiezione a pensionStartAge al rendimento base — alimenta `expectedPensionMonthly` nel FIRE a due fasi (Tab 3) con un pulsante "usa questa stima".
5. **Deduzione fiscale lijfrente:** per i contributi personali lijfrente dell'anno corrente, card "Deduzione Box 1 stimata: € X × aliquota marginale (configurabile, default 37%)" — promemoria del beneficio fiscale, non consulenza.

### Tab 5 — Impostazioni (Settings)

- **Conti:** list with type/liquidity badge, status, color swatch (editable). Add / archive (with balance warning §1.1) / restore / delete.
- **Parametri:** payday default, birth date, all FIREParams with sensible defaults pre-filled.
- **Milestone:** CRUD list.
- **Dati:** export JSON (versioned, pretty, `financial-dashboard-YYYY-MM-DD.json`), import with schema validation + preview diff (counts of accounts/months added/changed) before commit, "cancella tutto" gated by typing CONFERMA.

---

## 4. Monthly Entry Form

Single page (modal on desktop, full screen on mobile), sections in order — not a wizard:

1. **Entrate:** stipendio netto, extra (13ª/14ª/bonus), altre entrate. Payday override.
2. **Conto corrente:** saldo giorno−1, saldo giorno stipendio.
3. **Saldi conti:** one input per active liquid account + pension accounts (collapsible "Pensioni" group).
4. **Contributi:** rows of {account, amount, recurring/one-off, source}. "+ Aggiungi" per multiple to same account. Previous month's recurring contributions shown as ghost text placeholders (NOT auto-inserted — one tap to copy).
5. **Trasferimenti interni:** from → to → amount.
6. **Riepilogo live** (sticky footer): patrimonio del mese, Δ vs mese precedente, spese stimate calcolate in tempo reale, eventuali ⚠.

Save validates: every active account has a balance (or explicit "salta questo mese" per account → flag).

---

## 5. UX & Technical Constraints

- Single HTML file, Chart.js CDN only, no build, no API calls.
- localStorage key `fd_data_v2`, `schemaVersion: 2` in every export. On quota error: block save, force export prompt.
- Migration: importer accepts schemaVersion 1 and maps it (balancePaydayMinus1 preserved, contributions get `source: "current"` default).
- IT locale formatting (`€ 1.234,56`), Italian month names, Italian UI copy throughout.
- Mobile: bottom tab nav (5 tabs, icon + short label); desktop: top nav. Charts responsive, legends collapsible on mobile.
- Colors: positive `#2ecc71`, negative `#e74c3c`; account colors from a 12-color qualitative palette, persisted per account.
- Accessibility: Escape closes modals, focus trap, visible focus rings, prefers-reduced-motion respected.
- Empty states with explicit CTA ("Nessun dato — inserisci il primo mese").

---

## 6. Out of Scope (v1)

- Broker/bank APIs, multi-currency, cloud sync, multi-user.
- PDF/Excel export (JSON only).
- Auto-inserted recurring contributions (ghost-text copy only).
- Historical-returns Monte Carlo (normal distribution only).
- Per-ETF holdings tracking (account-level only). Candidate for v2.
