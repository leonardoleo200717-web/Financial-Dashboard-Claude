# Financial Dashboard — Complete Specification (v3, as built)

> Personal finance tracking + FIRE planning dashboard for a single user, with an
> AI FIRE simulator and a multi-agent tax assistant.
> UI language: Italian. Currency: EUR only. Data entry: manual, monthly.
> Persistence: localStorage with versioned JSON export/import.
> Deliverable: **one self-contained HTML file**, Chart.js via CDN, no build step
> at runtime. This document contains the functional requirements, software
> requirements, and the full test plan — it is sufficient to rebuild the system.

---

## 0. Design Principles (non-negotiable)

1. **Snapshots are truth, flows are annotations.** Account balances entered by
   the user are the source of truth. Salary, contributions and internal
   transfers annotate the month and enable derived metrics. If flows are
   missing, balance-based views still work; derived metrics show "—" or a ⚠
   flag rather than a wrong number.
2. **Liquid vs locked capital are separate worlds.** Pension assets are tracked
   but excluded from FIRE-before-pension math; they form a second pillar that
   reduces post-pension spending needs (two-phase FIRE number, §2.6).
3. **Never silently produce a wrong number.** Incomplete inputs → visible flag,
   value excluded from averages. Wrong beats pretty.
4. **The AI never does arithmetic.** All financial math is deterministic JS.
   Models only (a) parse free text into structured parameter changes and
   (b) provide qualitative analysis. Every figure shown comes from the engine.
5. **The engine is pure and testable.** All calculation code lives in a
   DOM-free module (`engine.js`) shared verbatim between the shipped HTML and
   the Node test harness. UI code (`app.js`) may not compute financial values.
