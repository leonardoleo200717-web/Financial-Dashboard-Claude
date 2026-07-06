# FinanceV1 — Personal Finance & FIRE Dashboard: Generation Spec

> **Purpose of this file.** This is a self-contained, implementation-ready
> specification for an LLM to (re)generate a personal-finance + FIRE dashboard.
> Feed it as the primary context. It defines *what* to build, the *exact math*,
> the *invariants that must hold*, the *test plan*, and a *build recipe*. It is
> derived from a working, fully-tested reference implementation (~280 tests,
> 3,589 assertions). Follow the MUST/SHOULD language literally; the "MUST" items
> encode real bugs that were found and fixed — do not regress them.

---

## HOW TO USE THIS FILE (instructions to the generating AI)

1. Build in the order given in **§13 Build Recipe**. Ship the deterministic
   engine + tests first; add UI; add AI features last.
2. The **engine is the single source of truth** for every number. UI never
   computes financial values. AI never computes numbers (§9).
3. Treat every `INVARIANT:` line as a test you must write and pass.
4. Keep it a **single self-contained HTML file** at runtime (one dev-side
   concatenation step is allowed; see §1).
5. Language of the UI: Italian (copy examples are Italian). Currency: EUR only.
   All money formatted `€ 1.234,56` (it-IT). This is trivially localizable.
6. When a requirement conflicts with a framework's convention, follow this spec
   and note the deviation.

---

## 0. DESIGN PRINCIPLES (non-negotiable)

- **P1 — Snapshots are truth, flows are annotations.** User-entered account
  *balances* are ground truth. Salary/contributions/transfers annotate a month
  and enable derived metrics. Missing flows → balance views still work; derived
  metrics show `—`/a flag, never a wrong number.
- **P2 — Never silently produce a wrong number.** Incomplete input → visible
  flag, value excluded from averages. Wrong-but-flagged beats plausible-but-wrong.
- **P3 — Liquid vs locked are separate worlds.** Pensions are tracked but
  excluded from FIRE-before-pension math; they form a second pillar reducing
  post-pension spending (two-phase FIRE number, §3.6).
- **P4 — The AI never does arithmetic.** Models only (a) parse free text into
  structured parameter changes, and (b) give qualitative analysis. Every shown
  figure comes from the deterministic engine.
- **P5 — Pure, testable engine.** All calculations live in a DOM-free module
  shared *verbatim* between the shipped HTML and the Node test harness.
- **P6 — Real euros in the simulator.** Per-class returns are *real*; spend and
  pension income are in today's purchasing power.
- **P7 — Not financial/tax advice.** Persistent disclaimers; recency-sensitive
  tax items flagged, never asserted as current law.
- **P8 — Local-first & private.** All data in `localStorage`. Secrets (API keys)
  never leave the browser and never enter exports (§9.3). User strings are
  HTML-escaped everywhere (§8).

---

## 1. ARCHITECTURE & BUILD

- **Deliverable:** one `index.html`, self-contained, opens from disk. Only
  external runtime dependency: Chart.js via CDN.
- **Dev-side layout (no runtime build):**
  - `engine.js` — pure, DOM-free, `module.exports` + `root.Engine` (UMD-ish).
  - `app.js` — UI layer; depends on global `Engine` + `Chart`.
  - `shell.head.html` — HTML skeleton + CSS with `/*<<ENGINE>>*/` and
    `/*<<APP>>*/` injection markers.
  - `build.js` — concatenates the three into `index.html`.
- **INVARIANT (integrity test):** the engine source appears **byte-identical**
  inside the built `index.html`. A test asserts this.
- Node scripts run the tests; `jsdom` is the only dev dependency.

---

## 2. DATA MODEL (localStorage key `fd_data_v2`, `schemaVersion: 2`)

All extensions are **additive & migration-safe**: on load, `normalize()` fills
missing fields with defaults; a v1 importer maps old data (defaulting
contribution `source` to `"current"`). Every export includes `schemaVersion`.

