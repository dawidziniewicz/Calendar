// Generuje ikony PNG aplikacji (bez zewnętrznych zależności): node scripts/icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}

// Logo Od Morza do Gór: linia gór nad falą morza, kolory strony (#577267 · #8CA196 · #C1B1A0)
const BG = [87, 114, 103], CREAM = [245, 241, 234], SAND = [193, 177, 160];

const distSeg = (x, y, [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};
// Ten sam rysunek co logo SVG (viewBox 64): góry 12,38 → 25,19 → 32,28 → 37,22 → 52,38; fala y = 44.5 ± 1.5
const MOUNTAINS = [[12, 38], [25, 19], [32, 28], [37, 22], [52, 38]].map(([x, y]) => [x / 64, y / 64]);
const STROKE = 3.6 / 64 / 2;

function pixel(u, v, pad) {
  // u, v w zakresie 0..1; pad zmniejsza rysunek (maskable ma "bezpieczną strefę")
  const s = (t) => (t - pad) / (1 - 2 * pad);
  const x = s(u), y = s(v);
  for (let i = 0; i < MOUNTAINS.length - 1; i++) if (distSeg(x, y, MOUNTAINS[i], MOUNTAINS[i + 1]) <= STROKE) return CREAM;
  if (x >= 12 / 64 - STROKE && x <= 52 / 64 + STROKE) {
    // fala: okres 13.2/64, amplituda 1.5/64 — liczona jako odległość od krzywej (przybliżenie pionowe wystarcza)
    const wx = Math.min(Math.max(x, 12 / 64), 52 / 64);
    const wy = 44.5 / 64 + (1.5 / 64) * Math.cos(((wx - 12 / 64) / (13.2 / 64)) * 2 * Math.PI);
    if (Math.hypot(x - wx, y - wy) <= STROKE * 1.05) return SAND;
  }
  return BG;
}

function png(size, pad) {
  const ss = 3; // antyaliasing
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) {
        const p = pixel((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size, pad);
        acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2];
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(acc[k] / (ss * ss));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = new URL('../public/icons/', import.meta.url);
writeFileSync(new URL('apple-touch-icon.png', out), png(180, 0.02));
writeFileSync(new URL('icon-192.png', out), png(192, 0.02));
writeFileSync(new URL('icon-512.png', out), png(512, 0.02));
writeFileSync(new URL('icon-maskable-512.png', out), png(512, 0.12));
console.log('Ikony wygenerowane');
