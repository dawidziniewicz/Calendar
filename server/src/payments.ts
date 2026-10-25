import type { DatabaseSync } from 'node:sqlite';
import { allowedUnitIds, propertyIdsOf } from './auth.ts';
import { dateRange } from './changes.ts';
import { renderMail, type Attachment, type MailContent, type Mailer, type MailRow } from './mail.ts';
import { sendToSubscriptions, type Sender } from './push.ts';
import { epcPayload, iban, plBankPayload, polishNrb, qrPath, revolutUrl } from './qr.ts';
import {
  TXT, adminEmails, emailNotify, mailLang, sitePath, appUrl, extrasLines, firstName, guestUnitName, longDate, nightsBetween, parseChosenExtras, siteUrl, unitInfo, zl, type Lang,
} from './booking.ts';

// Płatności i korespondencja z gościem: dane do przelewu, zaliczki, oferty cenowe z linkiem „Akceptuję”,
// wiadomości wysyłane z aplikacji (zapisywane w historii rezerwacji).

// ---------------------------------------------------------------------------
// Ustawienia płatności (konto, zaliczka, warunki) — wszystko opcjonalne
// ---------------------------------------------------------------------------
/** Konto w innej walucie (np. EUR — IBAN i BIC dla gości z zagranicy) */
export type ForeignAccount = { currency: string; account_number: string; account_name: string; bank_name: string; bic: string };
export type PaymentSettings = {
  account_number: string; account_name: string; bank_name: string; bic: string; // konto główne (PLN)
  accounts: ForeignAccount[]; // konta walutowe
  revolut: string; // Revtag (np. @jankowalski) → link revolut.me
  show_qr: boolean; // kody QR do płatności w e-mailach, na stronie oferty i na rachunku
  deposit_percent: number | null; // domyślna zaliczka w % ceny
  deposit_days: number | null; // ile dni na wpłatę zaliczki
  offer_days: number | null; // ile dni oferta jest ważna
  terms: string; terms_en: string; // warunki rezerwacji / płatności pokazywane przy akceptacji
};
export const PAYMENT_SETTINGS_KEY = 'payment_settings';
export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  account_number: '', account_name: '', bank_name: '', bic: '', accounts: [], revolut: '', show_qr: true, deposit_percent: 30, deposit_days: 3, offer_days: 3, terms: '', terms_en: '',
};
const s = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const optInt = (v: unknown, min: number, max: number) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};
export function readPaymentSettings(v: unknown): PaymentSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    account_number: s(o.account_number, 60), account_name: s(o.account_name, 200), bank_name: s(o.bank_name, 120), bic: s(o.bic, 20),
    accounts: (Array.isArray(o.accounts) ? o.accounts : []).slice(0, 10).map((a) => {
      const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
      return { currency: readCurrency(x.currency), account_number: s(x.account_number, 60), account_name: s(x.account_name, 200), bank_name: s(x.bank_name, 120), bic: s(x.bic, 20) };
    }).filter((a) => a.account_number && a.currency !== 'PLN'),
    revolut: s(o.revolut, 60), show_qr: o.show_qr !== false,
    deposit_percent: optInt(o.deposit_percent, 0, 100), deposit_days: optInt(o.deposit_days, 0, 60), offer_days: optInt(o.offer_days, 1, 60),
    terms: s(o.terms, 3000), terms_en: s(o.terms_en, 3000),
  };
}
export function paymentSettings(db: DatabaseSync): PaymentSettings {
  const raw = (db.prepare('SELECT value FROM settings WHERE key = ?').get(PAYMENT_SETTINGS_KEY) as { value: string } | undefined)?.value;
  try { return raw ? readPaymentSettings(JSON.parse(raw)) : { ...DEFAULT_PAYMENT_SETTINGS }; } catch { return { ...DEFAULT_PAYMENT_SETTINGS }; }
}

