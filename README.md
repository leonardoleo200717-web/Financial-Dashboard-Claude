# Financial Dashboard — FIRE

Personal finance tracking and **FIRE** (Financial Independence / Retire Early)
planning for a single user. Italian UI, EUR only, manual monthly data entry,
`localStorage` persistence with versioned JSON export/import, plus two AI tabs
(a FIRE simulator and a tax assistant). Single self-contained HTML file.

---

## 1. Run it

Open **`index.html`** in any modern browser. No server, no build, no install —
Chart.js loads from a CDN, everything else is in the file.

First run: **Impostazioni → Dati → Carica dati demo** for a sample dataset, or
use the empty-state button to enter your first month. To load your own data,
**Impostazioni → Dati → Importa** a JSON export.

> **Set these first** (Impostazioni → Parametri): your **birth date** (every
> age-based FIRE number depends on it) and the **FIRE parameters** (target
> spend, SWR, expected pension, returns).

---

## 2. Core idea (how to read everything)

Three concepts drive the whole app:

- **Snapshots are the truth.** Each month you record the *balance* of every
  account. Net worth, growth and allocation come straight from these — they're
  always right.
- **Flows are annotations.** Salary, contributions and internal transfers let
  the app *derive* spending, savings rate and market-vs-contributions. If a flow
  is missing, balance-based views still work; derived numbers show `—` or a ⚠
  rather than a wrong figure.
- **Liquid vs locked.** Pension pots are tracked but excluded from
  "FIRE-before-67" math — they're a second pillar that lowers your post-pension
  spending need.

**Golden rule for accurate spending/growth:** whenever you move money *between
your own accounts* (bank → broker, broker → broker, bank → savings), record it
as an **internal transfer** in the entry form. If you don't, the app can mistake
a transfer for spending and a month may show a wrong/negative "Spese stimate".

---

## 3. Monthly workflow (2 minutes)

1. **Storico → + Inserisci mese** (or the ＋ on a month).
2. The form **pre-fills last month's balances** — just nudge the ones that
   changed.
3. **Entrate:** salary (tap *"usa …"* to auto-fill from payday − day-before),
   plus any extra/bonus or other income.
4. **Conto corrente:** the day-before-payday and payday balances (these power the
   expense estimate).
5. **Saldi conti:** the payday balance of each broker / savings / pension.
6. **Contributi:** deposits into investments (last month's recurring ones appear
   as one-tap *ghost* copies). `source: external` = money that never touched
   your bank (e.g. employer pension) — excluded from the expense math.
7. **Trasferimenti interni:** every money move between your accounts. **Don't
   skip these** (see the golden rule above).
8. Watch the live footer (patrimonio, Δ, spese stimate, ⚠) and **Salva**.

---

## 4. The tabs

| Tab | What it's for |
|---|---|
| **📈 Andamento** | Charts: net worth, contributions vs market, monthly growth, savings rate, expenses, allocation. Each has an **ⓘ** explanation and a **⤢ enlarge** button. |
| **📋 Storico** | Month-by-month table; click a row for the account-level breakdown; ⚠ marks data-quality flags. |
| **🔥 FIRE** | Are you on track: headline progress, FIRE number, Coast FIRE, on-track-vs-plan, projection, Monte Carlo, what-if, personal return. |
| **🤖 Simulatore** | AI "what if…" + deterministic asset-class projection to age 90 (accumulation → decumulation, Monte Carlo). |
| **🧾 Tasse** | Three-agent tax assistant (Optimizer → Reviewer → Reconciler). NL/IT expat context. |
| **🏛️ Pensioni** | The locked second pillar: pension pots over time, employer-vs-personal split, lijfrente deduction. |
| **⚙️ Impostazioni** | Accounts (type, colour, archive, **FIRE** inclusion), parameters, milestones, import/export. |

---

## 5. KPI guidance — what each number means

### Net worth & growth (Andamento / Storico)
- **Patrimonio liquido** — Σ balances of liquid accounts (current + savings +
  broker). This is what all FIRE math compares against.
- **Patrimonio totale** — liquid + pension pots.
- **Δ mese** — change in liquid net worth. Its tooltip splits into **mercato**
  (market return) + **apporti netti** (new savings + cash movement), which sum
  to the bar exactly.
- **Contributi vs Mercato** — cumulative money *you* put in vs what the market
  added. The gap between the two areas is your investment gain.
- **Spese stimate** — derived from your current-account balances:
  `saldo iniziale + entrate − versamenti − trasferimenti − saldo finale`. A
  hollow point / ⚠ means the month doesn't reconcile (usually a missing
  transfer) — fix it by recording the move, don't trust the number.
- **Savings rate** — `(reddito − spese − Δliquidità) / reddito`. Use the
  **12-month average** line; single months swing a lot. Anything sustainably
  above ~30–40% is strong.

### FIRE tab
- **Capitale FIRE** — only the accounts flagged "FIRE" in Settings (default:
  brokers). Cash and savings are excluded because idle cash shouldn't be
  projected at market returns. The progress bar is `capitale / FIRE number`.
