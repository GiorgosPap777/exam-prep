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

// Signed distance to a rounded box centred on (cx, cy): negative inside.
function distToRoundedBox(px, py, cx, cy, half, radius) {
  const qx = Math.abs(px - cx) - (half - radius);
  const qy = Math.abs(py - cy) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
         Math.min(Math.max(qx, qy), 0) - radius;
}

// A ticked answer box: subject-neutral, and still legible at 48px.
// scale: 1.0 fills the tile; 0.72 keeps clear of a maskable icon's safe zone.
function draw(size, scale) {
  const buf = Buffer.alloc(size * size * 3);
  const cx = 0.5, cy = 0.5;
  const half = 0.30 * scale;       // box half-extent
  const radius = 0.10 * scale;     // corner rounding
  const frame = 0.030 * scale;     // box stroke half-width
  const tick = 0.040 * scale;      // check stroke half-width

  // Check mark, relative to the centre of the tile.
  const pts = [[-0.150, 0.005], [-0.040, 0.115], [0.155, -0.095]]
    .map(([x, y]) => [cx + x * scale, cy + y * scale]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      let ink = 0;

      const box = distToRoundedBox(u, v, cx, cy, half, radius);
      ink = Math.max(ink, coverage(Math.abs(box), frame, size));

      for (let i = 1; i < pts.length; i++) {
        const d = distToSegment(u, v, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
        ink = Math.max(ink, coverage(d, tick, size));
      }

      // 135° gradient across the tile, then the white mark on top.
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