```ts
Data {
  schemaVersion: 2
  accounts: Account[]
  snapshots: { [ "accountId|YYYY-MM" ]: MonthlySnapshot }
  entries:   { [ "YYYY-MM" ]: MonthlyEntry }
  plans: SavedPlan[]
  settings: Settings
  fireSim?: FireSim        // §6, seeded lazily
  taxAssist?: { history: TaxTurn[] }
}

Account {
  id: string                       // UUID, immutable
  name: string                     // MUST be HTML-escaped on render (XSS)
  type: "current"|"savings"|"broker"|"pension"
  liquidity: "liquid"|"locked"     // auto: pension→locked (overridable)
  includeInFire?: boolean          // FIRE-capital membership; default type==="broker".
                                   // Pensions can NEVER be included.
  iban?: string                    // for statement import auto-transfer detection (§4)
  estimateFromContributions?: boolean  // pots w/o statements (e.g. PME) — §6.4
  assumedAnnualReturn?: number     // used by the estimate (default 0.03 real)
  color: string
  createdAt: "YYYY-MM"
  archivedAt: "YYYY-MM" | null
}

MonthlySnapshot {                  // one per account per month
  accountId, yearMonth,
  balancePayday: number,           // all types
  balancePaydayMinus1: number|null // current accounts only (expense calc §3.2)
}

MonthlyEntry {                     // one per month
  yearMonth, salaryNet, extraSalary, otherIncome, paydayDayOfMonth,
  expensesActual?: number,         // bank-statement truth; overrides the estimate (§4.4)
  contributions: {
    id, accountId, amount /* <0 = withdrawal back to current */,
    kind: "recurring"|"one_off",
    source: "current"|"external"   // external never touched the current account
                                   // → excluded from expense math
  }[],
  internalTransfers: { id, fromAccountId, toAccountId, amount, note }[],
  flags: string[]                  // NEGATIVE_EXPENSES | MISSING_SNAPSHOT | ...
}

Settings {
  defaultPaydayDayOfMonth, birthDate,
  fire: {
    monthlyExpenseFire, swr /*0.035*/, realReturnBase /*0.05*/,
    realReturnOptimistic /*0.07*/, inflation /*0.025*/,
    coastAge /*45*/, fireAge /*55*/, pensionStartAge /*67*/,
    expectedPensionMonthly, box3DragAnnual /*e.g. 0.0212*/, box3StartDate,
    marginalRateBox1 /*0.37*/,
    monteCarlo: { meanReturn, stdDev, runs /*1000*/ }   // editable in Settings
  },
  milestones: { id, date:"YYYY-MM", label, note }[],
  ai: { provider, baseUrl, apiKey, model }    // §9; apiKey NEVER leaves browser
}

SavedPlan { createdAt, startingLiquidNetWorth, plannedMonthlyContribution, assumedRealReturn }
```

---

## 3. DERIVED METRICS — exact formulas & invariants (engine)

All amounts rounded to cents (`r2`). Use a `ymPrev/ymNext/monthsBetween/ageAt`
helper set. No `Date.now()`/`Math.random()` in the engine (breaks determinism).

### 3.1 Net worth & FIRE capital
- **liquidNetWorth(ym)** = Σ `balancePayday` of liquid accounts with a snapshot.
- **lockedNetWorth(ym)** = Σ of locked (pension) accounts.
- **totalNetWorth** = liquid + locked.
- **fireCapital(ym)** = Σ over liquid accounts where `includeInFire`
  (default: brokers only). *Idle cash/savings MUST NOT be projected at market
  returns.* This is the base for ALL FIRE math. The UI always lists which
  accounts are included.
- **INVARIANT:** a pension is never in `fireCapital`, even if `includeInFire=true`.

### 3.2 Estimated monthly expenses (cycle: payday(m−1) → payday−1(m))
If `entry.expensesActual` is set (from statement import, §4) → use it verbatim
with an informational `ACTUAL` flag. Otherwise the residual estimate:
```
expenses(m) = balancePayday_current(m−1)
            + otherIncome(m)
            + Σ |withdrawals back to current| (negative contributions source=current)
            − Σ deposits from current (positive contributions source=current)
            − (transfers out of current − transfers into current)   // curr↔curr nets 0
            − balancePaydayMinus1_current(m)
```
- result < 0 → flag `NEGATIVE_EXPENSES`, show "⚠ verifica entrate", **exclude
  from all averages**.
