import type { DatabaseSync } from 'node:sqlite';
import { allowedUnitIds, propertyIdsOf } from './auth.ts';
import { dateRange } from './changes.ts';
import { renderMail, parseEmails, type Mailer, type MailRow } from './mail.ts';
import { sendToSubscriptions, type Sender } from './push.ts';
import { dmy } from './dmy.ts';

// Ceny za noc i zapytania o rezerwację ze strony odmorzadogor.pl.
// Cena nocy D = nadpisanie z tabeli rates (jeśli jest) albo cena podstawowa domku. Brak obu = „cena do ustalenia”.

export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const nightsBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
export const nightsPl = (n: number) => (n === 1 ? '1 noc' : `${n} ${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'noce' : 'nocy'}`);
export const zl = (n: number) => `${n.toLocaleString('pl-PL', { maximumFractionDigits: 2 }).replace(/ /g, ' ')} zł`;

type UnitPricing = {
  id: number; property_id: number; name: string; type_name: string; type_name_en: string; sort: number;
  base_price: number | null; min_nights: number; bookable: number; capacity: number; weekday_prices: string | null;
};
export type Night = { date: string; price: number | null; min_nights: number; closed: boolean; booked: boolean; propertyClosed?: boolean };

export type Closure = { closed: number; closed_from: string | null; closed_to: string | null; closed_note: string; closed_note_en: string };
export function propertyClosure(db: DatabaseSync, propertyId: number): Closure | null {
  const c = db.prepare('SELECT closed, closed_from, closed_to, closed_note, closed_note_en FROM properties WHERE id = ?').get(propertyId) as Closure | undefined;
  return c && c.closed ? c : null;
}
/** Czy noc `date` wypada w zamknięciu obiektu (bez dat = do odwołania; daty włącznie). */
export const closedOn = (c: Closure | null, date: string) =>
  !!c && (!c.closed_from || date >= c.closed_from) && (!c.closed_to || date <= c.closed_to);

export function unitPricing(db: DatabaseSync, unitId: number) {
  return db.prepare(`SELECT id, property_id, name, type_name, type_name_en, sort, base_price, min_nights, bookable, capacity, weekday_prices
    FROM units WHERE id = ?`).get(unitId) as UnitPricing | undefined;
}

/** Grupa domków do rezerwacji: wszystkie muszą istnieć, być widoczne na stronie i należeć do jednego obiektu. */
export function unitGroup(db: DatabaseSync, ids: unknown): UnitPricing[] | null {
  const list = (Array.isArray(ids) ? ids : String(ids ?? '').split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const uniq = [...new Set(list)].slice(0, 30);
  if (!uniq.length) return null;
  const units = uniq.map((id) => unitPricing(db, id));
  if (units.some((u) => !u || !u.bookable)) return null;
  const ok = units as UnitPricing[];
  return ok.every((u) => u.property_id === ok[0].property_id) ? ok.sort((a, b) => a.sort - b.sort || a.id - b.id) : null;
}

/**
 * Najlepszy wolny domek z grupy na cały pobyt: najpierw ze znaną ceną, potem najtańszy, potem wg kolejności.
 * Zwraca też powód, jeśli żaden nie pasuje (pierwszy napotkany — np. minimalny pobyt).
 */
export function chooseUnit(db: DatabaseSync, units: UnitPricing[], checkIn: string, checkOut: string, lang: Lang = 'pl') {
  const quotes = units.map((u) => ({ unit: u, q: quote(db, u, checkIn, checkOut, lang) }));
  const ok = quotes.filter((x) => x.q.available)
    .sort((a, b) => (a.q.total == null ? 1 : 0) - (b.q.total == null ? 1 : 0) || (a.q.total ?? 0) - (b.q.total ?? 0) || a.unit.sort - b.unit.sort);
  if (ok.length) return { unit: ok[0].unit, q: ok[0].q, free: ok.map((x) => x.unit.id) };
  // wolny domek, ale np. za krótki pobyt — ten komunikat jest ważniejszy niż „zajęte”
  const reason = quotes.find((x) => !/zajęty|booked/.test(x.q.reason ?? ''))?.q.reason ?? quotes[0]?.q.reason;
  return { unit: null, q: null, free: [], reason };
}

/** Ceny wg dni tygodnia: tablica 7 pozycji (0 = niedziela … 6 = sobota), null = cena podstawowa. */
export function parseWeekdayPrices(raw: unknown): (number | null)[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = null; }
  }
  const arr = Array.isArray(list) ? list : [];
  return Array.from({ length: 7 }, (_, i) => {
    const v = arr[i];
    return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v);
  });
}

