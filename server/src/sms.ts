import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { extrasLines, firstName, guestUnitName, mailLang, parseChosenExtras, sitePath, siteUrl, unitInfo } from './booking.ts';
import { accountFor, defaultDeposit, paymentQrs, paymentSettings, readCurrency, revolutLink, titleRange, type Stay } from './payments.ts';

// SMS / WhatsApp do gościa: szablony z polami {imie}, {przyjazd}… oraz link do strony płatności na odmorzadogor.pl.
// Link jest podpisany (nie da się zgadnąć innej rezerwacji) i pokazuje aktualną kwotę: zaliczkę albo dopłatę,
// numer konta, tytuł przelewu, kody QR i Revolut. Po wpłacie strona pokazuje „Opłacone”.

export type PayKind = 'deposit' | 'balance';
export type SmsTemplate = { id: number; name: string; body: string; property_id: number | null; unit_id: number | null; sort: number };

type PayReservation = Stay & { id: number; status: string; guest_phone?: string };

const sig = (key: string, id: number, kind: PayKind) => createHmac('sha256', key).update(`pay:${id}:${kind}`).digest('base64url').slice(0, 16);

/** Link do strony płatności: https://odmorzadogor.pl/oferta/?p=123.z.PODPIS (z = zaliczka, d = dopłata) */
export function payUrl(key: string, r: { id: number; lang?: string | null }, kind: PayKind) {
  return `${siteUrl()}${sitePath(r.lang, 'offer')}?p=${r.id}.${kind === 'deposit' ? 'z' : 'd'}.${sig(key, r.id, kind)}`;
}

/** Odczyt kodu z linku; null, gdy podpis się nie zgadza */
export function readPayCode(key: string, code: string): { id: number; kind: PayKind } | null {
  const m = /^(\d{1,9})\.([zd])\.([A-Za-z0-9_-]{16})$/.exec(code);
  if (!m) return null;
  const id = Number(m[1]);
  const kind: PayKind = m[2] === 'z' ? 'deposit' : 'balance';
  const want = sig(key, id, kind);
  return timingSafeEqual(Buffer.from(m[3]), Buffer.from(want)) ? { id, kind } : null;
}

/** Ile gość ma zapłacić: zaliczka (minus wpłaty) albo reszta ceny. */
export function payAmount(r: Stay, kind: PayKind): number | null {
  const paid = r.paid ?? 0;
  if (kind === 'deposit') return r.deposit != null && r.deposit > 0 ? Math.max(0, r.deposit - paid) : null;
  return r.price != null ? Math.max(0, r.price - paid) : null;
}

/**
 * To, co gość widzi pod linkiem (strona oferty na odmorzadogor.pl z ?p=…). W aplikacji ten sam widok służy do podglądu —
 * wtedy z kwotą i terminem zaliczki jeszcze niezapisanymi w rezerwacji (override).
 */
export function payView(db: DatabaseSync, r: PayReservation, kind: PayKind, override?: { deposit?: number | null; deposit_due?: string | null }) {
  const st: PayReservation = { ...r, ...(override ?? {}) };
  const lang = mailLang(st.lang);
  const en = lang === 'en';
  const currency = readCurrency(st.currency);
  const u = unitInfo(db, st.unit_id);
  const amount = payAmount(st, kind);
  const state = st.status === 'cancelled' ? 'withdrawn' : amount === 0 ? 'paid' : 'pay';
  const ps = paymentSettings(db);
  const acc = accountFor(ps, currency);
  const revolut = revolutLink(ps);
  const range = titleRange(st.check_in, st.check_out, lang);
  const title = `${kind === 'deposit' ? (en ? 'Deposit' : 'Zaliczka') : (en ? 'Balance' : 'Dopłata')} – ${st.guest_name}, ${range}`;
  return {
    state, kind, lang: st.lang ?? 'pl', guest: firstName(st.guest_name),
    property: u.property, unit: guestUnitName(u, lang),
    check_in: st.check_in, check_out: st.check_out, adults: st.adults, children: st.children,
    extras: extrasLines(parseChosenExtras(st.extras), lang),
    price: st.price ?? null, paid: st.paid ?? 0, amount, due: kind === 'deposit' ? st.deposit_due ?? null : st.check_in, currency,
    payment: state === 'pay' && (acc || revolut) ? {
      account_number: acc?.account_number ?? '', account_name: acc?.account_name ?? '', bank_name: acc?.bank_name ?? '', bic: acc?.bic ?? '',
      title, revolut, qr: paymentQrs(ps, { amount, currency, title }),
    } : null,
  };
}

/** Szablony dla domku: ogólne, dla obiektu i dla tego domku */
export function templatesForUnit(db: DatabaseSync, unitId: number) {
  const u = db.prepare('SELECT property_id FROM units WHERE id = ?').get(unitId) as { property_id: number } | undefined;
  return db.prepare(`SELECT * FROM sms_templates
    WHERE (property_id IS NULL AND unit_id IS NULL) OR unit_id = ? OR (unit_id IS NULL AND property_id = ?)
    ORDER BY sort, id`).all(unitId, u?.property_id ?? -1) as SmsTemplate[];
}

/** Dane rezerwacji do podstawienia w szablonie (aplikacja formatuje kwoty i podstawia na bieżąco) */
export function smsData(db: DatabaseSync, key: string, r: PayReservation) {
  const u = unitInfo(db, r.unit_id);
  const ps = paymentSettings(db);
  const currency = readCurrency(r.currency);
  const def = defaultDeposit(ps, r.price ?? null, r.check_in);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  return {
    guest: r.guest_name, first_name: firstName(r.guest_name), phone: r.guest_phone ?? '',
    property: u.property, unit: u.unit, unit_type: u.type || u.unit, address: u.address,
    check_in: r.check_in, check_out: r.check_out, price: r.price ?? null, paid: r.paid ?? 0, currency,
    // zapisany termin zaliczki, a gdy już minął — nowy wg ustawień (np. za 3 dni)
    deposit: r.deposit ?? def.amount, deposit_due: r.deposit != null && r.deposit_due && r.deposit_due >= today ? r.deposit_due : def.due,
    deposit_saved: r.deposit != null && r.deposit > 0,
    account: accountFor(ps, currency)?.account_number ?? '',
    links: { deposit: payUrl(key, r, 'deposit'), balance: payUrl(key, r, 'balance') },
  };
}