6. **The simulator works in real (today's) euros.** Per-class returns are real
   returns; spending and pension income are in today's purchasing power.
7. **Not financial or tax advice.** Persistent disclaimers on the simulator and
   tax tabs; recency-sensitive tax items are flagged, never asserted.

---

## 1. Data Model

Storage key `fd_data_v2`, `schemaVersion: 2` in every export. All extensions
are **additive and migration-safe** (missing fields get defaults via a
`normalize()` on load; a v1 importer maps old data, defaulting contribution
`source` to `"current"`).

### 1.1 Account
```ts
Account {
  id: string                  // UUID, immutable
  name: string                // MUST be HTML-escaped wherever rendered (XSS)
  type: "current" | "savings" | "broker" | "pension"
  liquidity: "liquid" | "locked"   // auto: pension → locked (overridable)
  includeInFire?: boolean     // counts toward FIRE capital; default: type==="broker".
                              // Pensions can NEVER be included regardless of flag.
  color: string               // stable across all charts
  createdAt: "YYYY-MM"
  archivedAt: "YYYY-MM" | null
}
```
**Archiving:** archived accounts stay in historical aggregates up to and
including `archivedAt`; hidden from entry forms/projections afterwards.
Archiving with a non-zero last balance opens a modal offering to **record a
continuity transfer** to a destination account (or archive without). Hard
delete only with zero snapshots, double confirmation.

### 1.2 MonthlySnapshot — one per account per month
```ts
MonthlySnapshot {
  accountId: string
  yearMonth: "YYYY-MM"
  balancePayday: number              // all account types
  balancePaydayMinus1: number | null // current accounts only (expense calc §2.2)
}
```

### 1.3 MonthlyEntry — one per month
```ts
MonthlyEntry {
  yearMonth, salaryNet, extraSalary, otherIncome, paydayDayOfMonth,
  contributions: { id, accountId, amount /* <0 = withdrawal back */,
                   kind: "recurring"|"one_off",
                   source: "current"|"external" /* external never touched the
                   current account → excluded from expense math */ }[],
  internalTransfers: { id, fromAccountId, toAccountId, amount, note }[],
  flags: string[]   // e.g. NEGATIVE_EXPENSES, MISSING_SNAPSHOT
}
```

### 1.4 Settings
```ts
Settings {
  defaultPaydayDayOfMonth, birthDate,
  fire: {
    monthlyExpenseFire, swr /*0.035*/, realReturnBase /*0.05*/,
    realReturnOptimistic /*0.07*/, inflation /*0.025*/,
    coastAge /*45*/, fireAge /*55*/, pensionStartAge /*67*/,
    expectedPensionMonthly, box3DragAnnual /*0.0212*/, box3StartDate,
    marginalRateBox1 /*0.37*/,
    monteCarlo: { meanReturn, stdDev, runs: 1000 }   // editable in Settings UI
  },
  milestones: { id, date:"YYYY-MM", label, note }[],
  ai: { provider, baseUrl, apiKey, model }           // see §5. apiKey NEVER
                                                     // leaves the browser (§5.3)
}
```

### 1.5 SavedPlan (on-track baseline)
`{ createdAt, startingLiquidNetWorth, plannedMonthlyContribution,
assumedRealReturn }` → frozen deterministic projection curve. Re-baseline
allowed; keep max 5 historical plans.

### 1.6 fireSim (FIRE simulator, seeded lazily on first tab open)
```ts
fireSim {
  classes: { id, name, value, realReturn, volatility,
             kind: "liquid"|"pension" }[],   // e.g. US large-cap, Europe, EM,
                                             // small-cap value, EU govt bonds,
                                             // corporate bonds, cash, pensions
  profile: {
    currentAge,                 // from birthDate
    retirementAge,              // from fire.fireAge
    statePensionAge,            // from fire.pensionStartAge — ONE source of truth
    endAge /*90*/,
    annualContribution,         // seeded from MEDIAN monthly invested ×12 (§2.5)
    annualSpend,                // fire.monthlyExpenseFire × 12
    statePensionAnnual,         // fire.expectedPensionMonthly × 12
    shock: { enabled, atAge, severity }   // crisis stress test (§4.4)
  }
}
```
Seeding: liquid class values split from current FIRE capital by default
weights; cash = current+savings balances; pension classes = locked totals.

### 1.7 taxAssist
`{ history: [{ q, ts, status, proposals, reviews, reconciliation }] }` —
persisted per-tab conversation history, newest first.

---

## 2. Derived Metrics (deterministic engine — exact formulas)

### 2.1 Net worth & FIRE capital
- **Liquid net worth** = Σ `balancePayday` of liquid accounts with a snapshot.
- **Total** = liquid + locked. Both plotted.
- **FIRE capital** = Σ over liquid accounts where `includeInFire` (default:
  brokers only). Idle cash/savings must NOT be projected at market returns.
  This is the base for ALL FIRE math. The UI always lists which accounts are
  included.

### 2.2 Estimated monthly expenses (cycle: payday(m−1) → payday−1(m))
```
expenses(m) = balancePayday_current(m−1)
            + otherIncome(m)
            + Σ withdrawals back to current (|negative contributions source=current|)
            − Σ deposits from current (positive contributions source=current)
            − (transfers out of current − transfers into current)   // curr→curr nets 0
            − balancePaydayMinus1_current(m)
```
- result < 0 → flag `NEGATIVE_EXPENSES`, show "⚠ verifica entrate non
  registrate", **exclude from all averages**.
- missing snapshot → "—" + `MISSING_SNAPSHOT`.
- `extraSalary` lands on payday → belongs to the next cycle automatically.
- Rolling 3-month average must skip flagged months (hollow points still drawn).

### 2.3 Invested amount & savings rate (balance-derived, headline metric)
```
ΔCash(m)      = balancePaydayMinus1(m) − balancePaydayMinus1(m−1)
invested(m)   = totalIncome(m) − expenses(m) − ΔCash(m)
savingsRate(m)= invested(m) / totalIncome(m)      // null when income = 0
```
Displayed monthly + rolling 12-month. Known artifact (accepted): because income
is credited at cycle end, `invested(m)` embeds the month-over-month income
delta; documenting this matters because it drives §2.4's design.

### 2.4 Reconciliation (data-quality check — the exact design matters)
```
registered(m) = Σ contributions(source="current", signed)
              + net internal transfers out of current accounts
diff(m)       = registered(m) + salaryDelta(m) − invested(m)
  where salaryDelta(m) = (salaryNet+extraSalary)(m) − (salaryNet+extraSalary)(m−1)
mismatch ⟺ |diff| > €50 ; if either month's entry is missing → no flag (don't guess)
```
Rationale (learned the hard way): (a) funding a broker via a *transfer* is a
registered flow, not a data problem; (b) without the salary-delta adjustment
the flag simply measures salary variation and fires on most months (observed:
13/17 → 0/17 after the fix). **Invariant: a fully-registered, internally
consistent history NEVER flags.**

### 2.5 Contribution defaults for projections
Use the **median** monthly invested over the trailing 12 computable months
(robust to one-off lumps), fall back to mean, then to a constant. Always shown
as an *editable assumption*, never silently.

### 2.6 FIRE numbers
- Simple: `monthlyExpenseFire × 12 / swr`.
- **Two-phase** (pension-aware): capital for full expenses fireAge→pensionStartAge
  (annuity PV at `realReturnBase`) + capital for `(expenses − pension)/swr`
  discounted back to fireAge. Show both; **the two-phase number is the primary
  target everywhere a single target appears** (headline, Coast, projection,
  net-worth chart line) with the simple number visible alongside.

### 2.7 Market growth & personal return
- Per non-current account:
  `marketGrowth(m) = Δ balancePayday − net contributions − net transfers`.
- Annualized personal return per calendar year (Simple Dietz, labeled
  approximate): `marketGrowth_yr / (startBalance + netFlows_yr/2)` over the
  FIRE-capital accounts; if no prior-December balance exists, use the first
  in-year month as baseline and measure from there.

---

## 3. Tabs — Functional Requirements

Seven tabs. Desktop: top nav. Mobile: bottom tab bar (icon + short label).
Every chart card has an **ⓘ info button** toggling a plain-Italian explanation
of what the chart shows and how it's computed, and an **⤢ enlarge button**
opening the same chart in a large modal (Escape closes; config must survive a
JSON clone, so marker/annotation data must be plain data, not functions).

### Tab 1 — Andamento
1. Patrimonio nel tempo (liquid solid, total dashed, cumulative contributions,
   two-phase FIRE-number line). 2. Contributi vs Mercato (stacked cumulative).
3. Crescita mensile (bars; tooltip decomposes into *mercato + apporti netti*
   **that sum exactly to the bar**). 4. Savings rate (monthly + 12m rolling).
5. Spese stimate (line + 3m rolling that skips flagged months; flagged months
   as hollow/cross points). 6. Allocazione (stacked area per account, archived
   toggle). 7. Countdown card to next milestone.
**Milestones render as dashed vertical markers with labels on all six time
charts** (Chart.js plugin; guard registration so a test stub without
`Chart.register` doesn't crash).

### Tab 2 — Storico
Monthly table, newest first: Mese | Patrimonio liquido | Δ mese | Δ % |
Contributi | Mercato | Spese stimate | Savings rate | (modifica).
- **Bold annual rollup rows** at year boundaries: end-of-year net worth,
  Δ anno + YoY %, summed contributi/mercato, expenses over unflagged months,
  mean savings rate.
- Row click → account-level breakdown + entry detail. ⚠ with tooltip on flags.

### Tab 3 — FIRE
- **Headline "A che punto sei"**: FIRE capital, two-phase FIRE number,
  estimated arrival year/age at the median pace, progress bar, Coast status.
- 3.1 FIRE number: simple + two-phase + "le pensioni riducono il fabbisogno di
  €X"; SWR chips 3/3.5/4%.
- 3.2 **Coast FIRE (pension-aware)**: targets the two-phase number; crisp
  yes/no + gap + "stop today → FIRE at age X"; **crossover chart** (capital
  compounding with zero further contributions at base & optimistic returns vs
  target line). Guard: with real return ≤ 0, `ageIfStopNow` is null, never
  Infinity/NaN.
- 3.3 On-track vs saved plan: ahead/behind in **€ and months**, chart, re-baseline.
- 3.4 Projection: editable capital + monthly contribution (median default with
  median/mean hint), Box 3 wealth-tax drag toggle from its start date, base +
  optimistic curves, arrival years.
- 3.5 Monte Carlo (methodology in §4.3): success probability, fan chart
  P10–P90, median crossing age. Params editable in Settings.
- 3.6 What-if sliders (contribution / real return / FIRE expenses) with instant
  recompute + one-off expense simulator ("€X today delays FIRE by Y months").
- 3.7 Personal return per year vs assumed return (green = beat it).
- Placeholder birth-date warning banner until set.

### Tab 4 — Pensioni
Total pot over time (per fund + total), employer-vs-personal cumulative split,
monthly table, projection to pension age feeding `expectedPensionMonthly` via a
"usa questa stima" button, deductible-contribution card (contributi × aliquota
marginale, "not advice").

### Tab 5 — Simulatore (AI FIRE simulator)
- **Deterministic engine, real €** (§4): year-by-year to `endAge`, per-class
  returns, accumulation with contributions allocated across liquid classes by
  weight; decumulation withdraws from liquid by weight; pension classes grow
  but are never drawn; state-pension income reduces need from
  `statePensionAge`; models the retirement→state-pension **gap** explicitly.
- Outputs: plan survives / depletion age, **Coast-FIRE age** (earliest
  contribution-stop age that still survives), Monte Carlo success + P10/50/90
  bands, net-worth chart, gap chart (withdrawals vs pension income), and a
  **"Mostra i numeri"** year-by-year table behind every chart.
- **Crisis stress test** (§4.4) card with age + severity controls, crisis-vs-no-
  crisis overlay, impact on final capital/survival/MC success, and an "apply to
  main scenario" toggle persisted in `profile.shock`.
- **AI "E se…" box**: free text → strict-JSON paramChanges (contract in §5.4)
  → applied to a **copy** → engine reruns → **narration is generated
  deterministically from engine output** (guarantees no invented figures).
  Compare-to-baseline overlay + list of changed assumptions. Graceful "AI non
  disponibile" fallback; manual editor always works.
- Persistent disclaimer.

### Tab 6 — Tasse (multi-agent tax assistant)
- **Deterministic facts panel** computed in JS and passed to agents: ruling
  expiry countdown, wealth-tax (Box 3) drag + start date, current-year
  deductible pension contributions × marginal rate, expected pension. The AI
  does not recompute these.
- Three sequential agents behind `callAgent(role, context)` with **structured
  JSON hand-off**: Optimizer `{proposals:[{id,title,rationale,assumptions,
  recencySensitive}]}` → Compliance/Risk Reviewer (addresses each proposal
  **by id**; optional web_search tool where the provider supports it)
  `{reviews:[{id,verdict:"ok|cautela|rischioso",risks,recencyFlags,confidence}]}`
  → Reconciler `{ranked:[{id,action,confidence,why}], verify:[...]}` whose
  `verify` list ("check with the tax authority / an adviser") is mandatory.
- **All three layers always render** so disagreement is visible. History
  persisted. Persistent "not tax advice" disclaimer. Recency-sensitive rules
  (expat ruling regimes, wealth-tax reform, cross-border pensions) are flagged,
  never asserted as current law.

### Tab 7 — Impostazioni
Accounts (type/liquidity badge, color, **FIRE checkbox** on liquid accounts,
archive/restore/delete), all parameters (payday, birth date, FIREParams incl.
Monte Carlo mean/σ), milestones CRUD, Dati (export / import-replace /
**import-merge** keyed by id with imported-wins semantics / demo data / wipe
gated by typing CONFERMA), **AI / Modelli** provider card (§5).

### Monthly entry form (modal desktop / full-screen mobile)
Sections: Entrate (with **salary auto-suggest** = Σ payday − Σ day-before of
current accounts, one tap) · Conto corrente (both balances) · Saldi conti
(**carry-forward prefill of last month's balances for a NEW month — active
accounts only; archived balances must never be silently written**) ·
Contributi (**ghost text of last month's recurring ones, one-tap copy — never
auto-inserted**) · Trasferimenti interni · **live sticky footer** (net worth,
Δ, real-time estimated expenses, ⚠ warnings incl. reconcile). Save validates
every active liquid account has a balance (explicit skip → flag).

---

## 4. Simulation Methodology (hard requirements — each encodes a real bug found)

### 4.1 Deterministic projections
Monthly compounding `(1+r)^(1/12)−1`; optional wealth-tax drag applied monthly
from its start date to the projected balance. Seeded, reproducible.

### 4.2 RNG
`mulberry32(seed)` + Box-Muller gaussian. **All Monte Carlo functions accept a
seed and are bit-reproducible.** No `Date.now()`/`Math.random()` in the engine.

### 4.3 Monte Carlo — two rules that MUST hold
1. **Draw the annual return once per 12 months** and apply one-twelfth of it
   monthly. Redrawing an annual-vol return every month collapses realized
   annual volatility to `σ/√12` (~4.4% instead of 15%) and silently overstates
   success probability. A statistical test must enforce realized dispersion
   (e.g. fan P90/P10 after 20y at σ=15% must exceed 3.5).
2. **Asset classes share one market factor per year**: `return_c = mean_c +
   vol_c × z`, one `z ~ N(0,1)` per year. Independent per-class draws grant
   diversification that correlated equity classes don't have (measured: 95% vs
   70% success for the same money). A test must assert a portfolio split into
   n identical classes scores exactly the same as one block.

### 4.4 Crisis stress test
`shock = {enabled, atAge, severity}` applied in **all three** simulation paths
(deterministic, coast-age search, Monte Carlo). Each class is hit
proportionally to its volatility: `multiplier = max(0.2, 1 − severity ×
vol/0.16)` (equity reference 16%; cash barely moves). Recovery is ordinary
compounding — which is what makes a crash at retirement (sequence-of-returns
risk) far worse than one mid-career; the UI copy should say so.

---

## 5. AI Layer

### 5.1 Provider abstraction
One `callModel(role, {system, messages, tools})` with two request shapes:
- **Anthropic Messages API** (`x-api-key`, `anthropic-version`,
  `anthropic-dangerous-direct-browser-access: true`); keyless default works
  inside Claude Artifacts.
- **OpenAI-compatible** `/chat/completions` (`Authorization: Bearer`) — covers
  OpenAI, DeepSeek, Groq, OpenRouter, Together, and **local Ollama / LM Studio**
  (no key, fully offline).
Presets: artifact / anthropic / openai / deepseek / groq / openrouter / ollama /
custom, each with default baseUrl + model, all overridable. A "Prova
connessione" test button. Role→model map (fast model for parsing, strong model
for review/reconcile) used when no explicit model is configured.