- any required current snapshot missing → `—`, flag `MISSING_SNAPSHOT`.
- `extraSalary` lands on payday → belongs to the next cycle automatically.
- **INVARIANT:** a pure internal transfer (curr↔curr or curr↔broker) changes
  neither expenses nor net worth. The 3-month rolling average MUST skip flagged
  months (spec compliance; hollow points still drawn).

### 3.3 Invested amount & savings rate (headline metric)
```
ΔCash(m)       = balancePaydayMinus1(m) − balancePaydayMinus1(m−1)
totalIncome(m) = salaryNet + extraSalary + otherIncome
invested(m)    = totalIncome(m) − expenses(m) − ΔCash(m)
savingsRate(m) = invested(m) / totalIncome(m)      // null when income = 0
```
Display monthly + rolling 12-month.

### 3.4 Reconciliation (data-quality flag — the exact design matters)
```
registered(m) = Σ contributions(source="current", signed)
              + net internal transfers OUT of current accounts
salaryDelta(m)= (salaryNet+extraSalary)(m) − (…)(m−1)
diff(m)       = registered(m) + salaryDelta(m) − invested(m)
mismatch ⟺ |diff| > €50 ; if either month's entry missing → no flag
```
Rationale (learned the hard way): funding a broker via a *transfer* is a
registered flow (not a problem); and without the salary-delta term the flag
merely tracks salary variation and fires on most months.
- **INVARIANT:** on a fully-registered, internally-consistent history, `diff≈0`
  and `mismatch` is **never** true.

### 3.5 Contribution default for projections
Use the **median** monthly `invested` over the trailing 12 computable months
(robust to one-off lumps); fall back to mean, then a constant. Always presented
as an **editable assumption**, never silently.

### 3.6 FIRE numbers
- Simple: `monthlyExpenseFire × 12 / swr`.
- **Two-phase (pension-aware):** annuity-PV of full expenses fireAge→pensionAge
  at `realReturnBase`, plus `(expenses − pension)/swr` discounted back to
  fireAge. **The two-phase number is the primary target everywhere a single
  target appears** (headline, Coast, projection, net-worth chart line); the
  simple number stays visible.

### 3.7 Coast FIRE
`coastFire(fire, currentCapital, currentAge, realReturn, targetNumber?)`:
- `requiredToday = target / (1+r)^max(0, fireAge−age)`
- `ageIfStopNow = age + ln(target/capital)/ln(1+r)` — **guard `r ≤ 0` → null**
  (never Infinity/NaN); if `capital ≥ target` → `age`.
- coasting ⟺ `capital ≥ requiredToday`. Default target = two-phase number.

### 3.8 Market growth & personal return
- Per non-current account: `marketGrowth(m) = Δ balancePayday − net contributions
  − net transfers`.
- Annualized personal return per year (Simple Dietz, labeled *approximate*):
  `marketGrowth_yr / (startBalance + netFlows_yr/2)` over FIRE-capital accounts;
  if no prior-December balance, baseline from the first in-year month.

---

## 4. STATEMENT IMPORT (bank/broker automation) — engine + wizard

Goal: replace manual entry and the *residual* expense estimate with **bank
truth**. A local single HTML file cannot call bank APIs (CORS + PSD2 auth), so
v1 uses **file import** of exports the user already downloads. Parsers are pure
engine functions; the wizard maps accounts and previews before applying.

### 4.1 Sources & formats (as observed on real files)
- **ABN AMRO** — download **TXT (TAB-separated)** [binary `.xls` is not
  parseable in-browser]. 8 columns, no header guaranteed:
  `accountNumber, mutationcode, transactiondate(YYYYMMDD), valuedate,
  startsaldo, endsaldo, amount, description`. Counterparty IBAN is inside
  `description` (`... IBAN: NL..ABNA0123456789 ...`, uppercase, unspaced).
- **Scalable Capital** — Broker Transactions **CSV**, `;`-separated, decimal
  comma, header:
  `date;time;status;reference;description;assetType;type;isin;shares;price;amount;fee;tax;currency`.
  Relevant: `assetType∈{Security,Cash}`, `type∈{Buy,Sell,Savings plan,Deposit,
  Withdrawal,Cash Transfer Out,Fee,Interest,Distribution,…}`, `status` filter
  `=="Executed"`.
- **Interactive Brokers (future):** Flex Query CSV/XML — has real API tokens,
  the most automatable (§11).

