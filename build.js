#!/usr/bin/env node
/* Assembles the single-file deliverable index.html from:
   shell.head.html (HTML+CSS) + engine.js + app.js.
   No runtime build — this is a dev-side concatenation so engine.js stays the
   single source of truth shared with the test harness. */
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const shell = fs.readFileSync(path.join(dir, 'shell.head.html'), 'utf8');
const engine = fs.readFileSync(path.join(dir, 'engine.js'), 'utf8');
const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
// Inline the vendored Chart.js so the app is fully offline (no CDN). Kept in a
// tagged <script id="vendor-chart"> block the test harness strips (it stubs
// Chart itself). Falls back to the CDN tag if the vendor file is absent.
let vendorTag = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>';
try {
  const chart = fs.readFileSync(path.join(dir, 'vendor', 'chart.umd.min.js'), 'utf8');
  vendorTag = '<script id="vendor-chart">' + chart + '\n</script>';
} catch (e) { console.warn('vendor/chart.umd.min.js not found — using CDN tag'); }
const out = shell
  .replace('<!--VENDOR_CHART-->', () => vendorTag)
  .replace('/*<<ENGINE>>*/', () => engine)
  .replace('/*<<APP>>*/', () => app);
fs.writeFileSync(path.join(dir, 'index.html'), out);
console.log('Built index.html (' + out.length + ' bytes, Chart.js ' + (vendorTag.startsWith('<script id') ? 'inlined' : 'CDN') + ')');