// ---------------------------------------------------------------------------
// Waluty
// ---------------------------------------------------------------------------
export const CURRENCIES = ['PLN', 'EUR', 'GBP', 'USD', 'CHF', 'CZK', 'NOK', 'SEK', 'DKK'] as const;
export const readCurrency = (v: unknown) => (typeof v === 'string' && (CURRENCIES as readonly string[]).includes(v.toUpperCase()) ? v.toUpperCase() : 'PLN');
/** Kwota w walucie: 1200 zł, 1 200 € / €1,200 */
export function money(n: number, currency = 'PLN', lang: Lang = 'pl') {
  if (currency === 'PLN') return zl(n);
  const frac = Math.round(n * 100) % 100 !== 0;
  return new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'pl-PL', { style: 'currency', currency, minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 })
    .format(n).replace(/\u00a0/g, ' ');
}
const cur = (st: { currency?: string | null }) => readCurrency(st.currency);
/** Termin do tytułu przelewu: po polsku „3–6 gru”, po angielsku liczbowo „03.12–06.12.2026” (banki za granicą) */
export const titleRange = (from: string, to: string, lang: Lang) => (lang === 'en'
  ? `${from.slice(8, 10)}.${from.slice(5, 7)}–${to.slice(8, 10)}.${to.slice(5, 7)}.${to.slice(0, 4)}` : dateRange(from, to));

/** Konto do przelewu w danej walucie: PLN → konto główne, inne → konto walutowe (jeśli jest) */
export function accountFor(ps: PaymentSettings, currency: string) {
  if (currency === 'PLN') return ps.account_number ? { account_number: ps.account_number, account_name: ps.account_name, bank_name: ps.bank_name, bic: ps.bic } : null;
  return ps.accounts.find((a) => a.currency === currency) ?? null;
}

// Podpis adresów obrazków QR (klucz serwera ustawia createApp)
let qrKey = '';
export const setQrKey = (key: string) => { qrKey = key; };
export type PaymentQr = { kind: 'bank' | 'revolut'; path: string; url?: string };
/** Kody QR: przelew (PLN — ZBP, EUR — EPC) i Revolut (link revolut.me) */
export function paymentQrs(ps: PaymentSettings, o: { amount: number | null; currency: string; title: string }): PaymentQr[] {
  if (!ps.show_qr || !qrKey) return [];
  const out: PaymentQr[] = [];
  const acc = accountFor(ps, o.currency);
  if (acc && o.amount) {
    const payload = o.currency === 'PLN' ? plBankPayload({ account: acc.account_number, amount: o.amount, name: acc.account_name, title: o.title })
      : o.currency === 'EUR' ? epcPayload({ account: acc.account_number, bic: acc.bic, amount: o.amount, name: acc.account_name, text: o.title }) : null;
    if (payload) out.push({ kind: 'bank', path: qrPath(qrKey, payload) });
  }
  const rev = revolutUrl(ps.revolut);
  if (rev) out.push({ kind: 'revolut', path: qrPath(qrKey, rev), url: rev });
  return out;
}
export const revolutLink = (ps: PaymentSettings) => revolutUrl(ps.revolut);
export { polishNrb, iban };

const warsawToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
export const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Domyślna zaliczka (zaokrąglona do 10 zł) i termin wpłaty wg ustawień. */
export function defaultDeposit(ps: PaymentSettings, price: number | null, checkIn: string) {
  const amount = price && ps.deposit_percent ? Math.round((price * ps.deposit_percent) / 100 / 10) * 10 : null;
  let due = ps.deposit_days != null ? plusDays(warsawToday(), ps.deposit_days) : null;
  if (due && due > checkIn) due = checkIn;
  return { amount, due };
}

// ---------------------------------------------------------------------------
// Gość i pobyt — wspólne dla rezerwacji i zapytań
// ---------------------------------------------------------------------------
export type Stay = {
  unit_id: number; check_in: string; check_out: string; guest_name: string; guest_email: string;
  adults: number; children: number; lang?: string | null; extras?: string | null;
  price?: number | null; paid?: number | null; deposit?: number | null; deposit_due?: string | null;
  currency?: string | null;
};
export const stayLang = (st: Stay): Lang => mailLang(st.lang);

