#!/usr/bin/env node
/* Statement-import engine tests — SYNTHETIC fixtures only (never real bank
   data). Covers the FLUSSI_CONTI.md rules: multi-account export splitting,
   role guessing, joint-account (CJ) anti-double-counting, balance continuity,
   custom category rules, and Scalable special rows (security transfers,
   maturity vs dividend, CANCEL netting). */
const path = require('path');
const E = require(path.join(__dirname, '..', 'engine.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; console.log('  \x1b[31m✗ ' + name + '\x1b[0m\n      ' + (e.stack || e.message)); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` — expected ${b}, got ${a}`); }
function close(a, b, msg) { if (Math.abs(a - b) > 0.011) throw new Error((msg || '') + ` — expected ≈${b}, got ${a}`); }

/* ---------------- synthetic multi-account ABN export ----------------- */
// Accounts: 111 = main (salary), 124 = CJ joint, 151 = savings.
// IBANs embed the account number so abnAccountsInStatement can recover them.
const IBAN_MAIN = 'NL10ABNA0000000111';
const IBAN_CJ = 'NL20ABNA0000000124';
const IBAN_SAV = 'NL30ABNA0000000151';
const IBAN_GIULIA = 'NL40ABNA0000000999';
const IBAN_LANDLORD = 'NL50RABO0000000777';

function tsv(rows) {
  const head = 'accountNumber\tmutationcode\ttransactiondate\tvaluedate\tstartsaldo\tendsaldo\tamount\tdescription';
  return [head].concat(rows.map(r => r.join('\t'))).join('\n');
}
// Running balances kept consistent per account for the continuity check.
const FIX = tsv([
  // --- main account 111: salary, spending, transfers to CJ + savings ---
  ['111', 'EUR', '20260120', '20260120', '5000.00', '4900.00', '-100.00', 'BEA, Google Pay                  Albert Heijn 1041,PAS472'],
  ['111', 'EUR', '20260123', '20260123', '4900.00', '3800.00', '-1100.00', 'SEPA Overboeking                 IBAN: ' + IBAN_CJ + '        Naam: L ARDIELLI CJ'],
  ['111', 'EUR', '20260124', '20260124', '3800.00', '2800.00', '-1000.00', 'SEPA Overboeking                 IBAN: ' + IBAN_SAV + '        Naam: L ARDIELLI'],
  ['111', 'EUR', '20260125', '20260125', '2800.00', '7300.00', '4500.00', 'SEPA Overboeking                 IBAN: NL26CITI0000000001 Naam: ASML Netherlands B.V.'],
  ['111', 'EUR', '20260210', '20260210', '7300.00', '7100.00', '-200.00', 'SEPA Overboeking                 IBAN: NL60INGB0000000123        Naam: Palestra Sconosciuta'],
  ['111', 'EUR', '20260220', '20260220', '7100.00', '6000.00', '-1100.00', 'SEPA Overboeking                 IBAN: ' + IBAN_CJ + '        Naam: L ARDIELLI CJ'],
  ['111', 'EUR', '20260223', '20260223', '6000.00', '6016.00', '16.00', 'SEPA Overboeking                 IBAN: ' + IBAN_CJ + '        Naam: L ARDIELLI CJ Saldo residuo chiusura'],
  ['111', 'EUR', '20260225', '20260225', '6016.00', '10516.00', '4500.00', 'SEPA Overboeking                 IBAN: NL26CITI0000000001 Naam: ASML Netherlands B.V.'],
  // --- CJ account 124: Leonardo 1100 in, Giulia 900 in, rent out ---
  ['124', 'EUR', '20260123', '20260123', '300.00', '1400.00', '1100.00', 'SEPA Overboeking                 IBAN: ' + IBAN_MAIN + '        Naam: L ARDIELLI'],
  ['124', 'EUR', '20260126', '20260126', '1400.00', '2300.00', '900.00', 'SEPA Overboeking                 IBAN: ' + IBAN_GIULIA + '        Naam: G OTTOBONI'],
  ['124', 'EUR', '20260201', '20260201', '2300.00', '956.00', '-1344.00', 'SEPA Overboeking                 IBAN: ' + IBAN_LANDLORD + '        Naam: PC Hooftlaan 2'],
  ['124', 'EUR', '20260220', '20260220', '956.00', '2056.00', '1100.00', 'SEPA Overboeking                 IBAN: ' + IBAN_MAIN + '        Naam: L ARDIELLI'],
  ['124', 'EUR', '20260221', '20260221', '2056.00', '2956.00', '900.00', 'SEPA Overboeking                 IBAN: ' + IBAN_GIULIA + '        Naam: G OTTOBONI'],
  ['124', 'EUR', '20260222', '20260222', '2956.00', '2940.00', '-16.00', 'SEPA Overboeking                 IBAN: ' + IBAN_MAIN + '        Naam: L ARDIELLI Saldo residuo chiusura'],
  // --- savings 151: fed only by main, interest line ---
  ['151', 'EUR', '20260124', '20260124', '0.00', '1000.00', '1000.00', 'SEPA Overboeking                 IBAN: ' + IBAN_MAIN + '        Naam: L ARDIELLI'],
  ['151', 'EUR', '20260402', '20260402', '1000.00', '1074.44', '74.44', 'ACCOUNT BALANCED                 CREDIT INTEREST           74,44Cfrom 31.12.2025'],
]);

console.log('\n=== Multi-account ABN export ===');
const rows = E.parseABNStatement(FIX);

t('parser keeps per-row account numbers', () => {
  eq(new Set(rows.map(r => r.account)).size, 3, 'distinct accounts');
});

let summary;
t('abnAccountsInStatement finds 3 accounts with correct roles', () => {
  summary = E.abnAccountsInStatement(rows);
  eq(summary.length, 3);
  const by = {}; summary.forEach(s => { by[s.account] = s; });
  eq(by['111'].role, 'main', 'salary account role');
  eq(by['124'].role, 'cj', 'joint account role (2 recurring payers)');
  eq(by['151'].role, 'savings', 'savings role');
});

t('own IBAN recovered from counter-IBANs (embeds account number)', () => {
  const by = {}; summary.forEach(s => { by[s.account] = s; });
  eq(by['111'].iban, IBAN_MAIN);
  eq(by['124'].iban, IBAN_CJ);
  eq(by['151'].iban, IBAN_SAV);
});

t('continuity validator passes on a complete export', () => {
  const cont = E.abnValidateContinuity(rows);
  cont.forEach(c => { if (!c.ok) throw new Error('account ' + c.account + ' diff ' + c.diff); });
});

t('continuity validator catches a missing row', () => {
  const broken = rows.filter(r => !(r.account === '111' && r.amount === -200));
  const cont = E.abnValidateContinuity(broken).find(c => c.account === '111');
  if (cont.ok) throw new Error('should not be ok');
  close(cont.diff, -200, 'missing debit shifts the sum');
});

console.log('\n=== CJ anti-double-counting (§3 FLUSSI_CONTI) ===');
const digestOpts = {
  paydayDay: 25, accountNumber: '111',
  ownIbans: { [IBAN_SAV]: 'acc-sav' },
  cjIbans: { [IBAN_CJ]: '124' },
  sharedExpenseIbans: { [IBAN_GIULIA]: 'Giulia' },
};
const dg = E.abnMonthlyDigest(rows, digestOpts);

t('digest is restricted to the main account', () => {
  // CJ's rent (-1344) must NOT appear anywhere in main's expenses
  const feb = dg['2026-02'];
  close(feb.actualExpenses, 200 + 1100, 'Feb cycle (25gen→24feb): palestra 200 + CJ 1100');
});

t('Leonardo→CJ transfer is an expense, category "Spese condivise"', () => {
  const feb = dg['2026-02'];
  close(feb.categories['Spese condivise'], 1100);
});

t('CJ residual return (+16) is excluded from income (cjReturns)', () => {
  const feb = dg['2026-02'];
  close(feb.cjReturns, 16);
  close(feb.otherIncome, 0, 'no phantom income');
});

t('salary detected on the main account only', () => {
  close(dg['2026-01'].salary, 4500);
  close(dg['2026-02'].salary, 4500);
});

t('transfer to savings is INTERNAL (not expense)', () => {
  const jan = dg['2026-01'];
  // Jan cycle is partial (starts before window) but the transfer list is per calendar month
  const out = jan.transfers.filter(x => x.direction === 'out');
  eq(out.length, 1); close(out[0].amount, 1000);
});

t('CJ account digest never computed when filtered to main', () => {
  // Giulia's 900 never shows up in any month of the main digest
  Object.values(dg).forEach(mo => {
    if (mo.partnerContributions !== 0) throw new Error('partner money leaked into main digest: ' + mo.ym);
  });
});

console.log('\n=== Category rules (user-defined, persisted) ===');
t('custom rule wins over built-ins and fallback', () => {
  const rules = [{ match: 'Palestra Sconosciuta', category: 'Sport' }];
  eq(E.categorizeTransaction('SEPA Overboeking IBAN: NL60INGB0000000123 Naam: Palestra Sconosciuta', rules), 'Sport');
  eq(E.categorizeTransaction('SEPA Overboeking IBAN: NL60INGB0000000123 Naam: Palestra Sconosciuta'), 'Da classificare');
});
t('IBAN-based rule matches the description', () => {
  const rules = [{ match: 'NL60INGB0000000123', category: 'Abbonamenti' }];
  eq(E.categorizeTransaction('SEPA Overboeking IBAN: NL60INGB0000000123 Naam: X', rules), 'Abbonamenti');
});
t('unknown plain transfer falls back to "Da classificare"', () => {
  eq(E.categorizeTransaction('SEPA Overboeking IBAN: NL99BUNQ0000000001 Naam: Qualcuno'), 'Da classificare');
});
t('digest applies category rules', () => {
  const dg2 = E.abnMonthlyDigest(rows, Object.assign({}, digestOpts, {
    categoryRules: [{ match: 'Palestra Sconosciuta', category: 'Sport' }],
  }));
  close(dg2['2026-02'].categories['Sport'], 200);
});

console.log('\n=== extractCounterparty / extractIban ===');
t('extracts the name and stops at the next field', () => {
  eq(E.extractCounterparty('SEPA Overboeking                 IBAN: NL43ABNA0123456789        BIC: ABNANL2A                    Naam: G OTTOBONI                Kenmerk: X'), 'G OTTOBONI');
  eq(E.extractCounterparty('Incassant: X   Naam: Scalable Capital Bank GmbH Machtiging: Y'), 'Scalable Capital Bank GmbH');
  eq(E.extractCounterparty('BEA, Google Pay Albert Heijn'), null);
});
t('structured /TRTP/ format (export ABN da apr-2026) — IBAN e nome', () => {
  const d = '/TRTP/SEPA OVERBOEKING/IBAN/DE65120700700759730652/BIC/DEUTDEFFVAC/NAME/Leonardo Ardielli Scalable/EREF/NOTPROVIDED';
  eq(E.extractIban(d), 'DE65120700700759730652');
  eq(E.extractCounterparty(d), 'Leonardo Ardielli Scalable');
  const d2 = '/TRTP/SEPA OVERBOEKING/IBAN/NL77INGB0007286147/BIC/INGBNL2A/NAME/WTC Brands/EREF/NOTPROVIDED';
  eq(E.extractIban(d2), 'NL77INGB0007286147');
  eq(E.extractCounterparty(d2), 'WTC Brands');
});
t('classic format still extracts the IBAN', () => {
  eq(E.extractIban('SEPA Overboeking                 IBAN: NL43ABNA0123456789        BIC: ABNANL2A'), 'NL43ABNA0123456789');
});
t('a /TRTP/ transfer to an own IBAN is INTERNAL, not expense', () => {
  const fx = tsv([
    ['111', 'EUR', '20260620', '20260620', '9000.00', '7250.00', '-1750.00', '/TRTP/SEPA OVERBOEKING/IBAN/DE65120700700759730652/BIC/DEUTDEFFVAC/NAME/Leonardo Ardielli Scalable/EREF/X'],
    ['111', 'EUR', '20260625', '20260625', '7250.00', '11750.00', '4500.00', 'SEPA Overboeking                 IBAN: NL26CITI0000000001 Naam: ASML Netherlands B.V.'],
    ['111', 'EUR', '20260710', '20260710', '11750.00', '11700.00', '-50.00', 'BEA, Google Pay                  Albert Heijn 1041,PAS472'],
    ['111', 'EUR', '20260725', '20260725', '11700.00', '16200.00', '4500.00', 'SEPA Overboeking                 IBAN: NL26CITI0000000001 Naam: ASML Netherlands B.V.'],
  ]);
  const rws = E.parseABNStatement(fx);
  const d = E.abnMonthlyDigest(rws, { paydayDay: 25, accountNumber: '111', ownIbans: { 'DE65120700700759730652': 'scalable' } });
  const jul = d['2026-07'];
  close(jul.actualExpenses, 50, 'solo la spesa vera; il bonifico Scalable è transfer');
  eq(jul.transfers.length, 0, 'transfer datato giugno');
  eq(d['2026-06'].transfers.length, 1, 'transfer 1750 registrato a giugno');
});

console.log('\n=== Scalable special rows (§6 FLUSSI_CONTI) ===');
const SCAL_CSV = [
  'date;time;status;reference;description;assetType;type;isin;shares;price;amount;fee;tax;currency',
  // deposit + savings plan + fee
  '2026-01-05;10:00:00;Executed;"D1";"Deposit";Cash;Deposit;;;;1.000,00;0,00;0,00;EUR',
  '2026-01-06;10:00:00;Executed;"B1";"Vanguard FTSE All-World";Security;Savings plan;IE00BK5BQT80;5;100,00;-500,00;0,00;0,00;EUR',
  '2026-01-31;10:00:00;Executed;"F1";"PRIME+";Cash;Fee;;;;-4,99;0,00;0,00;EUR',
  // security transfer in kind: NOT a deposit, NOT a buy
  '2026-01-10;01:00:00;Executed;"SWITCH-1";"iShares Core S&P 500";Security;Security transfer;IE00B5BMR087;10;500,00;5.000,00;;;EUR',
  // iBonds maturity: security-side corporate action + cash distribution, SAME reference
  '2026-01-13;01:00:00;Executed;"CA-9";"iBonds Dec 2025";Security;Corporate action;IE000U99N3V1;-12;95,70;-1.148,39;;;EUR',
  '2026-01-13;01:00:00;Executed;"CA-9";"iBonds Dec 2025";Cash;Distribution;IE000U99N3V1;;;1.148,39;0,00;0,00;EUR',
  // a real dividend + its cancellation (nets to zero) + a survivor dividend
  '2026-02-01;10:00:00;Executed;"DIV-1";"ETF X";Cash;Distribution;IE00X;;;0,04;0,00;0,00;EUR',
  '2026-02-02;10:00:00;Executed;"CANCEL-DIV-1";"ETF X";Cash;Distribution;IE00X;;;-0,04;0,00;0,00;EUR',
  '2026-02-03;10:00:00;Executed;"DIV-2";"ETF Y";Cash;Distribution;IE00Y;;;12,50;0,00;0,00;EUR',
  // cancelled buy: excluded by status
  '2026-02-04;10:00:00;Cancelled;"B9";"NVIDIA";Security;Buy;US67066G1040;0;0,00;0,00;0,00;0,00;EUR',
].join('\n');

const srows = E.parseScalableCSV(SCAL_CSV);
const sdg = E.scalableMonthlyDigest(srows);

t('reference field is parsed', () => {
  if (!srows.find(r => r.reference === 'CA-9')) throw new Error('reference missing');
});
t('security transfer in kind is NOT counted as deposit', () => {
  close(sdg['2026-01'].deposits, 1000, 'only the real deposit');
});
t('iBonds maturity counted as "maturities", not dividends', () => {
  close(sdg['2026-01'].maturities, 1148.39);
  close(sdg['2026-01'].dividends || 0, 0);
});
t('CANCEL rows net out; surviving dividend remains', () => {
  close(sdg['2026-02'].dividends, 12.50);
});
t('cancelled orders are excluded by status', () => {
  if (srows.find(r => r.status !== 'Executed')) throw new Error('non-executed row leaked');
});

console.log('\n=== applyAbnDigest balancesOnly (savings accounts) ===');
t('balancesOnly writes snapshots but never touches entries', () => {
  const data = {
    schemaVersion: 2,
    accounts: [{ id: 'acc-sav', name: 'Savings', type: 'savings', liquidity: 'liquid', color: '#111', createdAt: '2026-01', archivedAt: null }],
    snapshots: {}, entries: {}, plans: [],
    settings: { defaultPaydayDayOfMonth: 25, birthDate: '1990-01-01', fire: {}, milestones: [] },
  };
  const savDg = E.abnMonthlyDigest(rows, { paydayDay: 25, accountNumber: '151', ownIbans: { [IBAN_MAIN]: 'acc-main' } });
  E.applyAbnDigest(data, savDg, 'acc-sav', { balancesOnly: true });
  if (!data.snapshots['acc-sav|2026-01']) throw new Error('snapshot not written');
  close(data.snapshots['acc-sav|2026-01'].balancePayday, 1000);
  eq(Object.keys(data.entries).length, 0, 'no entries created');
});

console.log('\n=== parseABNRows: binary .xls end-to-end (SheetJS, synthetic fixture) ===');
// A real ABN export downloads as a genuine binary .xls (BIFF8/CFB), which the
// text-based parseABNStatement cannot read at all (FileReader.readAsText on a
// binary file yields garbage → 0 rows). The browser build vendors SheetJS
// (vendor/xlsx.core.min.js) to read it directly; parseABNRows consumes the
// array-of-arrays SheetJS produces. This test builds a real binary .xls
// in-memory with the same library (round-trip, not real bank data) and reads
// it back through the EXACT vendored build to prove the shipped bundle works.
let XLSX_TEST_SKIPPED = false;
try {
  const XLSXW = require('xlsx');           // full build, for writing the fixture only
  const XLSXR = require(path.join(__dirname, '..', 'vendor', 'xlsx.core.min.js')); // what actually ships

  const aoa = [
    ['accountNumber', 'mutationcode', 'transactiondate', 'valuedate', 'startsaldo', 'endsaldo', 'amount', 'description'],
    [111, 'EUR', 20260120, 20260120, 5000, 4900, -100, 'BEA, Google Pay                  Albert Heijn 1041,PAS472'],
    [111, 'EUR', 20260125, 20260125, 4900, 9400, 4500, 'SEPA Overboeking IBAN: NL26CITI0000000001 Naam: ASML Netherlands B.V.'],
  ];
  const ws = XLSXW.utils.aoa_to_sheet(aoa);
  const wb = XLSXW.utils.book_new();
  XLSXW.utils.book_append_sheet(wb, ws, 'Sheet0');
  const xlsBuffer = XLSXW.write(wb, { type: 'buffer', bookType: 'biff8' });

  t('synthetic fixture is a genuine binary .xls (OLE2/CFB magic)', () => {
    const magic = xlsBuffer.slice(0, 4).toString('hex');
    eq(magic, 'd0cf11e0', 'CFB magic bytes');
  });

  t('the VENDORED build (xlsx.core.min.js, what ships to the browser) reads it', () => {
    const wbRead = XLSXR.read(xlsBuffer, { type: 'buffer', raw: true });
    const sheet = wbRead.Sheets[wbRead.SheetNames[0]];
    const rowsArray = XLSXR.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
    const parsed = E.parseABNRows(rowsArray);
    eq(parsed.length, 2);
    close(parsed[0].amount, -100);
    close(parsed[1].amount, 4500);
    eq(parsed[0].account, '111');
    eq(parsed[0].date, '2026-01-20');
  });

  t('reading .txt through the same fixture bytes fails gracefully (proves text path alone cannot read it)', () => {
    // Simulates what happened before the fix: FileReader.readAsText on a
    // binary .xls yields mojibake, parseABNStatement finds 0 valid rows.
    const asLatin1Text = xlsBuffer.toString('latin1');
    const rows = E.parseABNStatement(asLatin1Text);
    eq(rows.length, 0, 'binary bytes read as text must not silently produce rows');
  });
} catch (e) {
  XLSX_TEST_SKIPPED = true;
  console.log('  \x1b[33m⚠ skipped (xlsx package or vendor/xlsx.core.min.js not available): ' + e.message + '\x1b[0m');
}

console.log('\n' + '='.repeat(48));
console.log(`  ${pass} passed, ${fail} failed${XLSX_TEST_SKIPPED ? ' (binary-xls tests skipped)' : ''}`);
console.log('='.repeat(48) + '\n');
process.exit(fail ? 1 : 0);
