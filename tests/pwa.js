#!/usr/bin/env node
/* PWA sanity: manifest is valid & complete, service worker is coherent, icons
   exist as real PNGs, and the built index.html is offline-ready (Chart.js
   inlined, no CDN) with the manifest + SW wired in. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + n); } catch (e) { fail++; console.log('  \x1b[31m✗ ' + n + '\x1b[0m — ' + e.message); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('\n=== PWA sanity ===');

t('manifest.webmanifest is valid JSON with required fields + relative paths', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  ['name', 'short_name', 'start_url', 'scope', 'display', 'icons'].forEach(k => assert.ok(m[k] != null, 'missing ' + k));
  assert.strictEqual(m.display, 'standalone');
  assert.ok(m.start_url.startsWith('.') && m.scope.startsWith('.'), 'paths must be relative for a Pages sub-path');
  const has = (s) => m.icons.some(i => i.sizes === s || i.sizes === 'any');
  assert.ok(has('192x192') && has('512x512'), 'need 192 and 512 icons');
  assert.ok(m.icons.some(i => i.purpose === 'maskable'), 'need a maskable icon');
});

t('every manifest icon file exists', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  m.icons.forEach(i => assert.ok(fs.existsSync(path.join(ROOT, i.src)), 'missing ' + i.src));
});

t('PNG icons are real PNGs with the declared dimensions', () => {
  [['icons/icon-192.png', 192], ['icons/icon-512.png', 512], ['icons/icon-maskable-512.png', 512]].forEach(([p, dim]) => {
    const b = fs.readFileSync(path.join(ROOT, p));
    assert.strictEqual(b.slice(1, 4).toString(), 'PNG', p + ' not a PNG');
    assert.strictEqual(b.readUInt32BE(16), dim);
    assert.strictEqual(b.readUInt32BE(20), dim);
  });
});

t('service worker caches the shell and is same-origin scoped', () => {
  const sw = read('sw.js');
  assert.ok(/const CACHE\s*=/.test(sw), 'no cache version');
  assert.ok(sw.includes('./index.html') && sw.includes('./manifest.webmanifest'), 'shell not precached');
  assert.ok(sw.includes('url.origin !== location.origin'), 'must skip cross-origin (AI API) requests');
});

t('built index.html is offline-ready: Chart.js inlined, no CDN, PWA wired', () => {
  const html = read('index.html');
  assert.ok(html.includes('<script id="vendor-chart">'), 'Chart.js not inlined — run node build.js');
  assert.ok(!/cdn\.jsdelivr|https:\/\/cdn/.test(html), 'a CDN reference remains');
  assert.ok(/<link rel="manifest" href="manifest\.webmanifest">/.test(html), 'manifest not linked');
  assert.ok(/serviceWorker/.test(html) && html.includes("register('sw.js')"), 'SW not registered');
  assert.ok(/<meta name="theme-color"/.test(html), 'theme-color missing');
});

t('.nojekyll present (so Pages serves files verbatim)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, '.nojekyll')));
});

console.log('\n' + '='.repeat(40) + `\n  ${pass} passed, ${fail} failed\n` + '='.repeat(40) + '\n');
process.exit(fail ? 1 : 0);
