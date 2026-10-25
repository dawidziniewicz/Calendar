import QRCode from 'qrcode';

// Plakat „zarezerwuj bezpośrednio” i zdjęcia przycięte do formatu portalu — rysowane w przeglądarce (canvas),
// czcionki i kolory jak na stronie odmorzadogor.pl (DM Serif Display + Manrope, zieleń sosny i piasek).

const C = { pine: '#577267', pineDeep: '#3f554b', pineInk: '#26352e', sand: '#C1B1A0', sandSoft: '#ebe3d8', paper: '#f6f2ec', ink: '#1f2925', muted: '#5d6a63', cream: '#F5F1EA' };
const SERIF = '"Poster Serif", "DM Serif Display", Georgia, serif';
const SANS = '"Poster Sans", Manrope, system-ui, sans-serif';

const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';

let fonts: Promise<void> | null = null;
export const loadFonts = () => (fonts ??= (async () => {
  const faces = [
    new FontFace('Poster Serif', 'url(/fonts/dm-serif-display-latin-400-normal.woff2)', { unicodeRange: LATIN }),
    new FontFace('Poster Serif', 'url(/fonts/dm-serif-display-latin-ext-400-normal.woff2)', { unicodeRange: LATIN_EXT }),
    new FontFace('Poster Sans', 'url(/fonts/manrope-latin-wght-normal.woff2)', { weight: '200 800', unicodeRange: LATIN }),
    new FontFace('Poster Sans', 'url(/fonts/manrope-latin-ext-wght-normal.woff2)', { weight: '200 800', unicodeRange: LATIN_EXT }),
  ];
  await Promise.all(faces.map(async (f) => { document.fonts.add(await f.load()); }));
})().catch((e) => { fonts = null; throw e; }));

const photos = new Map<string, Promise<ImageBitmap>>();
export function loadPhoto(url: string) {
  let p = photos.get(url);
  if (!p) {
    p = fetch(url, { mode: 'cors' }).then((r) => {
      if (!r.ok) throw new Error(`Nie udało się pobrać zdjęcia (${r.status})`);
      return r.blob();
    }).then((b) => createImageBitmap(b));
    p.catch(() => photos.delete(url));
    photos.set(url, p);
  }
  return p;
}

/** Wycinek zdjęcia w proporcjach w:h (środek, lekko wyżej — niebo i dachy zostają) */
function coverRect(img: { width: number; height: number }, w: number, h: number, focusY = 0.45) {
  const target = w / h;
  if (img.width / img.height > target) {
    const sw = img.height * target;
    return { sx: (img.width - sw) / 2, sy: 0, sw, sh: img.height };
  }
  const sh = img.width / target;
  return { sx: 0, sy: Math.max(0, Math.min(img.height - sh, (img.height - sh) * focusY)), sw: img.width, sh };
}

const toJpeg = (canvas: HTMLCanvasElement, q = 0.9) => new Promise<Blob>((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error('Nie udało się zapisać obrazu'))), 'image/jpeg', q));

/** Zdjęcie w formacie portalu (JPEG). Nie powiększamy: małe zdjęcie daje mniejszy plik w tych samych proporcjach. */
export async function photoJpeg(img: ImageBitmap, W: number, H: number) {
  const r = coverRect(img, W, H, 0.5);
  const scale = Math.min(1, r.sw / W);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, canvas.width, canvas.height);
  return toJpeg(canvas, 0.9);
}

export type PosterContent = {
  photo: ImageBitmap;
  brand: string; domain: string; headline: string; region: string; name: string;
  facts: string[]; // „Do 11 osób”, „od 450 zł / noc”, „Ocena 5,0 w Google”
  highlights: string[];
  note: string; // „Bez prowizji pośredników”
  phone: string;
  qr: string; // adres do kodu QR ('' = bez kodu)
  logo: boolean;
};

/** Tekst w jednej linii, zmniejszany aż się zmieści */
function fitFont(ctx: CanvasRenderingContext2D, text: string, family: string, weight: string, size: number, maxWidth: number, min: number) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > min && ctx.measureText(text).width > maxWidth) {
    s -= 1;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}
