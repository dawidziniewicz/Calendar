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

const BG = [31, 95, 85], PAPER = [250, 247, 240], ACCENT = [217, 119, 66], GRID = [196, 214, 208];
const inRect = (x, y, x0, y0, x1, y1, r = 0) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

function pixel(u, v, pad) {
  // u, v w zakresie 0..1; pad zmniejsza rysunek (maskable ma "bezpieczną strefę")
  const s = (t) => (t - pad) / (1 - 2 * pad);
  const x = s(u), y = s(v);
  if (inRect(x, y, 0.16, 0.2, 0.84, 0.84, 0.07)) {
    if (y < 0.36) return ACCENT;
    for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) {
      const x0 = 0.24 + col * 0.14, y0 = 0.44 + row * 0.12;
      if (inRect(x, y, x0, y0, x0 + 0.09, y0 + 0.07, 0.015)) return row === 1 && col === 2 ? BG : GRID;
    }
    return PAPER;
  }
  if (inRect(x, y, 0.3, 0.12, 0.36, 0.28, 0.03) || inRect(x, y, 0.64, 0.12, 0.7, 0.28, 0.03)) return PAPER;
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