- **FIRE number** — capital that makes you independent: `spese annue ÷ SWR`. The
  **two-phase** version is lower because pensions cover part of spending after
  ~67. SWR 3.5% is the default; 3% is safer, 4% more aggressive.
- **Coast FIRE** — *yes/no*: do you already have enough invested that, even if
  you **stop contributing today**, compounding alone reaches the FIRE number by
  your target age? If not, the card shows the gap.
- **On-track** — your real capital vs a frozen **saved plan**, in € *and*
  months ahead/behind. Re-baseline whenever your plan changes.
- **Proiezione** — years to FIRE at a contribution you control. It defaults to
  the **median** monthly invested (robust to one-off lumps), shown as an
  *editable assumption* — change it to something you can actually sustain.
- **Monte Carlo** — 1,000 random-return paths; the **success probability** is the
  share where you don't run out by 90. >85–90% is a comfortable plan.
- **Rendimento personale** — your real annualised return per year (Simple Dietz,
  approximate) vs the return you *assume* in projections (green = you beat it).

### Simulatore (🤖)
- All numbers come from a **deterministic** engine in **real euros** (today's
  purchasing power). The AI only turns your sentence into parameter changes; it
  never invents a figure. Every chart has a **"Mostra i numeri"** table behind it.
- **Esito piano** — does the liquid portfolio survive to your horizon (age 90),
  or at what age it depletes.
- **Coast-FIRE (età)** — earliest age you could stop contributing and still make
  it.
- **Successo Monte Carlo** — same robustness idea, per asset-class volatility.
- The **gap 55→70** chart shows the years you live purely off your portfolio
  before the state pension starts.
- Type a what-if ("vado in pensione a 53", "azioni al 4% reale", "+500/mese") or
  edit the **Ipotesi** (assumptions + per-class value/return/volatility) directly.

### Tasse (🧾)
- A deterministic **facts** panel (30% ruling countdown, Box 3 drag, lijfrente
  deduction) is computed in JS and fed to the agents — the AI doesn't do the
  arithmetic.
- Each question runs three agents: **Optimizer** (proposals) → **Reviewer**
  (stress-tests each, flags recency-sensitive items, optional web search) →
  **Reconciler** (ranked recommendation + a "verify with a professional" list).
  You see all three layers, including disagreement.
- **Not tax advice.** Items that depend on changing law (30% ruling, Art. 2.6,
  Box 3) are flagged, not asserted.

> **AI availability:** the two AI tabs call the in-artifact Anthropic endpoint.
> They work fully inside **Claude Artifacts**; opened as a **local file** the
> endpoint is unreachable, so they show *"AI non disponibile"* — the
> deterministic engine, facts, charts and manual controls all keep working.

---

## 6. Data: backup, import, reset

- **Esporta JSON** — versioned, pretty-printed backup (`financial-dashboard-YYYY-MM-DD.json`).
- **Importa (sostituisci)** — replace everything with a file.
- **Importa e unisci** — merge a file into current data (imported values win on
  the same id/month) — handy if you also keep a spreadsheet.
- **Cancella tutto** — gated by typing `CONFERMA`.

Storage key `fd_data_v2`. The schema is extended additively, so older exports
import cleanly.

---

## 7. Project layout & development

The deliverable is the single self-contained **`index.html`**, assembled at dev
time from separate sources (no runtime build):

| File | Purpose |
|---|---|
| `engine.js` | Pure, DOM-free calculation engine — metrics, FIRE math, and the asset-class simulator. Single source of truth, shared with tests. |
| `app.js` | UI layer (tabs, charts, entry form, AI calls). Depends on global `Engine` + `Chart`. |
| `shell.head.html` | HTML shell + CSS with `/*<<ENGINE>>*/` / `/*<<APP>>*/` injection points. |
| `build.js` | Concatenates the three into `index.html`. |
| `generate-data.js` | Builds the 2025–2026 import JSON from the source spreadsheet (and validates it). |
| `index.html` | **Generated, self-contained deliverable.** |

After editing `engine.js`, `app.js`, or `shell.head.html`, run `node build.js`.

### Tests

```bash
npm install            # dev-only: jsdom for the UI tests
npm run test           # engine + transfer/FIRE/simulator scenarios
npm run test:property  # 100 randomized histories + edge cases (~3,300 assertions)
npm run test:ui        # jsdom: renders every tab + key interactions
npm run test:fuzz      # 30 random datasets through every tab
npm run test:import    # the real 2025–2026 import renders
npm run test:all       # everything
```

The suites cover: the transfer math (**bank → savings → back → broker**, within
and across months), the §2/§3 derived metrics under randomized but
internally-consistent histories, the deterministic FIRE-simulator engine
(conservation, depletion, pension offset, Monte-Carlo bounds), and that the two
AI tabs **degrade gracefully** when the endpoint is unreachable. `tests/run.js`
also asserts the engine embedded in `index.html` is byte-identical to
`engine.js`, so the tests cover the actual shipped file.

> The dashboard is a personal tool — **not financial or tax advice.**
