#!/usr/bin/env node
/* Generate PWA PNG icons with no external dependency (minimal RGBA PNG encoder).
   Draws the same motif as icons/icon.svg: blue tile + white growth bars + green
   dot. `maskable` = full-bleed square (fills Android's mask); otherwise rounded
   with transparent corners. Run: node tools/gen-icons.js */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// colors
const BLUE = [52, 152, 219, 255];
const WHITE = [255, 255, 255, 255];
const GREEN = [46, 204, 113, 255];
const CLEAR = [0, 0, 0, 0];

function drawIcon(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = (v) => v * size; // normalized → px
  const radius = maskable ? 0 : s(0.1875); // 96/512
  const bars = [
    { x0: 0.24, x1: 0.36, top: 0.54 },
    { x0: 0.44, x1: 0.56, top: 0.40 },
    { x0: 0.64, x1: 0.76, top: 0.26 },
  ];
  const baseline = 0.74;
  const dot = { cx: s(0.80), cy: s(0.20), r: s(0.075) };
  const inRounded = (x, y) => {
    if (maskable) return true;
    const r = radius;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x <= size - r) || (y >= r && y <= size - r);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let col = CLEAR;
      if (inRounded(x + 0.5, y + 0.5)) {
        col = BLUE;
        for (const b of bars) {
          if (x >= s(b.x0) && x < s(b.x1) && y >= s(b.top) && y < s(baseline)) col = WHITE;
        }
        if ((x - dot.cx) ** 2 + (y - dot.cy) ** 2 <= dot.r * dot.r) col = GREEN;
      }
      const o = (y * size + x) * 4;
      rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2]; rgba[o + 3] = col[3];
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.writeFileSync(path.join(outDir, 'icon-192.png'), drawIcon(192, false));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), drawIcon(512, false));
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), drawIcon(512, true));
console.log('icons written: 192, 512, maskable-512');