### 4.2 Parser contracts (pure)
```
parseAmount("1.234,56"|"1234.56"|num) → number
parseABNStatement(text) → [{account, date, ym, start, end, amount, description, counterIban}]  // sorted asc
parseScalableCSV(text)  → [{date, ym, status, description, assetType, type, isin, amount, fee}] // Executed only, asc
```
- IBAN regex MUST be uppercase-only (`/IBAN[:\s]*([A-Z]{2}\d{2}[A-Z0-9]{6,30})/`)
  so it doesn't swallow the following lowercase word.

### 4.3 Monthly digest
`abnMonthlyDigest(rows, {paydayDay, ownIbans:{IBAN→accountId}})` → per `ym`:
- `balancePayday` = endsaldo of last row ≤ payday date; `balancePaydayMinus1`
  = endsaldo of last row ≤ (payday−1 day).
- `salary` = largest **non-own** credit within `[payday−3, payday+1]`
  (heuristic; always user-editable in the preview).
- `transfers` = rows whose counter-IBAN ∈ `ownIbans` → internal transfers to the
  mapped account (direction from amount sign).
- `actualExpenses` = Σ debits in `[payday(m−1), payday(m)−1]` **excluding**
  transfers to own IBANs. First month is `partial` (cycle starts before window).
`scalableMonthlyDigest(rows)` → per `ym`: `{deposits, withdrawals, fees,
interest, dividends}` (corroborates contributions; ABN is authoritative for
transfers to avoid double counting).

### 4.4 Apply (additive; existing manual values win unless `overwrite`)
`applyAbnDigest(data, digest, currentAccountId, {overwrite})` writes snapshots,
`salaryNet`, `otherIncome`, **`entry.expensesActual`** (skips `partial` months),
and dedups internal transfers by `month+amount+counterAccount`. Returns a change
log for the preview.
- **INVARIANT:** re-importing the same file is idempotent (no duplicate
  transfers, unchanged values unless `overwrite`).
- **INVARIANT:** when `expensesActual` is present, `estimatedExpenses` returns it
  with flag `ACTUAL` and never `NEGATIVE_EXPENSES`.
- **PRIVACY:** uploaded statements are user data — never bundle them into the
  repo/tests; tests use synthetic fixtures with the same shape.