export type MessageKind = 'confirmation' | 'deposit' | 'balance' | 'received' | 'custom' | 'offer' | 'invoice' | 'offer_accepted' | 'unpaid_cancel';
export const MESSAGE_KINDS: MessageKind[] = ['confirmation', 'deposit', 'balance', 'received', 'custom', 'invoice', 'unpaid_cancel'];

const P = {
  pl: {
    amount: 'Kwota', due: 'Termin wpłaty', recipient: 'Odbiorca', account: 'Numer konta', bank: 'Bank', title: 'Tytuł przelewu',
    deposit: 'Zaliczka', paid: 'Wpłacono', left: 'Pozostało do zapłaty', validUntil: 'Oferta ważna do', terms: 'Warunki rezerwacji',
    depositPayable: (a: string, d: string | null) => `${a}${d ? ` — płatna do ${d}` : ''}`,
    depositTitle: (g: string, r: string) => `Zaliczka – ${g}, ${r}`, balanceTitle: (g: string, r: string) => `Dopłata – ${g}, ${r}`,
    subjects: {
      confirmation: (p: string, r: string) => `Potwierdzenie rezerwacji — ${p}, ${r}`,
      deposit: (p: string, r: string) => `Prośba o wpłatę zaliczki — ${p}, ${r}`,
      balance: (p: string, r: string) => `Prośba o dopłatę — ${p}, ${r}`,
      received: (p: string, r: string) => `Potwierdzenie wpłaty — ${p}, ${r}`,
      custom: (p: string, r: string) => `${p}, ${r}`,
      invoice: (p: string, r: string) => `Rachunek za pobyt — ${p}, ${r}`,
      offer: (p: string, r: string) => `Oferta pobytu — ${p}, ${r}`,
      offer_accepted: (p: string, r: string) => `Rezerwacja potwierdzona — ${p}, ${r}`,
      unpaid_cancel: (p: string, r: string) => `Rezerwacja anulowana — brak wpłaty zaliczki — ${p}, ${r}`,
    },
    titles: {
      confirmation: 'Potwierdzenie rezerwacji', deposit: 'Prośba o wpłatę zaliczki', balance: 'Prośba o dopłatę', received: 'Dziękujemy za wpłatę',
      custom: 'Wiadomość od nas', invoice: 'Rachunek za pobyt', offer: 'Oferta pobytu', offer_accepted: 'Dziękujemy — rezerwacja potwierdzona', unpaid_cancel: 'Rezerwacja anulowana',
    },
    bodies: {
      confirmation: () => 'potwierdzamy Twoją rezerwację. Poniżej znajdziesz szczegóły pobytu. Czekamy na Ciebie!',
      deposit: (a: string, d: string | null) => `dziękujemy za rezerwację. Prosimy o wpłatę zaliczki w wysokości ${a}${d ? ` do ${d}` : ''} na poniższe konto. Po zaksięgowaniu wpłaty potwierdzimy jej otrzymanie.`,
      balance: (a: string, d: string | null) => `uprzejmie przypominamy o dopłacie pozostałej kwoty za pobyt: ${a}${d ? ` do ${d}` : ''}. Dane do przelewu poniżej.`,
      received: (a: string) => `potwierdzamy otrzymanie wpłaty ${a}. Dziękujemy!`,
      custom: () => '',
      invoice: () => 'w załączniku przesyłamy rachunek za pobyt. Dziękujemy, że byliście z nami!',
      offer: () => 'dziękujemy za zainteresowanie. Przygotowaliśmy dla Ciebie ofertę pobytu — sprawdź szczegóły i zaakceptuj ją jednym kliknięciem.',
      unpaid_cancel: (a: string, d: string | null) => `niestety nie otrzymaliśmy wpłaty zaliczki w wysokości ${a}${d ? ` w wyznaczonym terminie (do ${d})` : ' w wyznaczonym terminie'}, dlatego anulowaliśmy rezerwację i termin jest znów dostępny. Jeśli przelew został już wysłany, odpowiedz na tę wiadomość — sprawdzimy to i w miarę możliwości przywrócimy rezerwację.`,
    },
    offerButton: 'Zobacz ofertę i zaakceptuj',
    offerOutro: (dep: boolean) => [
      `Akceptując ofertę, potwierdzasz rezerwację i zobowiązujesz się do zapłaty ceny pobytu${dep ? ' oraz wpłaty zaliczki w podanym terminie' : ''}.`,
      'W razie pytań odpowiedz na tę wiadomość albo zadzwoń: +48 510 248 693.',
    ],
    acceptedIntro: (dep: boolean) => `dziękujemy za akceptację oferty — rezerwacja jest potwierdzona.${dep ? ' Prosimy o wpłatę zaliczki na poniższe konto w podanym terminie.' : ''}`,
    signOff: 'Pozdrawiamy serdecznie,\nzespół Od Morza do Gór',
    contact: 'W razie pytań odpowiedz na tę wiadomość albo zadzwoń: +48 510 248 693.',
  },
  en: {
    amount: 'Amount', due: 'Payment due', recipient: 'Recipient', account: 'Account number', bank: 'Bank', title: 'Payment reference',
    deposit: 'Deposit', paid: 'Paid', left: 'Balance due', validUntil: 'Offer valid until', terms: 'Booking terms',
    depositPayable: (a: string, d: string | null) => `${a}${d ? ` — due by ${d}` : ''}`,
    depositTitle: (g: string, r: string) => `Deposit – ${g}, ${r}`, balanceTitle: (g: string, r: string) => `Balance – ${g}, ${r}`,
    subjects: {
      confirmation: (p: string, r: string) => `Booking confirmation — ${p}, ${r}`,
      deposit: (p: string, r: string) => `Deposit payment request — ${p}, ${r}`,
      balance: (p: string, r: string) => `Balance payment request — ${p}, ${r}`,
      received: (p: string, r: string) => `Payment received — ${p}, ${r}`,
      custom: (p: string, r: string) => `${p}, ${r}`,
      invoice: (p: string, r: string) => `Bill for your stay — ${p}, ${r}`,
      offer: (p: string, r: string) => `Your stay offer — ${p}, ${r}`,
      offer_accepted: (p: string, r: string) => `Booking confirmed — ${p}, ${r}`,
      unpaid_cancel: (p: string, r: string) => `Booking cancelled — deposit not received — ${p}, ${r}`,
    },
    titles: {
      confirmation: 'Booking confirmation', deposit: 'Deposit payment request', balance: 'Balance payment request', received: 'Thank you for your payment',
      custom: 'Message from us', invoice: 'Bill for your stay', offer: 'Your stay offer', offer_accepted: 'Thank you — your booking is confirmed', unpaid_cancel: 'Booking cancelled',
    },
    bodies: {
      confirmation: () => 'we are pleased to confirm your booking. You will find the details of your stay below. We look forward to welcoming you!',
      deposit: (a: string, d: string | null) => `thank you for your booking. Please pay a deposit of ${a}${d ? ` by ${d}` : ''} to the account below. We will confirm once we receive it.`,
      balance: (a: string, d: string | null) => `this is a friendly reminder about the remaining balance for your stay: ${a}${d ? `, due by ${d}` : ''}. Payment details are below.`,
      received: (a: string) => `we confirm that we have received your payment of ${a}. Thank you!`,
      custom: () => '',
      invoice: () => 'please find attached the bill for your stay. Thank you for staying with us!',
      offer: () => 'thank you for your interest. We have prepared an offer for your stay — check the details and accept it with one click.',
      unpaid_cancel: (a: string, d: string | null) => `unfortunately we have not received the deposit of ${a}${d ? ` by the due date (${d})` : ' by the due date'}, so we have cancelled the booking and the dates are available again. If you have already sent the payment, please reply to this e-mail — we will check it and restore the booking if possible.`,
    },
    offerButton: 'View and accept the offer',
    offerOutro: (dep: boolean) => [
      `By accepting the offer you confirm the booking and agree to pay the price of the stay${dep ? ' and the deposit by the due date' : ''}.`,
      'If you have any questions, just reply to this e-mail or call +48 510 248 693.',
    ],
    acceptedIntro: (dep: boolean) => `thank you for accepting our offer — your booking is confirmed.${dep ? ' Please pay the deposit to the account below by the due date.' : ''}`,
    signOff: 'Kind regards,\nthe Od Morza do Gór team',
    contact: 'If you have any questions, just reply to this e-mail or call +48 510 248 693.',
  },
};

