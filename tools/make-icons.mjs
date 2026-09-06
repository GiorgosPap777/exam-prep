#!/usr/bin/env node
// Generates the PWA icons as PNGs using only node's built-in zlib.
// Run once:  node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');
mkdirSync(outDir, { recursive: true });

/* ── PNG encoder ───────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ── Drawing ───────────────────────────────────────────── */
const BG_A = [99, 102, 241];   // --accent-1  #6366F1
const BG_B = [139, 92, 246];  // --accent-2  #8B5CF6
const FG = [255, 255, 255];   // white

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// scale: 1.0 fills the tile; 0.72 keeps clear of a maskable icon's safe zone.
function draw(size, scale) {
  const buf = Buffer.alloc(size * size * 3);
  const cx = 0.5, cy = 0.5;
  const R = 0.30 * scale;          // bond length
  const rC = 0.135 * scale;        // central atom
  const rO = 0.093 * scale;        // outer atoms
  const bond = 0.042 * scale;      // bond half-width

  const atoms = [[cx, cy]];
  for (const deg of [-90, 30, 150]) {
    const a = (deg * Math.PI) / 180;
    atoms.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      let ink = 0;

      for (let i = 1; i < atoms.length; i++) {
        const d = distToSegment(u, v, atoms[0][0], atoms[0][1], atoms[i][0], atoms[i][1]);
        ink = Math.max(ink, coverage(d, bond, size));
      }
      ink = Math.max(ink, coverage(Math.hypot(u - atoms[0][0], v - atoms[0][1]), rC, size));
      for (let i = 1; i < atoms.length; i++) {
        ink = Math.max(ink, coverage(Math.hypot(u - atoms[i][0], v - atoms[i][1]), rO, size));
      }

      // 135° gradient across the tile, then the white molecule on top.
      const g = Math.max(0, Math.min(1, (u + v) / 2));
      const o = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        const bg = BG_A[c] + (BG_B[c] - BG_A[c]) * g;
        buf[o + c] = Math.round(bg + (FG[c] - bg) * ink);
      }
    }
  }
  return buf;
}

// Antialiased edge: 1 inside, 0 outside, smooth across ~1px.
function coverage(dist, radius, size) {
  const aa = 1.2 / size;
  return Math.max(0, Math.min(1, (radius - dist) / aa + 0.5));
}

const targets = [
  ['icon-192.png', 192, 1.0],
  ['icon-512.png', 512, 1.0],
  ['icon-maskable-512.png', 512, 0.72],
  ['apple-touch-icon-180.png', 180, 1.0]
];

for (const [name, size, scale] of targets) {
  writeFileSync(join(outDir, name), encodePNG(size, size, draw(size, scale)));
  console.log(`icons/${name}  ${size}×${size}`);
}
