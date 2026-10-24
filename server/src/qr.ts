import QRCode from 'qrcode';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Kody QR do płatności:
// - przelew krajowy (PLN) wg rekomendacji ZBP — czytają go aplikacje polskich banków,
// - przelew SEPA w euro (EPC QR / „GiroCode”) — aplikacje banków w strefie euro,
// - Revolut: link revolut.me/<Revtag> (kwotę gość wpisuje sam — Revolut nie pozwala jej wpisać w link).
// Obrazki są pod podpisanym adresem /public/qr/<treść>.png?s=<podpis>, żeby nikt nie używał serwera jako generatora QR.

const digits = (s: string) => s.replace(/\D/g, '');
const clean = (s: string, max: number) => s.replace(/[|\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

/** Polski numer rachunku (26 cyfr, z „PL” lub bez) → 26 cyfr albo null */
export function polishNrb(account: string) {
  const s = account.replace(/\s/g, '').toUpperCase();
  const d = s.startsWith('PL') ? s.slice(2) : s;
  return /^\d{26}$/.test(d) ? d : null;
}
/** IBAN bez spacji (2 litery + 2 cyfry + do 30 znaków) albo null */
export function iban(account: string) {
  const s = account.replace(/\s/g, '').toUpperCase();
  if (/^\d{26}$/.test(s)) return `PL${s}`; // polski NRB jako IBAN
  return /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s) ? s : null;
}

/** Rekomendacja ZBP: NIP|PL|NRB|kwota w groszach (min. 6 cyfr)|odbiorca (20)|tytuł (32)||| */
export function plBankPayload(o: { account: string; amount: number; name: string; title: string; nip?: string }) {
  const nrb = polishNrb(o.account);
  if (!nrb || !(o.amount > 0)) return null;
  const grosze = String(Math.round(o.amount * 100)).padStart(6, '0');
  if (grosze.length > 10) return null;
  return [digits(o.nip ?? ''), 'PL', nrb, grosze, clean(o.name || 'Odbiorca', 20), clean(o.title, 32), '', '', ''].join('|');
}

/** EPC QR (SEPA Credit Transfer, wersja 002 — BIC opcjonalny w EOG) — tylko EUR */
export function epcPayload(o: { account: string; bic?: string; amount: number; name: string; text: string }) {
  const ib = iban(o.account);
  if (!ib || !(o.amount > 0) || o.amount > 999_999_999) return null;
  return ['BCD', '002', '1', 'SCT', (o.bic ?? '').replace(/\s/g, '').toUpperCase(), clean(o.name || 'Beneficiary', 70), ib, `EUR${o.amount.toFixed(2)}`, '', '', clean(o.text, 140)].join('\n');
}

/** Revtag („@jan123”, „jan123”, „revolut.me/jan123”) → https://revolut.me/jan123 albo null */
export function revolutUrl(tag: string) {
  const t = tag.trim().replace(/^https?:\/\//, '').replace(/^(www\.)?revolut\.me\//i, '').replace(/^@/, '').replace(/\/.*$/, '');
  return /^[a-z0-9._-]{2,40}$/i.test(t) ? `https://revolut.me/${t.toLowerCase()}` : null;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const sign = (key: string, data: string) => createHmac('sha256', `qr:${key}`).update(data).digest('hex').slice(0, 20);

/** Ścieżka obrazka QR (względem /public) */
export const qrPath = (key: string, payload: string) => {
  const data = b64url(payload);
  return `/qr/${data}.png?s=${sign(key, data)}`;
};

/** Sprawdzenie podpisu i odczyt treści z adresu */
export function qrFromPath(key: string, data: string, sig: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,700}$/.test(data) || !/^[a-f0-9]{20}$/.test(sig)) return null;
  const good = Buffer.from(sign(key, data));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
  return Buffer.from(data, 'base64url').toString('utf8');
}

export const qrPng = (payload: string, width = 360) =>
  QRCode.toBuffer(payload, { type: 'png', width, margin: 2, errorCorrectionLevel: payload.startsWith('BCD\n') ? 'M' : 'L', color: { dark: '#1f2a25', light: '#ffffff' } });