### 5.2 Robustness
Strip code fences, `try/catch` JSON parse, per-call error handling; an AI
failure must never block the UI — deterministic features keep working and the
tabs show a clear "AI non disponibile" state. No HTML `<form>`; onClick only.

### 5.3 Key hygiene (hard rules)
- Key stored ONLY in localStorage; never in code.
- **JSON export blanks the key** (backups get shared); redaction must not
  mutate live state.
- **Imports never accept a key from a file**; the browser's existing key wins.

### 5.4 What-if parsing contract (Simulatore)
System prompt: JSON only, no prose/fences. Schema:
`{"intent", "paramChanges": {retirementAge?, statePensionAge?, endAge?,
annualContribution?, annualSpend?, statePensionAnnual?,
classReturns?: {classId: decimal}, shock?: {enabled, atAge, severity}},
"assumptionsTouched": [..], "explanationRequest"}` — model must NOT compute
results. Apply to a copy; engine recomputes; narration built from engine output.

---

## 6. UX & Technical Constraints

- Single deliverable HTML file. Dev-side layout: `engine.js` (pure) + `app.js`
  (UI) + `shell.head.html` (CSS/skeleton) concatenated by `build.js` into
  `index.html`. **Tests must assert the engine embedded in `index.html` is
  byte-identical to `engine.js`.**
