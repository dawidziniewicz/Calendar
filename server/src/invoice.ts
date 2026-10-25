import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { dmy } from './dmy.ts';

// Rachunki: dane wystawcy z ustawień (wszystkie pola opcjonalne), PDF w formacie A4.

export type Party = { name: string; address: string; city: string; nip: string; phone: string; email: string };
export type Seller = Party & { account: string; bank: string };
export type InvoiceItem = { name: string; qty: number; unit: string; price: number };
/** Szablon rachunku: ostatnio użyte dane wystawcy, miejsce, dopisek, stopka, płatność (zapisywane przy wystawianiu). */
export type InvoiceSettings = Party & {
  account: string; bank: string; // puste = konto z ustawień płatności
  place: string; note: string; footer: string | null; // null = stopka z danych wystawcy
  payment_method: string; payment_days: number | null; numbering: 'yearly' | 'monthly'; show_account: boolean;
  signatures: boolean; // pola na podpisy na rachunku
  seller_signature: string; // zapamiętany podpis wystawcy (PNG, data URL) — '' = brak
};
export type InvoiceData = {
  number: string; issue_date: string; sale_date: string; place: string;
  seller: Seller; buyer: Party; items: InvoiceItem[];
  payment_method: string; payment_due: string; paid: number | null; note: string; footer: string;
  signatures: boolean; seller_signature: string; buyer_signature: string; // podpisy złożone palcem (PNG, data URL)
  currency: string; // PLN, EUR, GBP…
};

export const INVOICE_SETTINGS_KEY = 'invoice_settings';
const EMPTY_PARTY: Party = { name: '', address: '', city: '', nip: '', phone: '', email: '' };
export const DEFAULT_INVOICE_SETTINGS: InvoiceSettings = { ...EMPTY_PARTY, account: '', bank: '', place: '', note: '', footer: null, payment_method: 'przelew', payment_days: 7, numbering: 'yearly', show_account: true, signatures: true, seller_signature: '' };

const s = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => {
  const n = Number(typeof v === 'string' ? v.replace(',', '.').replace(/\s/g, '') : v);
  return Number.isFinite(n) ? n : 0;
};
export const round2 = (n: number) => Math.round(n * 100) / 100;

export function readParty(v: unknown): Party {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { name: s(o.name, 200), address: s(o.address), city: s(o.city, 120), nip: s(o.nip, 40), phone: s(o.phone, 40), email: s(o.email, 200) };
}

export function readInvoiceSettings(v: unknown): InvoiceSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    ...readParty(o), account: s(o.account, 60), bank: s(o.bank, 120), place: s(o.place, 120), note: s(o.note, 1000), footer: o.footer == null ? null : s(o.footer, 300),
    payment_method: s(o.payment_method, 60), payment_days: o.payment_days == null || o.payment_days === '' ? null : Math.min(365, Math.max(0, Math.trunc(num(o.payment_days)))),
    numbering: o.numbering === 'monthly' ? 'monthly' : 'yearly', show_account: o.show_account !== false,
    signatures: o.signatures !== false, seller_signature: readSignature(o.seller_signature),
  };
}

export function invoiceSettings(db: DatabaseSync): InvoiceSettings {
  const raw = (db.prepare('SELECT value FROM settings WHERE key = ?').get(INVOICE_SETTINGS_KEY) as { value: string } | undefined)?.value;
  try { return raw ? readInvoiceSettings(JSON.parse(raw)) : { ...DEFAULT_INVOICE_SETTINGS }; } catch { return { ...DEFAULT_INVOICE_SETTINGS }; }
}

/** Podpis z pola do podpisu (PNG jako data URL, maks. ~300 KB); cokolwiek innego = brak podpisu. */
export function readSignature(v: unknown): string {
  return typeof v === 'string' && v.length < 400_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(v) ? v : '';
}
const signatureImage = (v: string) => (v ? Buffer.from(v.slice(v.indexOf(',') + 1), 'base64') : null);