### 4.5 Wizard UI (Impostazioni → Dati → "Importa estratto conto")
Drop file → detect format → map the statement to a current/broker account and
declare **own IBANs** (the user's other accounts incl. the two savings) → live
**preview** (months, salary guesses, detected transfers, expenses) → confirm
(replace/merge). Transfers *between the two savings accounts* are just normal
internal transfers with both endpoints among own IBANs.

---

## 5. TABS — functional requirements (7 tabs)

Nav: desktop top bar, mobile bottom bar (icon + short label). Every chart card
has an **ⓘ info button** (plain-language explanation of what it shows and how
it's computed) and a **⤢ enlarge button** (same chart in a modal; Escape closes;
config MUST survive a JSON clone → marker/annotation data is plain data, not
functions).

1. **Andamento** — net worth over time (liquid solid, total dashed, cumulative
   contributions, two-phase FIRE-number line); Contributi vs Mercato (stacked
   cumulative); Crescita mensile (bars; tooltip splits into *mercato + apporti
   netti* that **sum exactly to the bar**); Savings rate (monthly + 12m);
   Spese stimate (line + 3m rolling that skips flagged months; flagged months
   as hollow/cross points); Allocazione (stacked area per account, archived
   toggle); milestone countdown card. **Milestones render as dashed vertical
   markers + labels on all six time charts** (Chart.js plugin; guard
   registration so a stub without `Chart.register` doesn't crash).
2. **Storico** — monthly table newest-first (Mese | Patrimonio liquido | Δ mese
   | Δ% | Contributi | Mercato | Spese stimate | Savings rate | modifica);
   **bold annual rollup rows** (end-of-year net worth, Δ anno + YoY%, summed
   contributi/mercato, expenses over unflagged months, mean savings rate); row
   click → account breakdown + entry detail; ⚠ on flags.
3. **FIRE** — headline "A che punto sei" (FIRE capital, two-phase number,
   arrival year/age at median pace, progress bar, Coast status); 3.1 FIRE
   number (simple + two-phase + "le pensioni riducono di €X"; SWR chips
   3/3.5/4%); 3.2 **Coast FIRE (pension-aware)** with crisp yes/no + gap +
   "stop today → FIRE at age X" + **crossover chart**; 3.3 on-track vs saved
   plan in **€ and months** + re-baseline; 3.4 projection (editable capital +
   monthly contribution with median default, Box 3 drag toggle, base+optimistic
   curves, arrival years); 3.5 Monte Carlo (§6.3); 3.6 what-if sliders +
   one-off-expense simulator; 3.7 personal return per year vs assumed.
   Placeholder birth-date warning banner until set.
4. **Pensioni** — pots over time (per fund + total; PME may be
   estimate-from-contributions, §6.4, clearly labeled *stima*); employer vs
   personal cumulative split; monthly table; projection to pension age feeding
   `expectedPensionMonthly`; **lijfrente deduction/planner** (§6.5).
5. **Simulatore** — deterministic asset-class engine (§6) + AI "E se…" + crisis
   stress test (§6.6) + "Mostra i numeri" table behind every chart. Persistent
   disclaimer.
6. **Tasse** — 3-agent ensemble (§9.5) + deterministic facts panel + persistent
   "non è consulenza fiscale" disclaimer.
7. **Impostazioni** — accounts (**add/remove brokers & any account**: create
   with type/name; archive/restore; hard-delete only with zero snapshots +
   double confirm; per-liquid-account FIRE checkbox; color; IBAN), all
   parameters (incl. Monte Carlo mean/σ), milestones CRUD, Dati (export /
   import-replace / import-merge / statement import / demo / wipe gated by typing
   CONFERMA), **AI / Modelli** provider card (§9).

### Monthly entry form (modal desktop / full-screen mobile)
Sections: Entrate (with **salary auto-suggest** = Σ payday − Σ day-before of
current accounts) · Conto corrente (both balances) · Saldi conti (**carry-forward
prefill of last month's balances for a NEW month — ACTIVE accounts only;
archived balances MUST never be silently written**) · Contributi (**ghost text
of last month's recurring ones, one-tap copy, never auto-inserted**) ·
Trasferimenti interni · **live sticky footer** (net worth, Δ, real-time expenses,
⚠). Save validates every active liquid account has a balance (explicit skip → flag).

---

## 6. SIMULATION METHODOLOGY (each rule encodes a real bug — do not regress)

### 6.1 FireSim data (`fireSim`, seeded lazily on first Simulatore open)
```
classes: { id, name, value, realReturn, volatility, kind:"liquid"|"pension" }[]
profile: { currentAge/*from birthDate*/, retirementAge/*fire.fireAge*/,
           statePensionAge/*fire.pensionStartAge — ONE source of truth*/,
           endAge/*90*/, annualContribution/*median invested ×12*/,
           annualSpend/*monthlyExpenseFire×12*/, statePensionAnnual,
           shock:{enabled, atAge, severity} }
```
Seeding maps current accounts → classes (brokers split by default weights;
cash = current+savings; pension classes = locked totals).

### 6.2 Deterministic projection (real €)
Year-by-year to `endAge`: grow each class at its real return; accumulation adds
`annualContribution` allocated across liquid classes by weight; decumulation
withdraws from liquid classes by weight; **pension pots grow but are never
drawn** (second pillar); from `statePensionAge`, `statePensionAnnual` reduces the
withdrawal need; model the **retirement→state-pension gap** explicitly. Outputs:
survives/depletion age, per-year table.
- **INVARIANT (conservation):** with 0% returns, `liquid(y) = liquid(y−1) +
  contribution − withdrawal` exactly.

### 6.3 Monte Carlo — two rules that MUST hold
1. **Draw the annual return once per 12 months**, apply monthly. Redrawing an
   annual-σ return every month collapses realized annual volatility to `σ/√12`
   (~4.4% for σ=15%) and overstates success. **TEST:** fan P90/P10 after 20y at
   σ=15% MUST exceed ~3.5.
2. **Classes share one market factor per year:** `return_c = mean_c + vol_c·z`,
   one `z~N(0,1)` per year. Independent per-class draws grant diversification
   correlated equities don't have (95% vs 70% success for the same money).
   **TEST:** a portfolio split into n identical classes scores exactly the same
   as one block.
Outputs: success probability, P10/P50/P90 fan, median crossing age. Seeded &
reproducible (`mulberry32` + Box-Muller). Params editable in Settings.

### 6.4 Pension pot without statements (e.g. ASML PME)
`account.estimateFromContributions = true`: for months with no snapshot, the
balance is **estimated** = registered contributions compounded monthly at
`assumedAnnualReturn` (default 0.03 real). A real snapshot always wins; the UI
labels it *stima*. Lets a pot with unknown balance still contribute to net worth
and the pension projection.

### 6.5 Lijfrente planner (NL Box 1 deduction + Box 3 reduction)
`lijfrentePlan(fire, annualContribution)` → `{ box1Refund = contrib ×
marginalRateBox1, box3AnnualSaving = contrib × box3DragAnnual, firstYearBenefit,
netCost = contrib − box1Refund, box3SavingAfterYears(n) = contrib × n × drag }`.
Purely deterministic. **The jaarruimte (deductible room) depends on income and
pension accrual and MUST be user-entered/verified with the Belastingdienst** —
this is a reminder, not advice. Wire a new lijfrente account (broker/pension
type) as a normal add-account; the planner reads its current-year personal
contributions.

### 6.6 Crisis stress test
`profile.shock={enabled, atAge, severity}` applied in **all three** paths
(deterministic, coast-age search, Monte Carlo). Class hit ∝ volatility:
`multiplier = max(0.2, 1 − severity·vol/0.16)` (equity ref 16%; cash barely
moves). Recovery is ordinary compounding — which makes a crash at retirement
(sequence-of-returns risk) far worse than mid-career; UI copy says so. A
dedicated card overlays crisis-vs-no-crisis and can apply the shock to the main
scenario. The AI what-if can set `shock` too.

---

## 7. FIRE ENGINE FUNCTION INDEX (names the tests reference)

`fireNumberSimple, fireNumberTwoPhase, coastFire(…, targetNumber?), project,
monteCarlo (§3.5 tab), simulateFireDeterministic, coastFireAge, monteCarloFire,
fireClassTotals, medianInvested, trailingInvested, personalReturn,
estimatedPensionBalance, lijfrentePlan, parseABNStatement, parseScalableCSV,
abnMonthlyDigest, scalableMonthlyDigest, applyAbnDigest, mulberry32`.

---

## 8. UX & TECHNICAL CONSTRAINTS

- Single HTML file; Chart.js CDN only; jsdom dev-only.
- IT locale (`Intl`, Italian month names/copy). Positive `#2ecc71`, negative
  `#e74c3c`; 12-color account palette persisted per account.
- **Escape every user string rendered via `innerHTML`** (account names!) — this
  was a real XSS hole. Prefer `textContent`; when using template HTML, run an
  `escapeHtml`.
- `localStorage` quota error → block save, force export prompt.
- Accessibility: Escape closes modals, focus rings, `prefers-reduced-motion`.
  Empty states with CTA. Charts responsive; wide content scrolls in its own
  container; page body never scrolls horizontally.

---

## 9. AI LAYER

### 9.1 Provider abstraction — `callModel(role, {system, messages, tools})`
Two request shapes, selected by `settings.ai.provider`:
- **Anthropic** Messages API (`x-api-key`, `anthropic-version`,
  `anthropic-dangerous-direct-browser-access: true`); keyless `artifact` default
  works inside Claude Artifacts.
- **OpenAI-compatible** `/chat/completions` (`Authorization: Bearer`) — OpenAI,
  DeepSeek, Groq, OpenRouter, Together, **local Ollama/LM Studio** (no key,
  offline).
Presets auto-fill baseUrl + model; a role→model map (fast model to parse, strong
model to review/reconcile) is used when no explicit model is set. A "Prova
connessione" button.

### 9.2 Robustness
Strip code fences; `try/catch` JSON; per-call error handling; an AI failure MUST
never block the UI — deterministic features keep working and a clear "AI non
disponibile" state shows. No HTML `<form>`; onClick only.

### 9.3 Key hygiene (hard rules)
- Key only in `localStorage`, never in code.
- **Export blanks the key** (redaction MUST NOT mutate live state).
- **Import never accepts a key from a file**; the browser's existing key wins.
- **INVARIANT (test):** exported JSON never contains the key string.

### 9.4 Simulatore what-if contract
System prompt: JSON only, no prose/fences. Schema:
`{"intent","paramChanges":{retirementAge?,statePensionAge?,endAge?,
annualContribution?,annualSpend?,statePensionAnnual?,classReturns?:{classId:dec},
shock?:{enabled,atAge,severity}},"assumptionsTouched":[…],"explanationRequest"}`.
Apply to a **copy** → engine recomputes → **narration generated deterministically
from engine output** (guarantees no invented figures). Compare-to-baseline
overlay + changed-assumptions list.

### 9.5 Tasse ensemble (`callAgent(role, context)`, structured JSON hand-off)
Optimizer `{proposals:[{id,title,rationale,assumptions,recencySensitive}]}` →
Compliance/Risk Reviewer (addresses each **by id**; optional web_search where
supported) `{reviews:[{id,verdict:"ok|cautela|rischioso",risks,recencyFlags,
confidence}]}` → Reconciler `{ranked:[{id,action,confidence,why}], verify:[…]}`
(verify list mandatory). **All three layers always render** so disagreement is
visible. A JS-computed **deterministic facts panel** (ruling countdown, Box 3
drag, lijfrente deduction) is passed as context; the AI doesn't recompute it.
Recency-sensitive rules (expat ruling regimes, wealth-tax reform, cross-border
pensions) are flagged, never asserted.

---

## 10. TEST PLAN (all MUST pass; framework-free Node)

`npm run test:all` builds then runs 5 suites. Counts from the reference build.

- **`tests/run.js` (engine & scenarios):** integrity (engine verbatim in HTML;
  standalone VM eval); transfer chains (bank→savings→back→broker) in one month
  and across months; broker funded by transfer vs contribution identical &
  reconcile-equal; pure transfer invariance; withdrawal-back + curr↔curr;
  flags; FIRE-capital membership (broker default, savings opt-in, pension never);
  trailing/median invested; personal return; FIRE math (simple, two-phase<simple,
  projection reaches, Box 3 lowers final, **MC fan realizes σ (P90/P10>3.5)**,
  seed-reproducible, coast custom target, **coast r≤0 → null**); simulator
  (per-year conservation, pension never drawn, depletion age, pension offset,
  coast-age extremes, **split≡block under MC**, shock: no-op at 0, reduces
  capital, vol-scaled, **crash near retirement worse**, MC success ≤ baseline);
  **statement import (synthetic fixtures): ABN parse+digest balances/salary/
  own-IBAN transfers/actual expenses; Scalable digest; applyAbnDigest idempotent;
  expensesActual overrides estimate**; ym helpers; monthly table.
- **`tests/property.js` (100 randomized histories + edge cases, ~3,589
  assertions):** a ground-truth simulator generates internally-consistent
  histories; for every month assert the engine recovers net worth/FIRE
  capital/expenses/market growth/invested/savings-rate and **reconcile diff≈0,
  never flags on consistent data**. Edge cases enumerated (empty, zero income,
  negatives, pension exclusion, curr↔curr netting, flags, Dec→Jan, archived
  dropout, annuity r=0, two-phase with pension≥expenses, negative-return
  projection, coast extremes, MC bounds+reproducibility, migration, precision).
- **`tests/ui-smoke.js` (jsdom):** all 7 tabs render; ⓘ/⤢ work; annual rollup
  rows; pension-aware Coast + crossover canvas; MC params persist; prefill +
  ghost contributions; SWR chip; MC run; FIRE toggle; edit+save; simulator seeds
  + charts + numbers table + disclaimer; **what-if degrades gracefully when
  fetch rejects**; stress test overlay + persisted shock; tax renders **all
  three agent layers even on AI failure**; AI settings persist; **callModel
  routes OpenAI-shape (Bearer, choices[]) and Anthropic-shape (x-api-key)**;
  **archived balance not written into new month**; **XSS: `<img onerror>` name
  never executes**; **export never contains the API key**; zero console errors.
- **`tests/ui-fuzz.js` (30 random datasets):** render every tab + open entry
  form; any uncaught error/`console.error` fails.
- **`tests/import-render.js`:** the real exported dataset imports & renders every
  tab with expected figures and zero console errors.

### Test meta-rules (they caught real bugs)
- Monte Carlo tests MUST include **statistical assertions** (realized vol / fan
  spread), not just bounds+reproducibility.
- Property tests validate against an **independent ground-truth simulator**, not
  the engine's own formulas re-applied.
- UI tests MUST exercise **failure modes** (fetch rejection) and **hostile input**
  (HTML in names).

---

## 11. FUTURE IMPROVEMENTS (roadmap; each is optional, additive)

**Automation & data sources**
- **IBKR Flex Query** ingestion (token + HTTPS) — cleanest true automation for
  NAV/cash snapshots; do it via a tiny local companion script emitting merge-JSON.
- **PSD2 aggregator** (e.g. GoCardless Bank Account Data free tier) → local
  script → merge-JSON. Note the privacy trade-off (data transits a third party);
  keep it opt-in and off by default.
- **Generalized statement mappings**: a small declarative format so users add a
  new bank/broker by describing columns, without code.
- **Expense categorization** from statement descriptions (rules + optional LLM
  labeling that only *tags*, never changes amounts) → spend-by-category charts.

**Modeling depth**
- **Covariance/correlation matrix** in Monte Carlo (per-class beta to the shared
  factor + idiosyncratic term) instead of full-correlation single factor — more
  realistic than either extreme.
- **Historical-returns / block-bootstrap** Monte Carlo alongside the normal one.
- **Tax-aware decumulation**: order of withdrawals (taxable vs pension vs Box 3),
  and a Box 3 optimizer that suggests lijfrente/mortgage-offset moves per tax year.
- **Currency support** (multi-currency holdings with FX) — currently EUR-only.
- **Goal tracking** beyond FIRE (house, education) with per-goal glidepaths.

**Product & safety**
- **Encrypted export** (passphrase) and optional end-to-end-encrypted cloud sync.
- **PWA/offline install**, and an import "preview diff" richer than counts.
- **Rebalancing suggestions** vs a target allocation.
- **Scenario library** (save/compare named what-ifs) and PDF/print report.
- **Undo/history** for edits; per-account notes/attachments.

---

## 12. ACCEPTANCE CHECKLIST

- [ ] Single `index.html` opens from disk; full functionality except AI (which
      degrades gracefully and works with any configured provider).
- [ ] Engine deterministic & independently verifiable ("show the numbers"
      behind every simulator chart); engine byte-identical inside the HTML.
- [ ] AI cannot change a displayed figure except via a parameter the engine
      recomputes; Tasse always renders 3 agent layers + disclaimer + verify list.
- [ ] All §10 suites green.
- [ ] No API key in any export; no unescaped user string in any `innerHTML`.
- [ ] Flags (`NEGATIVE_EXPENSES`, `MISSING_SNAPSHOT`, reconcile) fire exactly per
      §3 and never on consistent data; statement import is idempotent and
      `expensesActual` overrides the estimate.

---

## 13. BUILD RECIPE (order for the generating AI)

1. **Engine core** (§2 helpers, §3 metrics) + `tests/run.js` scenarios +
   `tests/property.js` ground-truth. Get these green first — they are the spec's
   backbone.
2. **build.js + shell + integrity test** (engine verbatim in HTML).
3. **UI shell**: nav, router, `card()/canvas()/makeChart()` with ⓘ + ⤢, IT
   formatting, escaping helper.
4. **Tabs 1–2** (Andamento, Storico) + `tests/ui-smoke.js` render checks.
5. **FIRE tab** (§3.6–3.8) with pension-aware targets + Coast crossover.
6. **Simulatore** engine (§6) + crisis + "show the numbers"; MC statistical tests.
7. **Entry form** (prefill/ghost/salary-suggest/live footer) + its UI tests.
8. **Statement import** (§4) with synthetic-fixture tests + wizard.
9. **Pensioni** (estimate-from-contributions, lijfrente planner).
10. **AI layer** (§9): provider abstraction + key hygiene tests, what-if,
    3-agent Tasse, graceful-fallback tests.
11. **Settings**, import/export/merge, fuzz + import-render suites.
12. Run `test:all`; satisfy §12.

> Out of scope for v1 (candidates in §11): bank/broker live APIs, multi-currency,
> cloud sync, PDF/Excel export, per-ETF holdings, historical-returns Monte Carlo.