- Chart.js CDN only; no other dependencies at runtime; jsdom only as a dev
  test dependency.
- IT locale formatting (`€ 1.234,56` via `Intl`), Italian month names and UI
  copy throughout. Colors: positive `#2ecc71`, negative `#e74c3c`; 12-color
  account palette persisted per account.
- **Escape every user-entered string (account names!) rendered via
  `innerHTML`** — this was an actual XSS hole.
- localStorage quota error → block save, force export prompt. Accessibility:
  Escape closes modals, focus rings, `prefers-reduced-motion`. Empty states
  with CTA. Charts responsive; wide content scrolls in its own container.

---

## 7. Test Plan (all must pass; counts from the reference implementation)

Runner: plain Node scripts, no framework. `npm run test:all` executes all five
suites after a build. jsdom is the only dev dependency.

### 7.1 `tests/run.js` — engine & scenario tests (59)
- **Integrity:** engine source appears verbatim in built `index.html`; engine
  evaluates standalone in a bare VM.
- **Scenario 1 — transfer chain in ONE month** (bank→savings 1000, savings→bank
  300, bank→broker 500): expenses resolve to real spend only (600); transfer
  terms exact; broker market growth excludes the transfer; savings growth 0;
  net worth = plain sum; invested/savings-rate identities.