export function readItems(v: unknown): InvoiceItem[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 40).map((it) => {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    return { name: s(o.name, 300), qty: round2(num(o.qty ?? 1)), unit: s(o.unit, 20), price: round2(num(o.price)) };
  }).filter((it) => it.name || it.price);
}
export const itemsTotal = (items: InvoiceItem[]) => round2(items.reduce((sum, it) => sum + round2(it.qty * it.price), 0));

/** Kolejny numer: 1/2026, 2/2026… (albo 1/10/2026 przy numeracji miesięcznej). */
export function nextInvoiceNumber(db: DatabaseSync, issueDate: string, numbering: 'yearly' | 'monthly') {
  const [y, m] = issueDate.split('-');
  const suffix = numbering === 'monthly' ? `/${m}/${y}` : `/${y}`;
  const rows = db.prepare('SELECT number FROM invoices WHERE number LIKE ?').all(`%${suffix}`) as { number: string }[];
  const max = rows.reduce((acc, r) => {
    const head = r.number.slice(0, -suffix.length);
    return /^\d+$/.test(head) ? Math.max(acc, Number(head)) : acc;
  }, 0);
  return `${max + 1}${suffix}`;
}

// ---------------------------------------------------------------------------
// Kwota słownie (po polsku): 1530.5 → „tysiąc pięćset trzydzieści złotych 50/100”
// ---------------------------------------------------------------------------
const ONES = ['', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć'];
const TEENS = ['dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście', 'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście'];
const TENS = ['', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt', 'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt'];
const HUNDREDS = ['', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset', 'sześćset', 'siedemset', 'osiemset', 'dziewięćset'];
const GROUPS: [string, string, string][] = [['', '', ''], ['tysiąc', 'tysiące', 'tysięcy'], ['milion', 'miliony', 'milionów']];

const plural = (n: number, forms: [string, string, string]) => {
  if (n === 1) return forms[0];
  const t = n % 10, h = n % 100;
  return t >= 2 && t <= 4 && (h < 12 || h > 14) ? forms[1] : forms[2];
};
function triple(n: number) {
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), o = n % 10;
  return [HUNDREDS[h], t === 1 ? TEENS[o] : TENS[t], t === 1 ? '' : ONES[o]].filter(Boolean).join(' ');
}
export function amountInWords(amount: number, currency = 'PLN') {
  const zloty = Math.floor(Math.abs(amount) + 1e-9);
  const grosze = Math.round((Math.abs(amount) - zloty) * 100);
  let words = '';
  if (zloty === 0) words = 'zero';
  else {
    const parts: string[] = [];
    let rest = zloty;
    for (let g = 0; rest > 0 && g < GROUPS.length; g++) {
      const n = rest % 1000;
      rest = Math.floor(rest / 1000);
      if (!n) continue;
      const w = g > 0 && n === 1 ? '' : triple(n);
      parts.unshift([w, g ? plural(n, GROUPS[g]) : ''].filter(Boolean).join(' '));
    }
    words = parts.join(' ');
  }
  const unit = currency === 'PLN' ? plural(zloty, ['złoty', 'złote', 'złotych']) : currency === 'EUR' ? 'euro' : currency;
  return `${amount < 0 ? 'minus ' : ''}${words} ${unit} ${String(grosze).padStart(2, '0')}/100`;
}

// ---------------------------------------------------------------------------
// PDF (A4)
// ---------------------------------------------------------------------------
const FONT_DIR = fileURLToPath(new URL('../assets/fonts/', import.meta.url));
let fonts: { regular: Buffer; bold: Buffer; serif: Buffer } | null = null;
const loadFonts = () => (fonts ??= {
  regular: readFileSync(`${FONT_DIR}Manrope_400Regular.ttf`),
  bold: readFileSync(`${FONT_DIR}Manrope_700Bold.ttf`),
  serif: readFileSync(`${FONT_DIR}DMSerifDisplay_400Regular.ttf`),
});

const GREEN = '#577267', SAGE = '#8CA196', SAND = '#C1B1A0', INK = '#1f2a25', MUTED = '#6b776f', LINE = '#e3dcd2', PAPER = '#f6f3ee';
export const plMoney = (n: number) => `${n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ | /g, ' ')} zł`;
const plDate = (iso: string) => dmy(iso);
const qtyText = (n: number) => n.toLocaleString('pl-PL', { maximumFractionDigits: 2 });

/** Kwota na rachunku: 1 200,00 zł / 1 200,00 EUR */
export const invMoney = (n: number, currency = 'PLN') => (currency === 'PLN' ? plMoney(n)
  : `${n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u00a0| /g, ' ')} ${currency}`);

export function renderInvoicePdf(inv: InvoiceData, opts: { qr?: Buffer } = {}): Promise<Buffer> {
  const plMoney = (n: number) => invMoney(n, inv.currency || 'PLN');
  const f = loadFonts();
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Rachunek ${inv.number}`.trim(), Author: inv.seller.name || 'Od Morza do Gór' } });
  doc.registerFont('regular', f.regular);
  doc.registerFont('bold', f.bold);
  doc.registerFont('serif', f.serif);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const W = doc.page.width, H = doc.page.height;
  const M = 50; // margines
  const CW = W - 2 * M;

  // Nagłówek: tytuł i numer | miejsce i daty
  let y = 46;
  doc.font('serif').fontSize(30).fillColor(INK).text('Rachunek', M, y, { lineBreak: false });
  if (inv.number) doc.font('regular').fontSize(12).fillColor(MUTED).text(`nr ${inv.number}`, M, y + 40);
  const meta: [string, string][] = [
    ['Miejsce wystawienia', inv.place],
    ['Data wystawienia', plDate(inv.issue_date)],
    ['Data wykonania usługi', plDate(inv.sale_date)],
  ].filter(([, v]) => v) as [string, string][];
  let my = y + 2;
  for (const [k, v] of meta) {
    doc.font('regular').fontSize(8.5).fillColor(MUTED).text(k.toUpperCase(), W - M - 200, my, { width: 200, align: 'right', characterSpacing: 0.4 });
    doc.font('bold').fontSize(10.5).fillColor(INK).text(v, W - M - 200, my + 11, { width: 200, align: 'right' });
    my += 30;
  }
  y = Math.max(y + 70, my) + 18;

  // Sprzedawca | Nabywca
  const partyLines = (p: Party, extra: string[] = []) => [
    p.address, p.city, p.nip && `NIP: ${p.nip}`, p.phone && `tel. ${p.phone}`, p.email, ...extra,
  ].filter(Boolean) as string[];
  const colW = (CW - 24) / 2;
  const block = (label: string, p: Party, x: number) => {
    if (!p.name && !partyLines(p).length) return y;
    doc.font('bold').fontSize(8.5).fillColor(GREEN).text(label.toUpperCase(), x, y, { width: colW, characterSpacing: 0.8 });
    let by = y + 16;
    if (p.name) {
      doc.font('bold').fontSize(11.5).fillColor(INK).text(p.name, x, by, { width: colW });
      by = doc.y + 3;
    }
    doc.font('regular').fontSize(10).fillColor(INK);
    for (const line of partyLines(p)) {
      doc.text(line, x, by, { width: colW });
      by = doc.y + 1.5;
    }
    return by;
  };
  const endSeller = block('Sprzedawca', inv.seller, M);
  const endBuyer = block('Nabywca', inv.buyer, M + colW + 24);
  y = Math.max(endSeller, endBuyer) + (endSeller > y || endBuyer > y ? 22 : 0);

  // Tabela pozycji
  const cols = [
    { key: 'lp', label: 'Lp.', w: 28, align: 'left' as const },
    { key: 'name', label: 'Nazwa usługi', w: CW - 28 - 48 - 40 - 82 - 88, align: 'left' as const },
    { key: 'qty', label: 'Ilość', w: 48, align: 'right' as const },
    { key: 'unit', label: 'J.m.', w: 40, align: 'center' as const },
    { key: 'price', label: 'Cena jedn.', w: 82, align: 'right' as const },
    { key: 'total', label: 'Wartość', w: 88, align: 'right' as const },
  ];
  const pad = 8;
  doc.roundedRect(M, y, CW, 26, 6).fill(GREEN);
  let x = M;
  for (const c of cols) {
    doc.font('bold').fontSize(8.5).fillColor('#ffffff').text(c.label.toUpperCase(), x + pad, y + 9, { width: c.w - 2 * pad, align: c.align, characterSpacing: 0.4 });
    x += c.w;
  }
  y += 26;
  const items = inv.items.length ? inv.items : [];
  items.forEach((it, i) => {
    const values: Record<string, string> = {
      lp: `${i + 1}.`, name: it.name, qty: qtyText(it.qty), unit: it.unit, price: plMoney(it.price), total: plMoney(round2(it.qty * it.price)),
    };
    doc.font('regular').fontSize(10);
    const nameH = doc.heightOfString(it.name || ' ', { width: cols[1].w - 2 * pad });
    const rowH = Math.max(28, nameH + 16);
    if (y + rowH > H - 200) { doc.addPage(); y = M; }
    if (i % 2 === 1) doc.rect(M, y, CW, rowH).fill(PAPER);
    x = M;
    for (const c of cols) {
      doc.font(c.key === 'total' ? 'bold' : 'regular').fontSize(10).fillColor(INK)
        .text(values[c.key], x + pad, y + 8, { width: c.w - 2 * pad, align: c.align });
      x += c.w;
    }
    y += rowH;
    doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.6).strokeColor(LINE).stroke();
  });
  if (!items.length) {
    doc.font('regular').fontSize(10).fillColor(MUTED).text('Brak pozycji', M + pad, y + 9);
    y += 28;
  }

  // Razem
  const total = itemsTotal(inv.items);
  y += 14;
  const boxW = 250;
  doc.roundedRect(W - M - boxW, y, boxW, 46, 8).fill(PAPER);
  doc.font('regular').fontSize(9).fillColor(MUTED).text('RAZEM DO ZAPŁATY', W - M - boxW + 14, y + 10, { characterSpacing: 0.6 });
  doc.font('serif').fontSize(19).fillColor(GREEN).text(plMoney(total), W - M - boxW + 14, y + 20, { width: boxW - 28, align: 'right' });
  y += 58;
  doc.font('regular').fontSize(9.5).fillColor(MUTED).text('Słownie: ', M, y, { continued: true }).fillColor(INK).text(amountInWords(total, inv.currency || 'PLN'), { width: CW });
  y = doc.y + 18;

  // Płatność
  const paid = inv.paid == null ? null : round2(inv.paid);
  const pay: [string, string][] = [
    ['Sposób płatności', inv.payment_method],
    ['Termin płatności', plDate(inv.payment_due)],
    ...(inv.seller.account && /przelew/i.test(inv.payment_method || 'przelew') ? [[(inv.currency || 'PLN') === 'PLN' ? 'Numer konta' : 'IBAN', `${inv.seller.account}${inv.seller.bank ? ` (${inv.seller.bank})` : ''}`] as [string, string]] : []),
    ...(paid != null ? [['Zapłacono', plMoney(paid)] as [string, string], ['Pozostało do zapłaty', plMoney(Math.max(0, round2(total - paid)))] as [string, string]] : []),
  ].filter(([, v]) => v) as [string, string][];
  if (pay.length || opts.qr) {
    doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.6).strokeColor(LINE).stroke();
    y += 12;
    const top = y;
    const qrSize = 86;
    const valueW = CW - 150 - (opts.qr ? qrSize + 20 : 0);
    for (const [k, v] of pay) {
      doc.font('regular').fontSize(10).fillColor(MUTED).text(k, M, y, { width: 150 });
      doc.font('bold').fontSize(10).fillColor(INK).text(v, M + 150, y, { width: valueW });
      y = Math.max(doc.y, y + 14) + 4;
    }
    // kod QR do zapłaty (aplikacja banku) — po prawej stronie danych płatności
    if (opts.qr) {
      const qx = W - M - qrSize;
      doc.image(opts.qr, qx, top, { width: qrSize, height: qrSize });
      doc.font('regular').fontSize(7).fillColor(MUTED).text('Zeskanuj w aplikacji banku', qx - 10, top + qrSize + 2, { width: qrSize + 20, align: 'center' });
      y = Math.max(y, top + qrSize + 16);
    }
  }

  if (inv.note) {
    y += 10;
    const noteH = doc.font('regular').fontSize(9.5).heightOfString(inv.note, { width: CW - 28 });
    doc.rect(M, y, 3, noteH + 16).fill(SAGE);
    doc.font('regular').fontSize(9.5).fillColor(INK).text(inv.note, M + 14, y + 8, { width: CW - 28 });
    y = doc.y + 14;
  }

  // Podpisy (opcjonalne): pola z linią, nad linią podpis złożony palcem w aplikacji
  const sides = [
    { label: 'Podpis osoby upoważnionej do odbioru', image: signatureImage(inv.buyer_signature) },
    { label: 'Podpis osoby upoważnionej do wystawienia', image: signatureImage(inv.seller_signature) },
  ];
  if (inv.signatures || sides.some((x) => x.image)) {
    const sigH = 56; // miejsce na podpis nad linią
    if (y + sigH + 40 > H - 60) { doc.addPage(); y = M; }
    const sigY = Math.max(y + sigH + 16, H - 140);
    const sw = 190;
    sides.forEach((side, i) => {
      if (!inv.signatures && !side.image) return;
      const sx = i === 0 ? M : W - M - sw;
      if (side.image) {
        try {
          doc.image(side.image, sx + 10, sigY - sigH - 2, { fit: [sw - 20, sigH], align: 'center', valign: 'bottom' });
        } catch { /* uszkodzony obraz — samo pole */ }
      }
      doc.moveTo(sx, sigY).lineTo(sx + sw, sigY).lineWidth(0.6).dash(2, { space: 2 }).strokeColor(SAND).stroke().undash();
      doc.font('regular').fontSize(8).fillColor(MUTED).text(side.label, sx, sigY + 6, { width: sw, align: 'center' });
    });
  }

  // Stopka (edytowalna, pusta = brak)
  if (inv.footer) {
    doc.moveTo(M, H - 52).lineTo(M + CW, H - 52).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('regular').fontSize(8).fillColor(MUTED).text(inv.footer, M, H - 42, { width: CW, align: 'center', height: 30 });
  }

  doc.end();
  return done;
}

/** Stopka domyślna: dane wystawcy w jednej linii */
export const autoFooter = (p: Party) => [p.name, p.address && p.city ? `${p.address}, ${p.city}` : p.address || p.city, p.phone && `tel. ${p.phone}`, p.email].filter(Boolean).join(' · ');

/** Wiersz z bazy → dane do PDF */
export type InvoiceRow = {
  id: number; number: string; reservation_id: number | null; issue_date: string; sale_date: string; place: string;
  seller: string; buyer: string; items: string; total: number; payment_method: string; payment_due: string; paid: number | null; note: string; footer: string;
  signatures: number; seller_signature: string; buyer_signature: string; currency: string;
  created_by: string; created_at: string; updated_at: string;
};
const parse = <T>(raw: string, fallback: T): T => { try { return JSON.parse(raw) as T; } catch { return fallback; } };
export function invoiceData(row: InvoiceRow): InvoiceData {
  return {
    number: row.number, issue_date: row.issue_date, sale_date: row.sale_date, place: row.place,
    seller: { ...EMPTY_PARTY, account: '', bank: '', ...parse<Partial<Seller>>(row.seller, {}) }, buyer: { ...EMPTY_PARTY, ...parse<Partial<Party>>(row.buyer, {}) },
    items: readItems(parse(row.items, [])), payment_method: row.payment_method, payment_due: row.payment_due, paid: row.paid, note: row.note, footer: row.footer ?? '',
    signatures: row.signatures !== 0, seller_signature: row.seller_signature ?? '', buyer_signature: row.buyer_signature ?? '',
    currency: row.currency || 'PLN',
  };
}
export const invoiceFileName = (number: string) => `Rachunek-${(number || 'bez-numeru').replace(/[^\w-]+/g, '-')}.pdf`;