/** „27 października 2026” (bez dnia tygodnia — do terminów płatności w treści) */
const short = (iso: string | null | undefined, lang: Lang) =>
  (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString(TXT[lang].locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : null);

/** Obiekt, typ domku, termin, długość, goście (+ opcje dodatkowe) */
function stayRows(db: DatabaseSync, st: Stay, lang: Lang, priceLabel?: string, price?: number | null): MailRow[] {
  const t = TXT[lang];
  const u = unitInfo(db, st.unit_id);
  const n = nightsBetween(st.check_in, st.check_out);
  const extras = parseChosenExtras(st.extras);
  return [
    [t.property, `${u.property}\n${guestUnitName(u, lang)}`],
    [t.arrival, longDate(st.check_in, t.locale)],
    [t.departure, longDate(st.check_out, t.locale)],
    [t.length, t.nights(n)],
    ...(st.adults + st.children ? [[t.guests, t.people(st.adults, st.children)] as MailRow] : []),
    ...(extras.length ? [[lang === 'en' ? 'Extras' : 'Opcje dodatkowe', extrasLines(extras, lang).join('\n')] as MailRow] : []),
    ...(priceLabel && price != null ? [[priceLabel, money(price, cur(st), lang)] as MailRow] : []),
  ];
}

/** Dane do przelewu: kwota, termin, odbiorca, konto (IBAN/BIC dla walut), bank, tytuł, Revolut (puste pola są pomijane). */
function transferRows(ps: PaymentSettings, lang: Lang, amount: number | null, due: string | null, title: string, currency = 'PLN'): MailRow[] {
  const p = P[lang];
  const acc = accountFor(ps, currency);
  const rev = revolutUrl(ps.revolut);
  return ([
    [p.amount, amount != null ? money(amount, currency, lang) : ''],
    [p.due, short(due, lang) ?? ''],
    [p.recipient, acc?.account_name ?? ''],
    [currency === 'PLN' ? p.account : 'IBAN', acc ? (currency === 'PLN' ? acc.account_number : (iban(acc.account_number) ?? acc.account_number).replace(/(.{4})/g, '$1 ').trim()) : ''],
    ['BIC / SWIFT', acc?.bic ?? ''],
    [p.bank, acc?.bank_name ?? ''],
    [p.title, acc ? title : ''],
    ['Revolut', rev ? rev.replace('https://', '') : ''],
  ] as MailRow[]).filter(([, v]) => v);
}
/** Obrazki QR do e-maila (adres bezwzględny: kalendarz → /public/qr/…) */
function qrImages(ps: PaymentSettings, lang: Lang, amount: number | null, currency: string, title: string) {
  return paymentQrs(ps, { amount, currency, title }).map((q) => ({
    src: `${appUrl()}/public${q.path}`,
    caption: q.kind === 'bank' ? (lang === 'en' ? (currency === 'EUR' ? 'Scan in your banking app (SEPA)' : 'Scan in a Polish banking app') : 'Zeskanuj w aplikacji banku')
      : (lang === 'en' ? 'Pay with Revolut' : 'Zapłać przez Revolut'),
    href: q.url,
  }));
}

export type MessageInput = {
  kind: MessageKind; subject?: string; body?: string;
  amount?: number | null; due?: string | null; title?: string;
  offerUrl?: string; validUntil?: string | null; cancelUrl?: string | null; offerNote?: string;
};

/** Domyślna treść wiadomości (do edycji w aplikacji przed wysłaniem). */
export function draftMessage(db: DatabaseSync, st: Stay, kind: MessageKind, amount?: number | null, due?: string | null) {
  const lang = stayLang(st);
  const p = P[lang];
  const u = unitInfo(db, st.unit_id);
  const range = dateRange(st.check_in, st.check_out);
  const left = st.price != null ? Math.max(0, st.price - (st.paid ?? 0)) : null;
  const ps = paymentSettings(db);
  const def = kind === 'deposit'
    ? { amount: st.deposit ?? defaultDeposit(ps, st.price ?? null, st.check_in).amount, due: st.deposit_due ?? defaultDeposit(ps, st.price ?? null, st.check_in).due }
    : kind === 'balance' ? { amount: left, due: st.check_in }
      : kind === 'received' ? { amount: st.paid ?? null, due: null }
        : kind === 'unpaid_cancel' ? { amount: st.deposit ?? null, due: st.deposit_due ?? null } : { amount: null, due: null };
  const a = amount === undefined ? def.amount : amount;
  const d = due === undefined ? def.due : due;
  const amountText = a != null ? money(a, cur(st), lang) : '…';
  const bodies = p.bodies as Record<string, (a: string, d: string | null) => string>;
  return {
    lang,
    subject: p.subjects[kind](u.property, range),
    body: (bodies[kind] ?? (() => ''))(amountText, short(d, lang)),
    amount: a ?? null, due: d ?? null,
    title: kind === 'balance' ? p.balanceTitle(st.guest_name, titleRange(st.check_in, st.check_out, lang)) : p.depositTitle(st.guest_name, titleRange(st.check_in, st.check_out, lang)),
  };
}

/** Wiadomość do gościa w szablonie strony (PL/EN wg języka rezerwacji). */
export function composeMessage(db: DatabaseSync, st: Stay, m: MessageInput) {
  const lang = stayLang(st);
  const p = P[lang];
  const t = TXT[lang];
  const ps = paymentSettings(db);
  const u = unitInfo(db, st.unit_id);
  const range = dateRange(st.check_in, st.check_out);
  const draft = draftMessage(db, st, m.kind, m.amount, m.due);
  const body = m.body ?? draft.body;
  const subject = m.subject || draft.subject;
  const terms = (lang === 'en' && ps.terms_en) || ps.terms;
  const price = st.price ?? null;
  const paid = st.paid ?? 0;
  const left = price != null ? Math.max(0, price - paid) : null;
  const intro = [t.hello(firstName(st.guest_name)), ...(body ? [body] : [])];

  let content: MailContent;
  switch (m.kind) {
    case 'deposit':
    case 'balance':
      content = {
        preheader: `${draft.subject}`, title: p.titles[m.kind], intro,
        rows: [...stayRows(db, st, lang).slice(0, 3), ...transferRows(ps, lang, draft.amount, draft.due, m.title || draft.title, cur(st))],
        images: qrImages(ps, lang, draft.amount, cur(st), m.title || draft.title),
        note: terms && m.kind === 'deposit' ? { label: p.terms, text: terms } : undefined,
        outro: [p.contact, p.signOff],
      };
      break;
    case 'received':
      content = {
        preheader: subject, title: p.titles.received, intro,
        rows: [...stayRows(db, st, lang).slice(0, 3), ...(price != null ? [[t.price, money(price, cur(st), lang)] as MailRow, [p.paid, money(paid, cur(st), lang)] as MailRow, [p.left, money(left ?? 0, cur(st), lang)] as MailRow] : [])],
        outro: [p.signOff],
      };
      break;
    case 'offer':
    case 'offer_accepted': {
      const dep = st.deposit != null && st.deposit > 0;
      content = {
        preheader: subject, title: p.titles[m.kind],
        intro: m.kind === 'offer' ? intro : [t.hello(firstName(st.guest_name)), p.acceptedIntro(dep)],
        rows: [
          ...stayRows(db, st, lang, t.price, price),
          ...(dep ? [[p.deposit, p.depositPayable(money(st.deposit!, cur(st), lang), short(st.deposit_due, lang))] as MailRow] : []),
          ...(m.kind === 'offer' && m.validUntil ? [[p.validUntil, short(m.validUntil, lang)!] as MailRow] : []),
          ...(m.kind === 'offer_accepted' && dep ? transferRows(ps, lang, null, null, p.depositTitle(st.guest_name, titleRange(st.check_in, st.check_out, lang)), cur(st)) : []),
          ...(m.kind === 'offer_accepted' && u.address ? [[t.address, u.address] as MailRow] : []),
        ],
        images: m.kind === 'offer_accepted' && dep ? qrImages(ps, lang, st.deposit!, cur(st), p.depositTitle(st.guest_name, titleRange(st.check_in, st.check_out, lang))) : undefined,
        note: m.offerNote ? { label: t.msgFromUs, text: m.offerNote } : undefined,
        button: m.kind === 'offer' && m.offerUrl ? { label: p.offerButton, url: m.offerUrl } : undefined,
        outro: m.kind === 'offer' ? p.offerOutro(dep) : [p.contact, p.signOff],
        link: m.cancelUrl ? { text: t.cancelText, label: t.cancelLabel, url: m.cancelUrl } : undefined,
      };
      break;
    }
    case 'confirmation': {
      const dep = st.deposit != null && st.deposit > 0 && paid < st.deposit;
      content = {
        preheader: subject, title: p.titles.confirmation, intro,
        rows: [
          ...stayRows(db, st, lang, t.price, price),
          ...(dep ? [[p.deposit, p.depositPayable(money(st.deposit!, cur(st), lang), short(st.deposit_due, lang))] as MailRow] : []),
          ...(paid ? [[p.paid, money(paid, cur(st), lang)] as MailRow] : []),
          ...(dep ? transferRows(ps, lang, null, null, p.depositTitle(st.guest_name, titleRange(st.check_in, st.check_out, lang)), cur(st)) : []),
          ...(u.address ? [[t.address, u.address] as MailRow] : []),
        ],
        images: dep ? qrImages(ps, lang, st.deposit! - paid, cur(st), p.depositTitle(st.guest_name, titleRange(st.check_in, st.check_out, lang))) : undefined,
        outro: [p.contact, p.signOff],
        link: m.cancelUrl ? { text: t.cancelText, label: t.cancelLabel, url: m.cancelUrl } : undefined,
      };
      break;
    }
    case 'unpaid_cancel':
      content = {
        preheader: subject, title: p.titles.unpaid_cancel, intro,
        rows: [...stayRows(db, st, lang).slice(0, 3), ...(st.deposit ? [[p.deposit, p.depositPayable(money(st.deposit, cur(st), lang), short(st.deposit_due, lang))] as MailRow] : [])],
        button: { label: t.otherDates, url: siteUrl() + sitePath(st.lang, 'home') },
        outro: [p.contact, p.signOff],
      };
      break;
    case 'invoice':
      content = { preheader: subject, title: p.titles.invoice, intro, rows: stayRows(db, st, lang).slice(0, 3), outro: [p.signOff] };
      break;
    default:
      content = { preheader: subject, title: p.titles.custom, intro, rows: stayRows(db, st, lang).slice(0, 3), outro: [p.signOff] };
  }
  return { subject, body, ...renderMail(content, lang) };
}

export async function sendGuestMessage(
  db: DatabaseSync, mailer: Mailer, st: Stay, m: MessageInput,
  log: { reservation_id?: number | null; request_id?: number | null; sent_by: string }, attachments?: Attachment[],
) {
  const msg = composeMessage(db, st, m);
  await mailer.send({ to: [st.guest_email], subject: msg.subject, html: msg.html, text: msg.text, replyTo: adminEmails(db)[0], attachments });
  db.prepare(`INSERT INTO guest_messages (reservation_id, request_id, kind, to_email, subject, body, sent_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(log.reservation_id ?? null, log.request_id ?? null, m.kind, st.guest_email, msg.subject, msg.body, log.sent_by);
  return msg;
}

// ---------------------------------------------------------------------------
// Oferty: link „Akceptuję” na stronie (/oferta/?t=KOD, /en/offer/?t=KOD)
// ---------------------------------------------------------------------------
export type OfferRow = {
  id: number; token: string; request_id: number | null; reservation_id: number | null; unit_id: number | null;
  price: number; deposit: number | null; deposit_due: string | null; valid_until: string | null; message: string; lang: string; currency: string;
  status: 'sent' | 'accepted' | 'declined' | 'withdrawn'; created_by: string; created_at: string; decided_at: string | null; decided_ip: string; decline_reason: string;
};
export const offerUrl = (o: { token: string; lang: string }) => `${siteUrl()}${sitePath(o.lang, 'offer')}?t=${o.token}`;
export const offerExpired = (o: OfferRow) => o.status === 'sent' && !!o.valid_until && o.valid_until < warsawToday();

/** Push i e-mail do obsługi z dostępem do domku (np. gość zaakceptował / odrzucił ofertę). */
export async function notifyStaff(
  db: DatabaseSync, push: Sender | undefined, mailer: Mailer | undefined, unitId: number,
  msg: { title: string; body: string; url: string; tag: string }, mail?: { subject: string; content: MailContent; replyTo?: string },
) {
  const jobs: Promise<unknown>[] = [];
  if (push) {
    const users = db.prepare(`SELECT DISTINCT u.id FROM users u JOIN push_subscriptions p ON p.user_id = u.id WHERE u.notify_requests = 1`).all() as { id: number }[];
    for (const user of users) {
      const allowed = allowedUnitIds(db, { properties: propertyIdsOf(db, user.id) });
      if (!allowed || allowed.has(unitId)) jobs.push(sendToSubscriptions(db, push, user.id, msg));
    }
  }
  // e-maile do obsługi o ofertach można wyłączyć w ustawieniach (push zostaje)
  const admins = emailNotify(db).offers ? adminEmails(db) : [];
  if (mailer && mail && admins.length) {
    jobs.push(mailer.send({ to: admins, subject: mail.subject, ...renderMail({ ...mail.content, button: mail.content.button ?? { label: 'Otwórz w kalendarzu', url: `${appUrl()}${msg.url}` } }), replyTo: mail.replyTo }));
  }
  for (const res of await Promise.allSettled(jobs)) if (res.status === 'rejected') console.error('Powiadomienie nie powiodło się:', res.reason);
}

/** Zaliczka + dane do przelewu (do e-maila z potwierdzeniem po akceptacji przez admina). */
export function depositRows(db: DatabaseSync, st: Stay): MailRow[] {
  if (st.deposit == null || st.deposit <= 0) return [];
  const lang = stayLang(st);
  const p = P[lang];
  return [
    [p.deposit, p.depositPayable(money(st.deposit, cur(st), lang), short(st.deposit_due, lang))],
    ...transferRows(paymentSettings(db), lang, null, null, p.depositTitle(st.guest_name, titleRange(st.check_in, st.check_out, lang)), cur(st)),
  ];
}

/** Wiersze pobytu dla e-maila do obsługi (po polsku). */
export const staffRows = (db: DatabaseSync, st: Stay, price: number | null) => stayRows(db, st, 'pl', 'Cena', price);
/** Obrazki QR do potwierdzenia po akceptacji przez admina (zaliczka) */
export const depositImages = (db: DatabaseSync, st: Stay) =>
  (st.deposit ? qrImages(paymentSettings(db), stayLang(st), st.deposit, cur(st), P[stayLang(st)].depositTitle(st.guest_name, titleRange(st.check_in, st.check_out, stayLang(st)))) : []);