// Na ile dni do przodu strona pokazuje ceny i przyjmuje zapytania (ustawienie w aplikacji)
export const HORIZON_KEY = 'booking_horizon_days';
export const DEFAULT_HORIZON = 365;
export function bookingHorizon(db: DatabaseSync): number {
  const v = Number((db.prepare('SELECT value FROM settings WHERE key = ?').get(HORIZON_KEY) as { value: string } | undefined)?.value);
  return Number.isInteger(v) && v >= 7 && v <= 730 ? v : DEFAULT_HORIZON;
}
const warsawToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
// Albo konkretna data: ostatnia noc z ceną na stronie (np. koniec sezonu) — ma pierwszeństwo przed liczbą dni
export const HORIZON_UNTIL_KEY = 'booking_horizon_until';
export function horizonUntil(db: DatabaseSync): string | null {
  const v = (db.prepare('SELECT value FROM settings WHERE key = ?').get(HORIZON_UNTIL_KEY) as { value: string } | undefined)?.value;
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
/**
 * Pierwsza noc, której strona już nie pokazuje (dzień po dacie „ceny do” albo dziś + horyzont).
 * Dla domku: data ustawiona dla jego typu (units.horizon_until) → dla obiektu (properties.horizon_until) → ogólna.
 */
export const horizonEnd = (db: DatabaseSync, unitId?: number) => {
  if (unitId) {
    const own = db.prepare('SELECT u.horizon_until AS unit, p.horizon_until AS property FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ?')
      .get(unitId) as { unit: string | null; property: string | null } | undefined;
    const until = own?.unit || own?.property;
    if (until && /^\d{4}-\d{2}-\d{2}$/.test(until)) return addDays(until, 1);
  }
  const until = horizonUntil(db);
  return until ? addDays(until, 1) : addDays(warsawToday(), bookingHorizon(db));
};

/** Noce od `from` (włącznie) do `to` (wyłącznie) z ceną, minimalną długością pobytu i zajętością. */
export function nights(db: DatabaseSync, unit: UnitPricing, from: string, to: string): Night[] {
  const rates = new Map((db.prepare('SELECT date, price, min_nights, closed FROM rates WHERE unit_id = ? AND date >= ? AND date < ?')
    .all(unit.id, from, to) as { date: string; price: number | null; min_nights: number | null; closed: number }[]).map((r) => [r.date, r]));
  const stays = db.prepare(`SELECT check_in, check_out FROM reservations WHERE unit_id = ? AND status != 'cancelled' AND check_out > ? AND check_in < ?`)
    .all(unit.id, from, to) as { check_in: string; check_out: string }[];
  const weekday = parseWeekdayPrices(unit.weekday_prices);
  const closure = propertyClosure(db, unit.property_id);
  const out: Night[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) {
    const r = rates.get(d);
    out.push({
      date: d,
      // kolejność: cena ustawiona na ten dzień → cena dnia tygodnia → cena podstawowa
      price: r?.price ?? weekday[new Date(`${d}T12:00:00Z`).getUTCDay()] ?? unit.base_price ?? null,
      min_nights: r?.min_nights ?? unit.min_nights ?? 1,
      closed: !!r?.closed || closedOn(closure, d),
      propertyClosed: closedOn(closure, d),
      booked: stays.some((s) => s.check_in <= d && s.check_out > d),
    });
  }
  return out;
}

export type Lang = 'pl' | 'en';
// Języki strony www (zapytanie/rezerwacja zapamiętuje język gościa). E-maile: po polsku albo po angielsku
// (dla gości z wersji czeskiej, niemieckiej i ukraińskiej), linki prowadzą do strony w języku gościa.
export const SITE_LANGS = ['pl', 'en', 'cs', 'de', 'uk'] as const;
export type SiteLang = typeof SITE_LANGS[number];
export const readSiteLang = (v: unknown): SiteLang => ((SITE_LANGS as readonly string[]).includes(v as string) ? v as SiteLang : 'pl');
export const mailLang = (v: unknown): Lang => (readSiteLang(v) === 'pl' ? 'pl' : 'en');
const SITE_PATHS: Record<SiteLang, { home: string; cancel: string; offer: string }> = {
  pl: { home: '/', cancel: '/anulacja/', offer: '/oferta/' },
  en: { home: '/en/', cancel: '/en/cancel/', offer: '/en/offer/' },
  cs: { home: '/cs/', cancel: '/cs/zruseni/', offer: '/cs/nabidka/' },
  de: { home: '/de/', cancel: '/de/stornierung/', offer: '/de/angebot/' },
  uk: { home: '/uk/', cancel: '/uk/skasuvannia/', offer: '/uk/propozytsiia/' },
};
export const sitePath = (lang: unknown, page: 'home' | 'cancel' | 'offer') => SITE_PATHS[readSiteLang(lang)][page];
const LANG_NAMES: Record<SiteLang, string> = { pl: 'polskiej', en: 'angielskiej', cs: 'czeskiej', de: 'niemieckiej', uk: 'ukraińskiej' };
export type Quote = { nights: number; total: number | null; min_nights: number; available: boolean; reason?: string };

const nightsEn = (n: number) => (n === 1 ? '1 night' : `${n} nights`);

/** Wycena pobytu i sprawdzenie, czy termin można zarezerwować online. */
/** Jak daleko do przodu strona pokazuje kalendarz i przyjmuje zapytania (ok. 15 miesięcy) */
export const MAX_AHEAD_DAYS = 460;
/** Noce z ceną tylko do „ceny na stronie do” (domek / typ / obiekt / ogólnie) — później termin jest wolny, ale bez ceny (na zapytanie) */
export const pricedNights = (db: DatabaseSync, unit: UnitPricing, from: string, to: string) => {
  const end = horizonEnd(db, unit.id);
  return nights(db, unit, from, to).map((n) => (n.date >= end ? { ...n, price: null } : n));
};

export function quote(db: DatabaseSync, unit: UnitPricing, checkIn: string, checkOut: string, lang: Lang = 'pl'): Quote {
  const list = pricedNights(db, unit, checkIn, checkOut);
  const min = list[0]?.min_nights ?? 1;
  const total = list.every((n) => n.price != null) ? list.reduce((s, n) => s + (n.price ?? 0), 0) : null;
  const base = { nights: list.length, total, min_nights: min };
  const en = lang === 'en';
  if (checkOut > addDays(warsawToday(), MAX_AHEAD_DAYS)) {
    return { ...base, available: false, reason: en ? 'Online enquiries are open up to 15 months ahead — please call us about later dates' : 'Zapytania online przyjmujemy do 15 miesięcy do przodu — w sprawie późniejszych terminów zadzwoń do nas' };
  }
  if (list.some((n) => n.propertyClosed)) {
    return { ...base, available: false, reason: en ? 'The property is closed on these dates' : 'Obiekt jest zamknięty w wybranym terminie' };
  }
  if (list.some((n) => n.booked)) return { ...base, available: false, reason: en ? 'These dates are already booked' : 'Wybrany termin jest już zajęty' };
  if (list.some((n) => n.closed)) {
    return { ...base, available: false, reason: en ? 'Online booking is closed for these dates — please call us' : 'W wybranym terminie nie przyjmujemy rezerwacji online — zadzwoń do nas' };
  }
  if (list.length < min) return { ...base, available: false, reason: en ? `Minimum stay from this date is ${nightsEn(min)}` : `Minimalny pobyt od tego dnia to ${nightsPl(min)}` };
  return { ...base, available: true };
}

// ---------------------------------------------------------------------------
// Powiadomienia o zapytaniach: push dla obsługi + e-mail dla właściciela i gościa (w języku strony, z której przyszło)
// ---------------------------------------------------------------------------

export type RequestRow = {
  id: number; unit_id: number; check_in: string; check_out: string; guest_name: string; guest_phone: string; guest_email: string;
  adults: number; children: number; message: string; quoted_price: number | null; status: string; decision_note: string;
  reservation_id: number | null; created_at: string; lang?: string; extras?: string | null; group_unit_ids?: string | null;
  cancel_token?: string | null; cancel_reason?: string; cancel_note?: string; expired_at?: string | null;
};

// ---------------------------------------------------------------------------
// Opcje płatne (parking, zwierzę…): cena za pobyt albo za noc, ilość od 1 do max_qty, dla wszystkich lub wybranych obiektów
// ---------------------------------------------------------------------------
export type Extra = {
  id: number; name: string; name_en: string; description: string; price: number; per: 'stay' | 'night'; max_qty: number;
  property_ids: string | null; active: number; sort: number;
  required: number; // obowiązkowa (np. sprzątanie) — zawsze doliczana, gość nie może jej odznaczyć
  price_overrides: string | null; // inne ceny: {"p<id obiektu>": cena, "u<id domku>": cena}
};
/** Zapis w zapytaniu / rezerwacji: kopia nazwy i ceny z chwili wyboru (późniejsza zmiana cennika nie zmienia rezerwacji). */
export type ChosenExtra = { id: number; name: string; name_en: string; price: number; per: 'stay' | 'night'; qty: number; total: number; required?: boolean };

const overrides = (e: Extra): Record<string, number> => {
  try { return e.price_overrides ? JSON.parse(e.price_overrides) : {}; } catch { return {}; }
};
const inScope = (e: Extra, propertyId: number) => {
  if (!e.property_ids) return true;
  try { return (JSON.parse(e.property_ids) as number[]).includes(propertyId); } catch { return true; }
};
/** Cena opcji: dla domku (jego typu) → dla obiektu → podstawowa */
export function extraPrice(e: Extra, propertyId: number, unitId?: number) {
  const o = overrides(e);
  const v = (unitId != null ? o[`u${unitId}`] : undefined) ?? o[`p${propertyId}`];
  return typeof v === 'number' && v >= 0 ? v : e.price;
}

export function extrasFor(db: DatabaseSync, propertyId: number, onlyActive = true, unitId?: number): Extra[] {
  const rows = db.prepare(`SELECT * FROM extras ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY required DESC, sort, id`).all() as Extra[];
  return rows.filter((e) => inScope(e, propertyId)).map((e) => ({ ...e, price: extraPrice(e, propertyId, unitId) }));
}
/** Opcje dla konkretnego domku (z ceną dla jego typu / obiektu) */
export function extrasForUnit(db: DatabaseSync, unitId: number, onlyActive = true): Extra[] {
  const u = db.prepare('SELECT property_id FROM units WHERE id = ?').get(unitId) as { property_id: number } | undefined;
  return u ? extrasFor(db, u.property_id, onlyActive, unitId) : [];
}

/**
 * Wybór [{id, qty}] → pozycje z ceną dla domku; nieznane / nieaktywne / ilość 0 są pomijane.
 * Opcje obowiązkowe są zawsze doliczane (co najmniej 1 szt.).
 */
export function priceExtras(db: DatabaseSync, unitId: number, chosen: unknown, nightsCount: number, o: { withRequired?: boolean; onlyActive?: boolean } = {}): ChosenExtra[] {
  const list = Array.isArray(chosen) ? chosen.slice(0, 30) : [];
  const available = extrasForUnit(db, unitId, o.onlyActive ?? true);
  const byId = new Map(available.map((e) => [e.id, e]));
  const out: ChosenExtra[] = [];
  const add = (e: Extra, qtyRaw: unknown) => {
    let qty = Math.min(e.max_qty, Math.max(0, Math.trunc(Number(qtyRaw ?? 1)) || 0));
    if (e.required && (o.withRequired ?? true)) qty = Math.max(1, qty);
    if (!qty || out.some((x) => x.id === e.id)) return;
    out.push({ id: e.id, name: e.name, name_en: e.name_en, price: e.price, per: e.per, qty, total: e.price * qty * (e.per === 'night' ? nightsCount : 1), ...(e.required ? { required: true } : {}) });
  };
  for (const c of list) {
    const e = byId.get(Number((c as { id?: unknown })?.id));
    if (e) add(e, (c as { qty?: unknown })?.qty);
  }
  if (o.withRequired ?? true) for (const e of available) if (e.required) add(e, 1);
  return out;
}

export function parseChosenExtras(raw: unknown): ChosenExtra[] {
  if (typeof raw !== 'string' || !raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** „Parking × 2 (40 zł/noc) — 240 zł” */
export function extrasLines(list: ChosenExtra[], lang: Lang = 'pl') {
  const en = lang === 'en';
  return list.map((e) => {
    const name = (en && e.name_en) || e.name;
    const unit = e.per === 'night' ? (en ? 'night' : 'noc') : (en ? 'stay' : 'pobyt');
    return `${name}${e.qty > 1 ? ` × ${e.qty}` : ''} (${zl(e.price)}/${unit}) — ${zl(e.total)}`;
  });
}

export type UnitInfo = { unit: string; type: string; type_en: string; property: string; location: string; address: string };
export function unitInfo(db: DatabaseSync, unitId: number): UnitInfo {
  return (db.prepare(`SELECT u.name AS unit, u.type_name AS type, u.type_name_en AS type_en, p.name AS property, p.location, p.address FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ?`)
    .get(unitId) as UnitInfo | undefined) ?? { unit: '', type: '', type_en: '', property: '', location: '', address: '' };
}
/** Gość widzi typ domku (np. „Mały domek” / „Small cottage”), a nie wewnętrzną nazwę konkretnego domku. */
export const guestUnitName = (u: UnitInfo, lang: Lang = 'pl') => (lang === 'en' && u.type_en) || u.type || u.unit;
const groupSize = (r: RequestRow) => { try { return r.group_unit_ids ? (JSON.parse(r.group_unit_ids) as number[]).length : 1; } catch { return 1; } };

export const TXT = {
  pl: {
    property: 'Obiekt', arrival: 'Przyjazd', departure: 'Wyjazd', length: 'Długość pobytu', guests: 'Goście', price: 'Cena za pobyt', estimate: 'Szacunkowa cena',
    tbd: 'do ustalenia', address: 'Adres', nights: nightsPl, locale: 'pl-PL',
    people: (a: number, c: number) => [`${a} ${a === 1 ? 'dorosły' : 'dorosłych'}`, ...(c ? [`${c} ${c === 1 ? 'dziecko' : 'dzieci'}`] : [])].join(' + '),
    hello: (n: string) => `Dzień dobry ${n},`,
    gotTitle: 'Dziękujemy za zapytanie', gotPre: 'Dziękujemy! Odpowiemy najszybciej, jak to możliwe.',
    gotIntro: (p: string) => `otrzymaliśmy Twoje zapytanie o pobyt w obiekcie ${p}. Sprawdzimy je i potwierdzimy rezerwację e-mailem — zwykle w ciągu kilku godzin.`,
    gotOutro: ['To jeszcze nie jest potwierdzenie rezerwacji. Termin pozostaje wolny do czasu naszej odpowiedzi.', 'Pozdrawiamy serdecznie,\nzespół Od Morza do Gór'],
    gotSubject: (p: string) => `Otrzymaliśmy Twoje zapytanie — ${p}`, yourMsg: 'Twoja wiadomość',
    okTitle: 'Rezerwacja potwierdzona', okPre: (p: string, d: string) => `Rezerwacja potwierdzona: ${p}, ${d}`, okIntro: 'z radością potwierdzamy Twoją rezerwację. Czekamy na Ciebie!',
    okOutro: ['W razie pytań odpowiedz na tę wiadomość albo zadzwoń: +48 510 248 693.', 'Do zobaczenia,\nzespół Od Morza do Gór'],
    okSubject: (p: string, d: string) => `Potwierdzenie rezerwacji — ${p}, ${d}`, fromUs: 'Informacje od nas',
    noTitle: 'Niestety nie możemy potwierdzić tego terminu', noPre: (p: string, d: string) => `Odpowiedź na zapytanie: ${p}, ${d}`,
    noIntro: (p: string) => `dziękujemy za zainteresowanie obiektem ${p}. Niestety nie możemy przyjąć rezerwacji w wybranym terminie.`,
    noOutro: ['Chętnie pomożemy znaleźć inny termin lub obiekt — wystarczy odpowiedzieć na tę wiadomość.', 'Pozdrawiamy,\nzespół Od Morza do Gór'],
    noSubject: (p: string) => `Odpowiedź na zapytanie — ${p}`, msgFromUs: 'Wiadomość od nas', otherDates: 'Sprawdź inne terminy', site: '',
    cancelText: 'Plany się zmieniły?', cancelLabel: 'Poproś o anulację rezerwacji', cancelPath: '/anulacja/',
    cxTitle: 'Rezerwacja anulowana', cxPre: (p: string, d: string) => `Anulowaliśmy rezerwację: ${p}, ${d}`, cxIntro: 'zgodnie z Twoją prośbą anulowaliśmy rezerwację. Szkoda, że tym razem się nie zobaczymy — zapraszamy w innym terminie!',
    cxSubject: (p: string, d: string) => `Rezerwacja anulowana — ${p}, ${d}`,
    cdTitle: 'Odpowiedź na prośbę o anulację', cdPre: (p: string) => `Odpowiedź na prośbę o anulację — ${p}`, cdIntro: 'otrzymaliśmy Twoją prośbę o anulację. Rezerwacja pozostaje aktywna — szczegóły poniżej.',
    cdSubject: (p: string) => `Odpowiedź na prośbę o anulację — ${p}`,
    cxOutro: ['W razie pytań odpowiedz na tę wiadomość albo zadzwoń: +48 510 248 693.', 'Pozdrawiamy,\nzespół Od Morza do Gór'],
  },
  en: {
    property: 'Property', arrival: 'Check-in', departure: 'Check-out', length: 'Length of stay', guests: 'Guests', price: 'Price for the stay', estimate: 'Estimated price',
    tbd: 'to be confirmed', address: 'Address', nights: nightsEn, locale: 'en-GB',
    people: (a: number, c: number) => [`${a} ${a === 1 ? 'adult' : 'adults'}`, ...(c ? [`${c} ${c === 1 ? 'child' : 'children'}`] : [])].join(' + '),
    hello: (n: string) => `Hello ${n},`,
    gotTitle: 'Thank you for your enquiry', gotPre: 'Thank you! We will get back to you as soon as possible.',
    gotIntro: (p: string) => `we have received your enquiry about a stay at ${p}. We will check it and confirm your booking by e-mail — usually within a few hours.`,
    gotOutro: ['This is not yet a booking confirmation. The dates remain open until we reply.', 'Kind regards,\nthe Od Morza do Gór team'],
    gotSubject: (p: string) => `We have received your enquiry — ${p}`, yourMsg: 'Your message',
    okTitle: 'Booking confirmed', okPre: (p: string, d: string) => `Booking confirmed: ${p}, ${d}`, okIntro: 'we are delighted to confirm your booking. We look forward to welcoming you!',
    okOutro: ['If you have any questions, just reply to this e-mail or call +48 510 248 693.', 'See you soon,\nthe Od Morza do Gór team'],
    okSubject: (p: string, d: string) => `Booking confirmation — ${p}, ${d}`, fromUs: 'Information from us',
    noTitle: 'Unfortunately we cannot confirm these dates', noPre: (p: string, d: string) => `Reply to your enquiry: ${p}, ${d}`,
    noIntro: (p: string) => `thank you for your interest in ${p}. Unfortunately we are unable to accept a booking for the selected dates.`,
    noOutro: ['We will gladly help you find other dates or another property — just reply to this e-mail.', 'Kind regards,\nthe Od Morza do Gór team'],
    noSubject: (p: string) => `Reply to your enquiry — ${p}`, msgFromUs: 'Message from us', otherDates: 'Check other dates', site: '/en/',
    cancelText: 'Plans changed?', cancelLabel: 'Request a cancellation', cancelPath: '/en/cancel/',
    cxTitle: 'Booking cancelled', cxPre: (p: string, d: string) => `Your booking has been cancelled: ${p}, ${d}`, cxIntro: 'as requested, we have cancelled your booking. We are sorry we will not see you this time — you are welcome any other time!',
    cxSubject: (p: string, d: string) => `Booking cancelled — ${p}, ${d}`,
    cdTitle: 'Reply to your cancellation request', cdPre: (p: string) => `Reply to your cancellation request — ${p}`, cdIntro: 'we have received your cancellation request. Your booking remains active — see the details below.',
    cdSubject: (p: string) => `Reply to your cancellation request — ${p}`,
    cxOutro: ['If you have any questions, just reply to this e-mail or call +48 510 248 693.', 'Kind regards,\nthe Od Morza do Gór team'],
  },
};
const txt = (r: RequestRow) => TXT[mailLang(r.lang)];

/** „sob., 31/10/2026” / „Sat, 31/10/2026” — data zawsze DD/MM/RRRR */
export const longDate = (iso: string, locale: string) =>
  `${new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' })}, ${dmy(iso)}`;

function stayRows(db: DatabaseSync, r: RequestRow, price: number | null, t = TXT.pl, priceLabel = t.price): MailRow[] {
  const u = unitInfo(db, r.unit_id);
  const n = nightsBetween(r.check_in, r.check_out);
  return [
    [t.property, `${u.property}\n${guestUnitName(u, t === TXT.en ? 'en' : 'pl')}`],
    [t.arrival, longDate(r.check_in, t.locale)],
    [t.departure, longDate(r.check_out, t.locale)],
    [t.length, t.nights(n)],
    [t.guests, t.people(r.adults, r.children)],
    ...extrasRow(r, t === TXT.en ? 'en' : 'pl'),
    [priceLabel, price != null ? zl(price) : t.tbd],
  ];
}
const extrasRow = (r: RequestRow, lang: Lang): MailRow[] => {
  const list = parseChosenExtras(r.extras);
  return list.length ? [[lang === 'en' ? 'Extras' : 'Opcje dodatkowe', extrasLines(list, lang).join('\n')]] : [];
};

export const NOTIFY_EMAILS_KEY = 'notify_emails';
// Które e-maile wysyłać (wszystkie domyślnie włączone): do Ciebie — nowe zapytania, prośby o anulację, odpowiedzi
// na oferty; do gościa — automatyczne „Otrzymaliśmy Twoje zapytanie”
export const EMAIL_NOTIFY_KEY = 'email_notify';
export type EmailNotify = { requests: boolean; cancellations: boolean; offers: boolean; guest_receipt: boolean };
export function emailNotify(db: DatabaseSync): EmailNotify {
  let v: Record<string, unknown> = {};
  try { v = JSON.parse((db.prepare('SELECT value FROM settings WHERE key = ?').get(EMAIL_NOTIFY_KEY) as { value: string } | undefined)?.value ?? '{}'); } catch { v = {}; }
  return { requests: v.requests !== false, cancellations: v.cancellations !== false, offers: v.offers !== false, guest_receipt: v.guest_receipt !== false };
}
/**
 * Dokąd trafiają odpowiedzi gości na e-maile z kalendarza: 'inbox' — do Poczty w aplikacji (adres nadawcy, np. rezerwacje@),
 * 'admin' — na adres z ustawień powiadomień, 'auto' (domyślnie) — do Poczty, jeśli odbiór działa (była wiadomość w ostatnich 90 dniach).
 */
export function guestReplyTo(db: DatabaseSync): string | undefined {
  const mode = (db.prepare('SELECT value FROM settings WHERE key = ?').get('guest_reply_to') as { value: string } | undefined)?.value ?? 'auto';
  if (mode === 'inbox') return undefined;
  if (mode === 'auto') {
    const recent = db.prepare(`SELECT 1 FROM mail_messages WHERE direction = 'in' AND created_at >= datetime('now', '-90 days') LIMIT 1`).get();
    if (recent) return undefined;
  }
  return adminEmails(db)[0];
}

export function adminEmails(db: DatabaseSync): string[] {
  const saved = (db.prepare('SELECT value FROM settings WHERE key = ?').get(NOTIFY_EMAILS_KEY) as { value: string } | undefined)?.value;
  return parseEmails(saved ?? process.env.ADMIN_EMAIL ?? '');
}

export const appUrl = () => (process.env.APP_URL || 'https://kalendarz.odmorzadogor.pl').replace(/\/$/, '');
export const siteUrl = () => (process.env.SITE_URL || 'https://odmorzadogor.pl').replace(/\/$/, '');
export const firstName = (full: string) => full.trim().split(/\s+/)[0] || '';

/** Nowe zapytanie: push do obsługi (z dostępem do obiektu), e-mail do właściciela i potwierdzenie dla gościa. */
export async function announceRequest(db: DatabaseSync, push: Sender | undefined, mailer: Mailer | undefined, r: RequestRow) {
  const u = unitInfo(db, r.unit_id);
  const n = nightsBetween(r.check_in, r.check_out);
  const range = dateRange(r.check_in, r.check_out);
  const jobs: Promise<unknown>[] = [];

  if (push) {
    const users = db.prepare(`SELECT DISTINCT u.id FROM users u JOIN push_subscriptions p ON p.user_id = u.id WHERE u.notify_requests = 1`).all() as { id: number }[];
    const msg = {
      title: `Nowe zapytanie · ${guestUnitName(u)} · ${u.property}`,
      body: `${r.guest_name} · ${range} (${nightsPl(n)}) · ${r.adults + r.children} os.${r.quoted_price != null ? ` · ${zl(r.quoted_price)}` : ''}`,
      url: `/?tab=requests&request=${r.id}`,
      tag: `request-${r.id}`,
    };
    for (const user of users) {
      const allowed = allowedUnitIds(db, { properties: propertyIdsOf(db, user.id) });
      if (!allowed || allowed.has(r.unit_id)) jobs.push(sendToSubscriptions(db, push, user.id, msg));
    }
  }

  if (mailer) {
    const flags = emailNotify(db);
    const admins = flags.requests ? adminEmails(db) : [];
    if (admins.length) {
      const m = renderMail({
        preheader: `${r.guest_name} · ${u.property} · ${range}`,
        title: 'Nowe zapytanie o rezerwację',
        intro: [`${r.guest_name} chce zarezerwować ${guestUnitName(u)} (${u.property})${groupSize(r) > 1 ? ` — proponowany wolny domek: ${u.unit}` : ''}. Zaakceptuj albo odrzuć zapytanie w aplikacji — gość dostanie e-mail z odpowiedzią.`
          + (readSiteLang(r.lang) !== 'pl' ? ` Zapytanie z ${LANG_NAMES[readSiteLang(r.lang)]} wersji strony — gość dostanie odpowiedź po angielsku.` : '')],
        rows: [...stayRows(db, r, r.quoted_price, TXT.pl, 'Wycena wg cennika'), ['Telefon', r.guest_phone || '—'], ['E-mail', r.guest_email]],
        note: r.message ? { label: 'Wiadomość od gościa', text: r.message } : undefined,
        button: { label: 'Otwórz w kalendarzu', url: `${appUrl()}/?tab=requests&request=${r.id}` },
      });
      jobs.push(mailer.send({ to: admins, subject: `Zapytanie: ${u.property} · ${range} · ${r.guest_name}`, ...m, replyTo: r.guest_email }));
    }
    const t = txt(r);
    if (flags.guest_receipt) {
    const g = renderMail({
      preheader: t.gotPre,
      title: t.gotTitle,
      intro: [t.hello(firstName(r.guest_name)), t.gotIntro(u.property)],
      rows: stayRows(db, r, r.quoted_price, t, t.estimate),
      note: r.message ? { label: t.yourMsg, text: r.message } : undefined,
      outro: t.gotOutro,
    }, mailLang(r.lang));
    jobs.push(mailer.send({ to: [r.guest_email], subject: t.gotSubject(u.property), ...g, replyTo: guestReplyTo(db) }));
    }
  }

  const results = await Promise.allSettled(jobs);
  for (const res of results) if (res.status === 'rejected') console.error('Powiadomienie o zapytaniu nie powiodło się:', res.reason);
}

/** Odpowiedź do gościa po decyzji (akceptacja / odrzucenie). */
export async function mailDecision(db: DatabaseSync, mailer: Mailer | undefined, r: RequestRow, accepted: boolean, price: number | null, extraRows: MailRow[] = [],
  images: { src: string; caption: string; href?: string }[] = []) {
  if (!mailer) return false;
  const m = composeDecision(db, r, accepted, price, extraRows, images);
  await mailer.send({ to: [r.guest_email], subject: m.subject, html: m.html, text: m.text, replyTo: guestReplyTo(db) });
  return true;
}

/** Treść e-maila z decyzją (też do podglądu w aplikacji przed wysłaniem). */
export function composeDecision(db: DatabaseSync, r: RequestRow, accepted: boolean, price: number | null, extraRows: MailRow[] = [],
  images: { src: string; caption: string; href?: string }[] = []) {
  const u = unitInfo(db, r.unit_id);
  const t = txt(r);
  const lang = mailLang(r.lang);
  const range = dateRange(r.check_in, r.check_out);
  const m = accepted
    ? renderMail({
        preheader: t.okPre(u.property, range),
        title: t.okTitle,
        intro: [t.hello(firstName(r.guest_name)), t.okIntro],
        rows: [...stayRows(db, r, price, t), ...extraRows, ...(u.address ? [[t.address, u.address] as MailRow] : [])],
        images,
        note: r.decision_note ? { label: t.fromUs, text: r.decision_note } : undefined,
        outro: t.okOutro,
        link: r.cancel_token ? { text: t.cancelText, label: t.cancelLabel, url: `${siteUrl()}${sitePath(r.lang, 'cancel')}?t=${r.cancel_token}` } : undefined,
      }, lang)
    : renderMail({
        preheader: t.noPre(u.property, range),
        title: t.noTitle,
        intro: [t.hello(firstName(r.guest_name)), t.noIntro(u.property)],
        rows: stayRows(db, r, r.quoted_price, t, t.estimate),
        note: r.decision_note ? { label: t.msgFromUs, text: r.decision_note } : undefined,
        button: { label: t.otherDates, url: siteUrl() + sitePath(r.lang, 'home') },
        outro: t.noOutro,
      }, lang);
  return { subject: accepted ? t.okSubject(u.property, range) : t.noSubject(u.property), ...m };
}

/** Prośba gościa o anulację: push dla obsługi i e-mail do właściciela. */
export async function announceCancelRequest(db: DatabaseSync, push: Sender | undefined, mailer: Mailer | undefined, r: RequestRow) {
  const u = unitInfo(db, r.unit_id);
  const range = dateRange(r.check_in, r.check_out);
  const jobs: Promise<unknown>[] = [];
  if (push) {
    const users = db.prepare(`SELECT DISTINCT u.id FROM users u JOIN push_subscriptions p ON p.user_id = u.id WHERE u.notify_requests = 1`).all() as { id: number }[];
    const msg = { title: `Prośba o anulację · ${u.unit} · ${u.property}`, body: `${r.guest_name} · ${range}${r.cancel_reason ? ` · „${r.cancel_reason.slice(0, 80)}”` : ''}`, url: `/?tab=requests&request=${r.id}`, tag: `cancel-${r.id}` };
    for (const user of users) {
      const allowed = allowedUnitIds(db, { properties: propertyIdsOf(db, user.id) });
      if (!allowed || allowed.has(r.unit_id)) jobs.push(sendToSubscriptions(db, push, user.id, msg));
    }
  }
  const admins = emailNotify(db).cancellations ? adminEmails(db) : [];
  if (mailer && admins.length) {
    const m = renderMail({
      preheader: `${r.guest_name} prosi o anulację · ${u.property} · ${range}`,
      title: 'Prośba o anulację rezerwacji',
      intro: [`${r.guest_name} prosi o anulację rezerwacji ${u.unit} (${u.property}). Potwierdź anulację albo odrzuć prośbę w aplikacji — gość dostanie e-mail z odpowiedzią.`],
      rows: [...stayRows(db, r, null, TXT.pl, 'Cena').filter(([k]) => k !== 'Cena'), ['Telefon', r.guest_phone || '—'] as MailRow, ['E-mail', r.guest_email] as MailRow],
      note: r.cancel_reason ? { label: 'Powód podany przez gościa', text: r.cancel_reason } : undefined,
      button: { label: 'Otwórz w kalendarzu', url: `${appUrl()}/?tab=requests&request=${r.id}` },
    });
    jobs.push(mailer.send({ to: admins, subject: `Prośba o anulację: ${u.property} · ${range} · ${r.guest_name}`, ...m, replyTo: r.guest_email }));
  }
  for (const res of await Promise.allSettled(jobs)) if (res.status === 'rejected') console.error('Powiadomienie o anulacji nie powiodło się:', res.reason);
}

/** Odpowiedź do gościa na prośbę o anulację. */
export async function mailCancelDecision(db: DatabaseSync, mailer: Mailer | undefined, r: RequestRow, confirmed: boolean) {
  if (!mailer) return false;
  const u = unitInfo(db, r.unit_id);
  const t = txt(r);
  const lang = mailLang(r.lang);
  const range = dateRange(r.check_in, r.check_out);
  const m = renderMail({
    preheader: confirmed ? t.cxPre(u.property, range) : t.cdPre(u.property),
    title: confirmed ? t.cxTitle : t.cdTitle,
    intro: [t.hello(firstName(r.guest_name)), confirmed ? t.cxIntro : t.cdIntro],
    rows: stayRows(db, r, null, t).filter(([k]) => k !== t.price),
    note: r.cancel_note ? { label: t.msgFromUs, text: r.cancel_note } : undefined,
    button: confirmed ? { label: t.otherDates, url: siteUrl() + sitePath(r.lang, 'home') } : undefined,
    outro: t.cxOutro,
  }, lang);
  await mailer.send({ to: [r.guest_email], subject: confirmed ? t.cxSubject(u.property, range) : t.cdSubject(u.property), ...m, replyTo: guestReplyTo(db) });
  return true;
}

export async function mailTest(mailer: Mailer, to: string[]) {
  const m = renderMail({
    preheader: 'Test powiadomień e-mail',
    title: 'E-maile działają ✓',
    intro: ['To jest wiadomość testowa z kalendarza Od Morza do Gór. Na te adresy przyjdą powiadomienia o nowych zapytaniach o rezerwację ze strony.'],
    button: { label: 'Otwórz kalendarz', url: appUrl() },
  });
  await mailer.send({ to, subject: 'Test powiadomień e-mail — Kalendarz', ...m });
}