- **Scenario 2 — same chain ACROSS months:** each month independently correct.
- **Scenario 3 — broker funded via transfer vs contribution:** identical
  expenses, net worth, market growth, invested; **reconciliation treats both
  identically** (same registered amount, same diff/mismatch).
- **Scenario 4:** a pure internal transfer leaves net worth unchanged and
  expenses at 0.
- **Scenario 5:** withdrawal back to current + current↔current transfer
  (nets to zero) + broker growth 0 when the withdrawal is registered.
- **Scenario 6:** `NEGATIVE_EXPENSES` and `MISSING_SNAPSHOT` flags fire
  exactly when specified.
- **Scenario 7:** consistent fixture → invested = registered → no mismatch.
- **Scenario 7b — FIRE capital:** broker-only by default; savings opt-in via
  `includeInFire`; **pension never counts even if forced**.
- **Scenario 7c:** trailing/median invested; personal return ≈ 0 when all
  growth is contributions; ≈ market return when there are no flows;
  first-year baseline fallback.
- **Scenario 8 — FIRE math:** simple number formula; two-phase < simple with
  positive pension saving; projection reaches target; Box 3 drag lowers final
  capital; **MC fan realizes configured volatility (P90/P10 > 3.5 @ 20y)**;
  MC probability ∈ [0,1] and seed-reproducible; **coastFire honors a custom
  (two-phase) target**; **coastFire with r ≤ 0 → null, never Infinity**.