/** Podział na linie (najwyżej `max` linii) */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, max = 2) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, max);
}
function spaced(ctx: CanvasRenderingContext2D, px: number) {
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px}px`;
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function logoMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 64, size / 64);
  roundRect(ctx, 0, 0, 64, 64, 15);
  ctx.fillStyle = C.pine;
  ctx.fill();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.8;
  ctx.strokeStyle = C.cream;
  ctx.stroke(new Path2D('M12 38 25 19l7 9 5-6 15 16'));
  ctx.strokeStyle = C.sand;
  ctx.stroke(new Path2D('M12 46c3.3 0 3.3-3 6.6-3s3.3 3 6.6 3 3.3-3 6.6-3 3.3 3 6.6 3 3.3-3 6.6-3 3.3 3 6.6 3'));
  ctx.restore();
}

/** Plakat W×H: zdjęcie obiektu, nazwa, najważniejsze informacje i karta z adresem strony */
export async function drawPoster(canvas: HTMLCanvasElement, W: number, H: number, p: PosterContent) {
  await loadFonts();
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const u = Math.min(W, H) / 1080;
  const pad = Math.round(64 * u);
  const inner = W - pad * 2;

  // zdjęcie + przyciemnienie u góry (logo) i u dołu (tekst)
  const r = coverRect(p.photo, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(p.photo, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
  const top = ctx.createLinearGradient(0, 0, 0, H * 0.24);
  top.addColorStop(0, 'rgba(22, 32, 28, 0.55)');
  top.addColorStop(1, 'rgba(22, 32, 28, 0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, H * 0.24);

  // ---- karta z adresem strony (od dołu) ----
  const qrSize = p.qr ? Math.round(150 * u) : 0;
  const cardPad = Math.round(34 * u);
  ctx.textBaseline = 'alphabetic';
  const textW = inner - cardPad * 2 - (qrSize ? qrSize + cardPad : 0);
  const headSize = fitFont(ctx, p.headline, SANS, '600', Math.round(27 * u), textW, Math.round(16 * u));
  const domainSize = fitFont(ctx, p.domain, SERIF, '400', Math.round(76 * u), textW, Math.round(36 * u));
  const sub = [p.note, p.phone].filter(Boolean).join('  ·  ');
  const subSize = sub ? fitFont(ctx, sub, SANS, '500', Math.round(23 * u), textW, Math.round(14 * u)) : 0;
  const textH = headSize * 1.25 + domainSize * 1.05 + (sub ? subSize * 1.6 : 0);
  const cardH = Math.round(Math.max(textH, qrSize) + cardPad * 2);
  const cardY = H - pad - cardH;

  // przyciemnienie dołu sięga ponad blok tekstu
  const fadeFrom = Math.max(H * 0.1, cardY - 600 * u);
  const bottom = ctx.createLinearGradient(0, fadeFrom, 0, H);
  bottom.addColorStop(0, 'rgba(24, 34, 30, 0)');
  bottom.addColorStop(0.28, 'rgba(24, 34, 30, 0.55)');
  bottom.addColorStop(0.55, 'rgba(24, 34, 30, 0.8)');
  bottom.addColorStop(1, 'rgba(24, 34, 30, 0.93)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, fadeFrom, W, H - fadeFrom);

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
  ctx.shadowBlur = 30 * u;
  ctx.shadowOffsetY = 8 * u;
  roundRect(ctx, pad, cardY, inner, cardH, 26 * u);
  ctx.fillStyle = C.paper;
  ctx.fill();
  ctx.restore();
  // pasek w kolorze piasku po lewej
  roundRect(ctx, pad, cardY, 10 * u, cardH, 5 * u);
  ctx.fillStyle = C.sand;
  ctx.fill();

  let ty = cardY + cardPad + (Math.max(textH, qrSize) - textH) / 2;
  const tx = pad + cardPad + 6 * u;
  ctx.fillStyle = C.pineDeep;
  ctx.font = `600 ${headSize}px ${SANS}`;
  ty += headSize;
  ctx.fillText(p.headline, tx, ty);
  ctx.fillStyle = C.ink;
  ctx.font = `400 ${domainSize}px ${SERIF}`;
  ty += domainSize * 1.05;
  ctx.fillText(p.domain, tx, ty);
  if (sub) {
    ctx.fillStyle = C.muted;
    ctx.font = `500 ${subSize}px ${SANS}`;
    ty += subSize * 1.6;
    ctx.fillText(sub, tx, ty);
  }
  if (p.qr) {
    const q = document.createElement('canvas');
    await QRCode.toCanvas(q, p.qr, { margin: 0, width: qrSize, color: { dark: C.pineInk, light: '#00000000' }, errorCorrectionLevel: 'M' });
    ctx.drawImage(q, pad + inner - cardPad - qrSize, cardY + (cardH - qrSize) / 2, qrSize, qrSize);
  }

  // ---- nad kartą: wyróżniki, fakty, nazwa, region (od dołu do góry) ----
  let y = cardY - Math.round(30 * u);
  if (p.highlights.length) {
    const size = Math.round(23 * u);
    ctx.font = `600 ${size}px ${SANS}`;
    const ph = Math.round(size * 2.1), gap = Math.round(10 * u), px = Math.round(18 * u);
    // pigułki w jednej lub dwóch liniach
    const rows: string[][] = [[]];
    let rowW = 0;
    for (const h of p.highlights) {
      const w = ctx.measureText(h).width + px * 2;
      if (rowW + w > inner && rows.at(-1)!.length) { rows.push([]); rowW = 0; }
      rows.at(-1)!.push(h);
      rowW += w + gap;
    }
    for (const row of rows.reverse()) {
      y -= ph;
      let x = pad;
      for (const h of row) {
        const w = ctx.measureText(h).width + px * 2;
        roundRect(ctx, x, y, w, ph, ph / 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
        ctx.lineWidth = Math.max(1, 1.5 * u);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.fillText(h, x + px, y + ph / 2 + size * 0.36);
        x += w + gap;
      }
      y -= gap;
    }
    y -= Math.round(16 * u);
  }
  if (p.facts.length) {
    const text = p.facts.join('   ·   ');
    const size = fitFont(ctx, text, SANS, '600', Math.round(29 * u), inner, Math.round(16 * u));
    ctx.fillStyle = C.sandSoft;
    ctx.fillText(text, pad, y);
    y -= size * 1.55;
  }
  if (p.name) {
    let size = Math.round(104 * u);
    ctx.font = `400 ${size}px ${SERIF}`;
    let lines = wrap(ctx, p.name, inner, 2);
    while (size > 54 * u && (lines.length > 2 || lines.some((l) => ctx.measureText(l).width > inner))) {
      size -= 2;
      ctx.font = `400 ${size}px ${SERIF}`;
      lines = wrap(ctx, p.name, inner, 2);
    }
    ctx.fillStyle = '#fff';
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 18 * u;
    for (const l of [...lines].reverse()) {
      ctx.fillText(l, pad - 2 * u, y);
      y -= size * 1.02;
    }
    ctx.restore();
    y -= Math.round(14 * u);
  }
  if (p.region) {
    const size = Math.round(21 * u);
    ctx.font = `700 ${size}px ${SANS}`;
    spaced(ctx, 3.2 * u);
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 10 * u;
    ctx.fillStyle = '#ddd2c4';
    ctx.fillText(p.region.toUpperCase(), pad, y);
    ctx.restore();
    spaced(ctx, 0);
  }

  // ---- logo u góry ----
  if (p.logo) {
    const s = Math.round(62 * u);
    logoMark(ctx, pad, pad, s);
    const size = Math.round(36 * u);
    ctx.font = `400 ${size}px ${SERIF}`;
    ctx.fillStyle = '#fff';
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 12 * u;
    ctx.fillText(p.brand, pad + s + 18 * u, pad + s / 2 + size * 0.34);
    ctx.restore();
  }
}

export const posterJpeg = async (W: number, H: number, p: PosterContent) => {
  const canvas = document.createElement('canvas');
  await drawPoster(canvas, W, H, p);
  return toJpeg(canvas, 0.92);
};
