# Financial Dashboard — FIRE

Personal finance tracking and FIRE planning dashboard for a single user.
Italian UI, EUR only, manual monthly data entry, `localStorage` persistence
with versioned JSON export/import. Built to the spec in [`CLAUDE.md`](./CLAUDE.md).

## Run it

Open **`index.html`** in any modern browser. No server, no build, no install.
Chart.js is loaded from a CDN; everything else is self-contained in the file.

On first run, open **Impostazioni → Dati → Carica dati demo** to load a sample
dataset, or use the empty-state button to enter your first month.

## Project layout

The deliverable is the single self-contained **`index.html`**. To keep the
calculation engine testable, the source is split and concatenated at dev time:

| File | Purpose |
|---|---|
| `engine.js` | Pure, DOM-free calculation engine (§2 metrics + §3 FIRE math). Single source of truth, shared with the tests. |
| `app.js` | UI layer (tabs, charts, entry form, settings). Depends on `Engine` + `Chart`. |
| `shell.head.html` | HTML shell + CSS with `/*<<ENGINE>>*/` / `/*<<APP>>*/` injection points. |
| `build.js` | Concatenates the three into `index.html`. |
| `index.html` | **Generated, self-contained deliverable.** |

After editing `engine.js`, `app.js`, or `shell.head.html`, run `node build.js`.

## Tests

```bash
npm install          # dev-only: jsdom for the UI smoke test
npm run test         # engine / scenario tests (no deps needed)
npm run test:ui      # jsdom DOM smoke test (renders every tab + entry form)
npm run test:all     # both
```

### Transfer scenarios (`tests/run.js`)

The suite focuses on the tricky case of money moving between accounts —
**bank → savings → partial back to bank → broker** — both within a single
month and across months, verifying that internal transfers never leak into
estimated expenses, net worth, or market growth:

- **Scenario 1** — full chain in one month; expenses resolve to real spend only.
- **Scenario 2** — same chain split across two months; each month independent.
- **Scenario 3** — broker funded as a *transfer* vs a *contribution*: identical
  expenses/net worth, only reconciliation differs.
- **Scenario 4** — pure transfer leaves net worth unchanged.
- **Scenario 5** — withdrawal back to current + current↔current transfer.
- **Scenario 6** — `NEGATIVE_EXPENSES` / `MISSING_SNAPSHOT` flags.
- **Scenario 7** — reconciliation matches registered contributions.
- **Scenario 8** — FIRE number, projection, Box 3 drag, Monte Carlo.
- **Scenario 9** — date helpers + monthly table.

`tests/run.js` also asserts the engine embedded in `index.html` is byte-identical
to `engine.js`, so the tests cover the actual shipped file.