- **Scenario 9:** ym helpers across year boundaries; monthly table shape.
- **Scenario 10 — FIRE simulator:** one row per year inclusive; with 0%
  returns liquid follows `prev + contribution − withdrawal` exactly
  (conservation); accumulation arithmetic exact; pension pot never drawn;
  depletion at the predictable age; state pension zeroes the withdrawal need;
  coast-age extremes (rich→now, poor→null); **split portfolio ≡ single block
  under MC (shared market factor)**; MC bands ordered and reproducible; class
  totals split liquid/pension; **shock:** disabled/severity-0 is a no-op,
  reduces final capital, hits high-vol harder than cash (vol-scaled, exact),
  **crash near retirement is worse than mid-career**, and MC success with a
  crash ≤ baseline.

### 7.2 `tests/property.js` — 100 randomized histories + 23 edge cases (~3,589 assertions)
A **ground-truth simulator** generates internally consistent monthly histories
(salary/extra/other income, spending, contributions incl. negative and
external, transfers between any accounts, injected per-account market moves;
month-0 payday consistent with declared income). For every month of every
scenario, assert the engine recovers:
liquid/total net worth = sums · FIRE capital = broker sum · expenses ==
injected spending · per-account and portfolio market growth == injected moves ·
invested identity · savings-rate identity · **reconcile diff ≈ 0 and mismatch
NEVER fires on a consistent history**.
Edge cases: empty data; single month; zero income (rate null, not NaN);
negative balances; pension exclusion; curr↔curr netting; negative-expense
flag; Dec→Jan cycle; archived dropout after archive month; annuity r=0;
FIRE-number formula; two-phase with pension ≥ expenses → no legacy capital;
projection with 0% and negative returns; coast extremes; MC bounds +
reproducibility; trailing-invested null; personal-return null; v1 migration
default source; multi-year ym helpers; rollingAvg null-skipping; cent
precision at 7 digits.

