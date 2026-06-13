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
const out = shell
  .replace('/*<<ENGINE>>*/', () => engine)
  .replace('/*<<APP>>*/', () => app);
fs.writeFileSync(path.join(dir, 'index.html'), out);
console.log('Built index.html (' + out.length + ' bytes)');