### 7.3 `tests/ui-smoke.js` — jsdom integration (36)
Boot + `window.FD` debug surface · demo seed · **all seven tabs render** ·
charts instantiated · ⓘ info toggle works · ⤢ enlarge opens a chart modal ·
storico rows + **annual rollup rows with a 4-digit year label** · FIRE
headline/progress/personal-return present · **Coast card shows the two-phase
target and the crossover canvas** · MC params editable and persisted · new
month prefills balances and shows ghost contributions · entry form shows
transfers for the demo chain month · SWR chip updates state · Monte Carlo
button produces a probability · FIRE checkbox toggles `includeInFire` ·
edit+save persists a balance · simulator seeds `fireSim` and renders charts +
numbers table + disclaimer · **what-if degrades gracefully when fetch fails**
(stub fetch to reject) · manual simulator edit persists · **stress test
renders crisis-vs-no-crisis and the apply toggle persists `shock`** · tax tab
renders deterministic facts + disclaimer · **tax ask renders ALL THREE agent
layers even on AI failure** and persists history · AI settings card persists
provider presets · **`callModel` routes OpenAI-shape** (`/chat/completions`,
Bearer, `choices[]`) **and Anthropic-shape** (`/v1/messages`, `x-api-key`)
verified via fetch stubs · **archived balance is not written into a new month**
· **XSS: an account named `<img onerror=…>` never becomes an element** ·
**JSON export never contains the API key and redaction doesn't mutate live
data** · zero console errors throughout.

### 7.4 `tests/ui-fuzz.js` — randomized UI robustness (30 datasets)
Generator produces random-but-valid datasets (0–14 months, 1–6 accounts,
archived accounts with missing later snapshots, negative balances, random
flows). Each dataset: load via localStorage → render EVERY tab → open the
entry form for a random month. Any uncaught error or `console.error` fails.

### 7.5 `tests/import-render.js` — real-data regression
The repository's real exported dataset imports and renders every tab with the
expected account/month/FIRE-capital figures and zero console errors.

### 7.6 Meta-rules for the test suite (lessons that caught real bugs)
- Monte Carlo tests MUST include **statistical assertions** (realized
  volatility / fan spread), not just bounds and reproducibility — bounds-only
  testing let a √12 volatility collapse ship.
- Property tests validate against an **independent ground-truth simulator**,
  not the engine's own formulas re-applied.
- UI tests must simulate **failure modes** (fetch rejection) and **hostile
  input** (HTML in names), not only happy paths.

---

## 8. Acceptance Checklist

- [ ] Single `index.html` opens from disk with full functionality except AI
      (which degrades gracefully and works with any configured provider).
- [ ] Engine math deterministic and independently verifiable ("show the
      numbers" behind every simulator chart).
- [ ] AI cannot change any displayed figure except via a parameter the engine
      recomputes; tax tab always renders three agent layers + disclaimer +
      verify-with-a-professional list.
- [ ] All §7 suites green; engine byte-identical inside the shipped HTML.
- [ ] No API key in any export; no unescaped user string in any `innerHTML`.
- [ ] Flags (`NEGATIVE_EXPENSES`, `MISSING_SNAPSHOT`, reconcile) fire exactly
      per §2 — and never on fully consistent data.

## 9. Out of Scope
Broker/bank APIs, multi-currency, cloud sync, multi-user, PDF/Excel export,
auto-inserted recurring contributions, historical-returns Monte Carlo,
per-ETF holdings tracking.
