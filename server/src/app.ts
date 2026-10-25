import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { newToken } from './db.ts';
import {
  SESSION_COOKIE, SESSION_DAYS, allowedUnitIds, checkLogin, clearFails, createSession, deleteSession, lockedFor, registerFail, sessionUser, setPassword,
  verifyPassword, hashPassword, type User,
} from './auth.ts';
import { buildIcal } from './ical.ts';
import { TIME_RE, arrivalMessages, saveSubscription, sendToSubscriptions, vapidKeys, warsawDate, warsawTime, type Sender } from './push.ts';
import { syncAll } from './sync.ts';
import { announce, syncEvents, type ChangeEvent } from './changes.ts';
import { isEmail, parseEmails, type Mailer } from './mail.ts';
import {
  DEFAULT_HORIZON, appUrl, SITE_LANGS, readSiteLang, mailLang, sitePath, EMAIL_NOTIFY_KEY, emailNotify, HORIZON_KEY, HORIZON_UNTIL_KEY, horizonUntil, announceCancelRequest, chooseUnit, mailCancelDecision, propertyClosure, unitGroup, extrasFor, extrasLines, parseChosenExtras, priceExtras, NOTIFY_EMAILS_KEY, addDays, adminEmails, bookingHorizon, horizonEnd, parseWeekdayPrices, announceRequest, mailDecision, composeDecision, mailTest, nights, nightsBetween, quote, unitPricing, zl, type RequestRow,
} from './booking.ts';
import {
  composeMessage, defaultDeposit, depositRows, draftMessage, notifyStaff, offerExpired, offerUrl, paymentSettings, readPaymentSettings, sendGuestMessage, staffRows,
  plusDays, MESSAGE_KINDS, PAYMENT_SETTINGS_KEY, type MessageKind, type OfferRow, type Stay,
  setQrKey, titleRange, paymentQrs, accountFor, readCurrency, money as fmtMoney, revolutLink, depositImages,
} from './payments.ts';
import { epcPayload, plBankPayload, qrFromPath, qrPng } from './qr.ts';
import {
  autoFooter, readSignature, invoiceData, invoiceFileName, invoiceSettings, itemsTotal, nextInvoiceNumber, readInvoiceSettings, readItems, readParty, renderInvoicePdf,
  INVOICE_SETTINGS_KEY, type InvoiceData, type InvoiceRow,
} from './invoice.ts';
import { dateRange } from './changes.ts';
import { MAILBOXES_KEY, REPLY_TO_KEY, addrOf, fromHeader, lastInbound, mailboxes, replyHtml, storeMessage, withMailLog } from './mailbox.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['confirmed', 'tentative', 'cancelled'];
const PHONE_RE = /^[+\d][\d\s()-]{6,}$/;

function bad(message: string): never {
  throw new HTTPException(400, { message });
}
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
const money = (v: unknown) => (v === null || v === '' || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Proste ograniczenie liczby zapytań ze strony (w pamięci): na adres IP i łącznie na godzinę.
const PUBLIC_LIMIT_PER_IP = 5;
const PUBLIC_LIMIT_TOTAL = 60;
const HOUR = 3600_000;
const warsawToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });

export function createApp(db: DatabaseSync, apiKey: string, pushSender?: Sender, rawMailer?: Mailer) {
  const app = new Hono();
  setQrKey(apiKey);
  // e-maile do gości zapisują się w Poczcie (rozmowy); powiadomienia do obsługi nie
  const mailer = rawMailer && withMailLog(db, rawMailer, (to) => {
    const staff = new Set(adminEmails(db).map((a) => a.toLowerCase()));
    return to.length > 0 && to.every((a) => staff.has(addrOf(a)));
  });
  const all = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p);
  const get = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p);
  const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Błąd serwera' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // Publiczny (z tokenem) eksport kalendarza — importowany przez Booking/Airbnb, żeby blokować terminy.
  app.get('/ical/:file', (c) => {
    const token = c.req.param('file').replace(/\.ics$/, '');
    const unit = get('SELECT id, name FROM units WHERE export_token = ?', token) as { id: number; name: string } | undefined;
    if (!unit) return c.text('Not found', 404);
    const exclude = (c.req.query('exclude') ?? '').split(',').filter(Boolean);
    const rows = (all(`SELECT id, check_in, check_out, source FROM reservations
      WHERE unit_id = ? AND status != 'cancelled' AND check_out >= date('now', '-1 day')`, unit.id) as
      { id: number; check_in: string; check_out: string; source: string }[])
      .filter((r) => !exclude.includes(r.source));
    return c.body(buildIcal(unit.name, rows.map((r) => ({ id: r.id, start: r.check_in, end: r.check_out }))), 200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  });

  // ---- Strona www (odmorzadogor.pl): cennik, dostępność i zapytania o rezerwację ----
  // Bez logowania, ale tylko przez proxy z kluczem API (Cloudflare Pages → tunel). Nie zwraca danych gości.
  const pub = new Hono();
  // Podpis linku do rachunku (bez logowania, nie do odgadnięcia; zawsze aktualna wersja rachunku)
  const invoiceSig = (id: number) => createHmac('sha256', apiKey).update(`invoice:${id}`).digest('base64url').slice(0, 24);
  const invoiceShareUrl = (id: number, number: string) => `${appUrl()}/public/rachunek/${id}/${invoiceSig(id)}/${invoiceFileName(number)}`;
  const hits = new Map<string, number[]>();
  const allowHit = (key: string, limit: number) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < HOUR);
    if (list.length >= limit) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    return true;
  };
  pub.use('*', async (c, next) => {
    if (!safeEqual(c.req.header('x-api-key') ?? '', apiKey)) return c.json({ error: 'Brak autoryzacji serwera' }, 403);
    await next();
  });

  pub.get('/catalog', (c) => {
    const properties = all('SELECT id, name, location FROM properties ORDER BY sort, id') as { id: number; name: string; location: string }[];
    const units = all('SELECT id, property_id FROM units WHERE bookable = 1 ORDER BY sort, id') as { id: number; property_id: number }[];
    // „Cena od” = najniższa cena za noc w okresie, który strona pokazuje (podstawowa, dni tygodnia i ceny na konkretne dni)
    const today = warsawToday();
    const end = horizonEnd(db);
    return c.json(properties.map((p) => ({
      ...p,
      // zamknięcie obiektu: from/to = null przy zamknięciu do odwołania
      closed: (() => {
        const cl = propertyClosure(db, p.id);
        return cl && (!cl.closed_to || cl.closed_to >= today)
          ? { from: cl.closed_from, to: cl.closed_to, note: cl.closed_note, note_en: cl.closed_note_en || cl.closed_note } : null;
      })(),
      extras: extrasFor(db, p.id).map((e) => ({ id: e.id, name: e.name, name_en: e.name_en || e.name, description: e.description, price: e.price, per: e.per, max_qty: e.max_qty })),
      ...(() => {
        const list = units.filter((u) => u.property_id === p.id).map(({ id }) => {
          const u = unitPricing(db, id)!;
          const prices = nights(db, u, today, end).map((n) => n.price).filter((v): v is number => v != null);
          return { id, name: u.name, type_name: u.type_name, type_name_en: u.type_name_en, capacity: u.capacity, base_price: u.base_price, min_nights: u.min_nights, price_from: prices.length ? Math.min(...prices) : null };
        });
        // Typy: domki z tym samym typem pokazujemy jako jedną opcję („Mały domek · 3 domki”), pozostałe osobno
        const types: { key: string; name: string; name_en: string; unit_ids: number[]; count: number; capacity: number; min_nights: number; price_from: number | null }[] = [];
        for (const u of list) {
          const key = u.type_name ? `t:${u.type_name.toLowerCase()}` : `u:${u.id}`;
          const t = types.find((x) => x.key === key);
          if (!t) types.push({ key, name: u.type_name || u.name, name_en: (u.type_name && u.type_name_en) || u.type_name || u.name, unit_ids: [u.id], count: 1, capacity: u.capacity, min_nights: u.min_nights, price_from: u.price_from });
          else {
            t.unit_ids.push(u.id);
            t.count++;
            t.capacity = Math.min(t.capacity, u.capacity);
            t.min_nights = Math.min(t.min_nights, u.min_nights);
            t.price_from = [t.price_from, u.price_from].filter((v): v is number => v != null).reduce((a, b) => Math.min(a, b), Infinity);
            if (t.price_from === Infinity) t.price_from = null;
          }
        }
        return { units: list.map(({ type_name: _, type_name_en: __, ...u }) => u), types };
      })(),
    })).filter((p) => p.units.length));
  });

  // Kalendarz: ?unit=ID (jeden domek) albo ?units=1,2,3 (typ domku) &from=RRRR-MM-DD&to=RRRR-MM-DD (maks. 15 miesięcy)
  pub.get('/calendar', (c) => {
    const group = c.req.query('units') ? unitGroup(db, c.req.query('units')) : null;
    const unit = group ? group[0] : unitPricing(db, int(c.req.query('unit')));
    if (!unit || !unit.bookable) return c.json({ error: 'Nie znaleziono domku' }, 404);
    const today = warsawToday();
    let from = str(c.req.query('from'), 10);
    let to = str(c.req.query('to'), 10);
    if (!DATE_RE.test(from) || from < today) from = today;
    if (!DATE_RE.test(to) || to <= from) to = addDays(from, 62);
    if (nightsBetween(from, to) > 460) to = addDays(from, 460);
    // dalej niż horyzont ustawiony w aplikacji strona nie pokazuje cen ani wolnych dni
    const end = horizonEnd(db);
    if (to > end) to = end > from ? end : from;
    c.header('Cache-Control', 'no-store');
    if (group) {
      // dla każdego dnia: ceny i min. nocy każdego domku + maska zajętości (bit j = domek j zajęty/zamknięty)
      const lists = group.map((u) => nights(db, u, from, to));
      return c.json({
        unit_ids: group.map((u) => u.id), from, to, capacity: Math.min(...group.map((u) => u.capacity)),
        days: lists[0].map((n, i) => [n.date, lists.map((l) => l[i].price), lists.map((l) => l[i].min_nights),
          lists.reduce((mask, l, j) => mask | (l[i].booked || l[i].closed ? 1 << j : 0), 0)]),
      });
    }
    const list = nights(db, unit, from, to);
    return c.json({
      unit_id: unit.id, from, to, capacity: unit.capacity,
      // zwięźle: [data, cena|null, min. nocy, 1 = zajęte/zamknięte]
      days: list.map((n) => [n.date, n.price, n.min_nights, n.booked || n.closed ? 1 : 0]),
    });
  });

  pub.get('/quote', (c) => {
    const unit = unitPricing(db, int(c.req.query('unit')));
    const checkIn = str(c.req.query('check_in'), 10), checkOut = str(c.req.query('check_out'), 10);
    if (!unit || !unit.bookable) return c.json({ error: 'Nie znaleziono domku' }, 404);
    if (!DATE_RE.test(checkIn) || !DATE_RE.test(checkOut) || checkOut <= checkIn) bad('Nieprawidłowe daty');
    return c.json(quote(db, unit, checkIn, checkOut, mailLang(c.req.query('lang'))));
  });

  pub.post('/requests', async (c) => {
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    // Pole-pułapka: ludzie go nie widzą, boty wypełniają → udajemy sukces
    if (str(b.website)) return c.json({ ok: true, id: 0 }, 201);
    const ip = c.req.header('x-client-ip') || 'unknown';
    if (!allowHit(`ip:${ip}`, PUBLIC_LIMIT_PER_IP) || !allowHit('total', PUBLIC_LIMIT_TOTAL)) {
      return c.json({ error: mailLang(b.lang) === 'en' ? 'Too many requests. Please try again later or call +48 510 248 693.' : 'Za dużo zapytań. Spróbuj za jakiś czas albo zadzwoń: +48 510 248 693.' }, 429);
    }
    const en = mailLang(b.lang) === 'en';
    const t = (pl: string, eng: string) => (en ? eng : pl);
    // unit_ids = typ domku (kilka takich samych domków), unit_id = jeden konkretny
    const group = unitGroup(db, Array.isArray(b.unit_ids) ? b.unit_ids : [b.unit_id]);
    if (!group) bad(t('Wybierz domek lub apartament', 'Please choose a cottage or apartment'));
    const r = {
      check_in: str(b.check_in, 10), check_out: str(b.check_out, 10),
      guest_name: str(b.name, 120), guest_phone: str(b.phone, 40), guest_email: str(b.email, 200).toLowerCase(),
      adults: int(b.adults), children: int(b.children), message: str(b.message, 3000),
    };
    if (!DATE_RE.test(r.check_in) || !DATE_RE.test(r.check_out) || r.check_out <= r.check_in) bad(t('Wybierz daty przyjazdu i wyjazdu', 'Please choose check-in and check-out dates'));
    if (r.check_in < warsawToday()) bad(t('Data przyjazdu już minęła', 'The check-in date is in the past'));
    if (nightsBetween(r.check_in, r.check_out) > 60) bad(t('Pobyt może trwać maksymalnie 60 nocy — w sprawie dłuższych zadzwoń do nas', 'Stays are limited to 60 nights online — please call us about longer stays'));
    if (r.guest_name.split(/\s+/).filter((w) => w.length >= 2).length < 2) bad(t('Podaj imię i nazwisko', 'Please enter your first and last name'));
    if (!isEmail(r.guest_email)) bad(t('Podaj poprawny adres e-mail', 'Please enter a valid e-mail address'));
    if (!PHONE_RE.test(r.guest_phone)) bad(t('Podaj numer telefonu', 'Please enter your phone number'));
    if (r.adults < 1) bad(t('Podaj liczbę dorosłych', 'Please enter the number of adults'));
    // domki, które pomieszczą gości (w typie zwykle wszystkie mają tę samą pojemność)
    const fits = group.filter((u) => !u.capacity || r.adults + r.children <= u.capacity);
    const maxCap = Math.max(...group.map((u) => u.capacity || 0));
    if (!fits.length) bad(t(`Ten obiekt mieści maksymalnie ${maxCap} osób`, `This property sleeps up to ${maxCap} guests`));
    if (b.consent !== true) bad(t('Zaakceptuj zgodę na przetwarzanie danych, żebyśmy mogli odpowiedzieć', 'Please accept the data processing consent so we can reply'));
    const pick = chooseUnit(db, fits, r.check_in, r.check_out, en ? 'en' : 'pl');
    if (!pick.unit || !pick.q) return c.json({ error: pick.reason, code: 'unavailable' }, 409);
    const unit = pick.unit, q = pick.q;
    const propertyId = unit.property_id;
    const extras = priceExtras(db, propertyId, b.extras, q.nights);
    const extrasTotal = extras.reduce((s, e) => s + e.total, 0);
    const total = q.total == null ? null : q.total + extrasTotal;
    const res = run(`INSERT INTO booking_requests (unit_id, check_in, check_out, guest_name, guest_phone, guest_email, adults, children, message, quoted_price, ip, lang, extras, group_unit_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, unit.id, r.check_in, r.check_out, r.guest_name, r.guest_phone, r.guest_email,
      r.adults, r.children, r.message, total, ip.slice(0, 64), readSiteLang(b.lang), extras.length ? JSON.stringify(extras) : null,
      group.length > 1 ? JSON.stringify(fits.map((u) => u.id)) : null);
    const row = get('SELECT * FROM booking_requests WHERE id = ?', res.lastInsertRowid) as RequestRow;
    announceRequest(db, pushSender, mailer, row).catch((err) => console.error('Powiadomienie o zapytaniu nie powiodło się', err));
    return c.json({ ok: true, id: row.id, quoted_price: total, extras_total: extrasTotal, nights: q.nights }, 201);
  });

  // ---- Prośba gościa o anulację (link z e-maila z potwierdzeniem: /anulacja/?t=KOD) ----
  type CancelRow = RequestRow & { status: string; cancel_requested_at: string | null; cancel_status: string | null; property_name: string; unit_type: string; unit_type_en: string; unit_name: string };
  const byCancelToken = (token: string) => (/^[a-f0-9]{48}$/.test(token)
    ? get(`SELECT r.*, p.name AS property_name, u.type_name AS unit_type, u.type_name_en AS unit_type_en, u.name AS unit_name FROM booking_requests r
        JOIN units u ON u.id = r.unit_id JOIN properties p ON p.id = u.property_id WHERE r.cancel_token = ?`, token) as CancelRow | undefined
    : undefined);
  const cancelState = (r: CancelRow) => {
    const res = r.reservation_id ? get('SELECT status FROM reservations WHERE id = ?', r.reservation_id) as { status: string } | undefined : undefined;
    if (!res || res.status === 'cancelled' || r.cancel_status === 'confirmed') return 'cancelled';
    if (r.check_in < warsawToday()) return 'past';
    if (r.cancel_status === 'requested') return 'requested';
    return 'active';
  };
  pub.get('/cancel', (c) => {
    const r = byCancelToken(str(c.req.query('t'), 64));
    if (!r) return c.json({ error: 'Nieprawidłowy lub nieaktualny link', code: 'not_found' }, 404);
    c.header('Cache-Control', 'no-store');
    // tylko to, co gość i tak ma w e-mailu — bez telefonu i adresu e-mail
    return c.json({
      property: r.property_name, unit: (mailLang(r.lang) === 'en' && r.unit_type_en) || r.unit_type || r.unit_name, check_in: r.check_in, check_out: r.check_out,
      guest: r.guest_name.split(/\s+/)[0], state: cancelState(r), requested_at: r.cancel_requested_at, lang: r.lang,
    });
  });
  pub.post('/cancel', async (c) => {
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const en = mailLang(b.lang) === 'en';
    if (!allowHit(`cancel:${c.req.header('x-client-ip') || 'unknown'}`, 10)) return c.json({ error: en ? 'Too many attempts — please call us.' : 'Za dużo prób — zadzwoń do nas.' }, 429);
    const r = byCancelToken(str(b.t, 64));
    if (!r) return c.json({ error: en ? 'Invalid or expired link' : 'Nieprawidłowy lub nieaktualny link', code: 'not_found' }, 404);
    const state = cancelState(r);
    if (state === 'cancelled') bad(en ? 'This booking has already been cancelled' : 'Ta rezerwacja jest już anulowana');
    if (state === 'past') bad(en ? 'The stay has already started — please call us' : 'Pobyt już się rozpoczął — zadzwoń do nas');
    if (state === 'requested') return c.json({ ok: true, state });
    run(`UPDATE booking_requests SET cancel_status = 'requested', cancel_requested_at = datetime('now'), cancel_reason = ?, cancel_note = '' WHERE id = ?`, str(b.reason, 1000), r.id);
    const row = get('SELECT * FROM booking_requests WHERE id = ?', r.id) as RequestRow;
    announceCancelRequest(db, pushSender, mailer, row).catch((err) => console.error('Powiadomienie o anulacji nie powiodło się', err));
    return c.json({ ok: true, state: 'requested' });
  });

  // ---- Kody QR do płatności (podpisany adres z e-maila / strony oferty) ----
  pub.get('/qr/:file', async (c) => {
    const data = c.req.param('file').replace(/\.png$/, '');
    const payload = qrFromPath(apiKey, data, str(c.req.query('s'), 40));
    if (!payload) return c.text('Not found', 404);
    return c.body(new Uint8Array(await qrPng(payload)), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
  });

  // ---- Rachunek dla gościa pod podpisanym linkiem (WhatsApp): /public/rachunek/<id>/<podpis>/<plik>.pdf ----
  pub.get('/rachunek/:id{[0-9]+}/:sig/:file', async (c) => {
    const id = Number(c.req.param('id'));
    const sig = c.req.param('sig');
    const want = invoiceSig(id);
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return c.text('Not found', 404);
    const row = get('SELECT * FROM invoices WHERE id = ?', id) as InvoiceRow | undefined;
    if (!row) return c.text('Not found', 404);
    return pdfResponse(c, await invoicePdf(invoiceData(row)), row.number, false);
  });

  // ---- Oferta cenowa: gość akceptuje cenę z obowiązkiem zapłaty (link z e-maila: /oferta/?t=KOD) ----
  const offerByToken = (token: string) => (/^[a-f0-9]{48}$/.test(token) ? get('SELECT * FROM offers WHERE token = ?', token) as OfferRow | undefined : undefined);
  /** Pobyt, którego dotyczy oferta (zapytanie albo rezerwacja) z ceną i zaliczką z oferty */
  const offerStay = (o: OfferRow): (Stay & { request?: RequestRow; reservation?: Record<string, unknown> }) | null => {
    if (o.request_id) {
      const r = get('SELECT * FROM booking_requests WHERE id = ?', o.request_id) as RequestRow | undefined;
      return r ? { ...r, unit_id: o.unit_id ?? r.unit_id, lang: o.lang, price: o.price, deposit: o.deposit, deposit_due: o.deposit_due, paid: 0, currency: o.currency, request: r } : null;
    }
    const res = o.reservation_id ? get('SELECT * FROM reservations WHERE id = ?', o.reservation_id) as Record<string, unknown> | undefined : undefined;
    return res ? { ...(res as unknown as Stay), lang: o.lang, price: o.price, deposit: o.deposit, deposit_due: o.deposit_due, currency: o.currency, reservation: res } : null;
  };
  const offerState = (o: OfferRow, st: ReturnType<typeof offerStay>) => {
    if (o.status !== 'sent') return o.status;
    if (!st) return 'withdrawn';
    if (st.request && (st.request.status !== 'pending' || st.request.expired_at)) return 'withdrawn';
    if (st.reservation && st.reservation.status === 'cancelled') return 'withdrawn';
    if (offerExpired(o) || st.check_in < warsawToday()) return 'expired';
    return 'open';
  };
  const offerView = (o: OfferRow) => {
    const st = offerStay(o);
    const ps = paymentSettings(db);
    const en = mailLang(o.lang) === 'en';
    const u = st ? get(`SELECT u.name, u.type_name, u.type_name_en, p.name AS property FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ?`, st.unit_id) as
      { name: string; type_name: string; type_name_en: string; property: string } | undefined : undefined;
    const state = offerState(o, st);
    return {
      state, lang: o.lang, guest: st ? st.guest_name.split(/\s+/)[0] : '',
      property: u?.property ?? '', unit: u ? (en && u.type_name_en) || u.type_name || u.name : '',
      check_in: st?.check_in ?? null, check_out: st?.check_out ?? null, adults: st?.adults ?? 0, children: st?.children ?? 0,
      extras: st ? extrasLines(parseChosenExtras(st.extras), en ? 'en' : 'pl') : [],
      price: o.price, deposit: o.deposit, deposit_due: o.deposit_due, valid_until: o.valid_until, message: o.message, currency: o.currency,
      terms: (en && ps.terms_en) || ps.terms, decided_at: o.decided_at,
      // dane do płatności dopiero po akceptacji: konto w walucie oferty, Revolut, kody QR
      payment: state === 'accepted' ? (() => {
        const acc = accountFor(ps, o.currency);
        const title = st ? `${en ? 'Deposit' : 'Zaliczka'} – ${st.guest_name}, ${titleRange(st.check_in, st.check_out, en ? 'en' : 'pl')}` : '';
        const revolut = revolutLink(ps);
        if (!acc && !revolut) return null;
        return {
          account_number: acc?.account_number ?? '', account_name: acc?.account_name ?? '', bank_name: acc?.bank_name ?? '', bic: acc?.bic ?? '',
          title, revolut, qr: o.deposit ? paymentQrs(ps, { amount: o.deposit, currency: o.currency, title }) : paymentQrs(ps, { amount: null, currency: o.currency, title }),
        };
      })() : null,
    };
  };
  pub.get('/offer', (c) => {
    const o = offerByToken(str(c.req.query('t'), 64));
    if (!o) return c.json({ error: 'Nieprawidłowy lub nieaktualny link', code: 'not_found' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json(offerView(o));
  });
  pub.post('/offer', async (c) => {
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const ip = c.req.header('x-client-ip') || 'unknown';
    const en = mailLang(b.lang) === 'en';
    const t = (pl: string, eng: string) => (en ? eng : pl);
    if (!allowHit(`offer:${ip}`, 10)) return c.json({ error: t('Za dużo prób — zadzwoń do nas.', 'Too many attempts — please call us.') }, 429);
    const o = offerByToken(str(b.t, 64));
    if (!o) return c.json({ error: t('Nieprawidłowy lub nieaktualny link', 'Invalid or expired link'), code: 'not_found' }, 404);
    const st = offerStay(o);
    const state = offerState(o, st);
    if (state === 'accepted' || state === 'declined') return c.json(offerView(o));
    if (state !== 'open' || !st) bad(state === 'expired' ? t('Oferta wygasła — skontaktuj się z nami', 'This offer has expired — please contact us') : t('Ta oferta jest już nieaktualna', 'This offer is no longer valid'));
    const range = dateRange(st.check_in, st.check_out);
    const url = st.request ? `/?tab=requests&request=${st.request.id}` : `/?reservation=${o.reservation_id}`;

    if (b.action === 'decline') {
      const reason = str(b.reason, 1000);
      run(`UPDATE offers SET status = 'declined', decided_at = datetime('now'), decided_ip = ?, decline_reason = ? WHERE id = ?`, ip.slice(0, 64), reason, o.id);
      notifyStaff(db, pushSender, mailer, st.unit_id, { title: `Oferta odrzucona · ${st.guest_name}`, body: `${range}${reason ? ` · „${reason.slice(0, 80)}”` : ''}`, url, tag: `offer-${o.id}` }, {
        subject: `Gość odrzucił ofertę: ${st.guest_name} · ${range}`,
        content: { preheader: `${st.guest_name} odrzucił(a) ofertę`, title: 'Gość odrzucił ofertę', intro: [`${st.guest_name} odrzucił(a) ofertę ${zl(o.price)}. Możesz wysłać nową ofertę albo odrzucić zapytanie w aplikacji.`],
          rows: staffRows(db, st, o.price), note: reason ? { label: 'Powód', text: reason } : undefined },
        replyTo: st.guest_email,
      }).catch(() => {});
      return c.json(offerView(get('SELECT * FROM offers WHERE id = ?', o.id) as OfferRow));
    }

    if (b.consent !== true) bad(t('Zaznacz akceptację ceny i obowiązku zapłaty', 'Please confirm the price and your obligation to pay'));
    const stamp = `${new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}, IP ${ip}`;
    let reservationId: number;
    let cancelUrl: string | null = null;
    if (st.request) {
      const r = st.request;
      const candidates = [...new Set([o.unit_id ?? r.unit_id, ...requestGroup(r)])];
      const unitId = candidates.find((id) => !conflicts({ unit_id: id, check_in: r.check_in, check_out: r.check_out, status: 'confirmed' }, 0).length);
      if (!unitId) {
        notifyStaff(db, pushSender, mailer, r.unit_id, { title: `Termin zajęty — oferta ${r.guest_name}`, body: `Gość chciał zaakceptować ofertę (${range}), ale termin jest już zajęty`, url, tag: `offer-${o.id}` }, {
          subject: `Oferta nie mogła zostać zaakceptowana: ${r.guest_name} · ${range}`,
          content: { preheader: 'Termin zajęty', title: 'Gość chciał zaakceptować ofertę — termin jest zajęty', intro: [`${r.guest_name} kliknął(-ęła) „Akceptuję”, ale wszystkie pasujące domki są już zajęte. Skontaktuj się z gościem.`], rows: [...staffRows(db, st, o.price), ['Telefon', r.guest_phone || '—'], ['E-mail', r.guest_email]] },
          replyTo: r.guest_email,
        }).catch(() => {});
        return c.json({ error: t('Niestety ten termin został właśnie zajęty. Skontaktujemy się z Tobą.', 'Unfortunately these dates have just been booked. We will contact you.'), code: 'unavailable' }, 409);
      }
      const made = reservationFromRequest(r, unitId, o.price, {
        by: 'gość (akceptacja oferty)', note: o.message, deposit: o.deposit, deposit_due: o.deposit_due, currency: o.currency,
        extraNote: `Gość zaakceptował ofertę ${fmtMoney(o.price, o.currency)}${o.deposit ? ` (zaliczka ${fmtMoney(o.deposit, o.currency)})` : ''} z obowiązkiem zapłaty: ${stamp}.`,
      });
      reservationId = made.created.id as number;
      cancelUrl = `${(process.env.SITE_URL || 'https://odmorzadogor.pl').replace(/\/$/, '')}${sitePath(o.lang, 'cancel')}?t=${made.cancelToken}`;
      notify([{ kind: 'created', row: made.created, by: 'gość (oferta)' }], null);
    } else {
      const before = st.reservation!;
      const line = `Gość zaakceptował ofertę ${fmtMoney(o.price, o.currency)}${o.deposit ? ` (zaliczka ${fmtMoney(o.deposit, o.currency)})` : ''} z obowiązkiem zapłaty: ${stamp}.`;
      run(`UPDATE reservations SET price = ?, deposit = ?, deposit_due = ?, currency = ?, status = CASE WHEN status = 'tentative' THEN 'confirmed' ELSE status END,
        notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END, updated_at = datetime('now') WHERE id = ?`,
        o.price, o.deposit, o.deposit_due, o.currency, line, line, before.id as number);
      reservationId = before.id as number;
      notify([{ kind: 'updated', before, after: get('SELECT * FROM reservations WHERE id = ?', reservationId) as Record<string, unknown>, by: 'gość (oferta)' }], null);
    }
    run(`UPDATE offers SET status = 'accepted', decided_at = datetime('now'), decided_ip = ?, reservation_id = ? WHERE id = ?`, ip.slice(0, 64), reservationId, o.id);
    const accepted = { ...st, unit_id: (get('SELECT unit_id FROM reservations WHERE id = ?', reservationId) as { unit_id: number }).unit_id };
    if (mailer) {
      sendGuestMessage(db, mailer, accepted, { kind: 'offer_accepted', cancelUrl, offerNote: '' }, { reservation_id: reservationId, request_id: o.request_id, sent_by: 'automatycznie' })
        .catch((err) => console.error('E-mail po akceptacji oferty nie wysłany', err));
    }
    notifyStaff(db, pushSender, mailer, accepted.unit_id, { title: `Oferta zaakceptowana ✓ · ${st.guest_name}`, body: `${range} · ${zl(o.price)}${o.deposit ? ` · zaliczka ${zl(o.deposit)}` : ''}`, url: `/?reservation=${reservationId}`, tag: `offer-${o.id}` }, {
      subject: `Gość zaakceptował ofertę: ${st.guest_name} · ${range} · ${zl(o.price)}`,
      content: { preheader: 'Oferta zaakceptowana', title: 'Gość zaakceptował ofertę ✓', intro: [`${st.guest_name} zaakceptował(a) ofertę z obowiązkiem zapłaty (${stamp}). Rezerwacja jest w kalendarzu.`],
        rows: [...staffRows(db, accepted, o.price), ...(o.deposit ? [['Zaliczka', `${zl(o.deposit)}${o.deposit_due ? ` do ${o.deposit_due}` : ''}`] as [string, string]] : [])] },
      replyTo: st.guest_email,
    }).catch(() => {});
    return c.json(offerView(get('SELECT * FROM offers WHERE id = ?', o.id) as OfferRow));
  });

  app.route('/public', pub);

  // ---- Odbiór poczty: Cloudflare Email Routing → Email Worker (mail-worker/) → tutaj (przez tunel, z kluczem API) ----
  app.post('/inbound/mail', async (c) => {
    if (!safeEqual(c.req.header('x-api-key') ?? '', apiKey)) return c.json({ error: 'Brak autoryzacji serwera' }, 403);
    const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!b) bad('Nieprawidłowa wiadomość');
    const addrList = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? x : String((x as { address?: string })?.address ?? ''))).filter(Boolean);
    const from = (b.from && typeof b.from === 'object' ? b.from : {}) as { address?: string; name?: string };
    const mailbox = addrOf(str(b.envelope_to, 300) || addrList(b.to)[0] || mailboxes(db)[0]);
    const attachments = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 30).map((a) => {
      const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
      return { filename: str(x.filename, 200), content_type: str(x.mimeType ?? x.content_type, 100), content_id: str(x.contentId, 200), data: Buffer.from(String(x.content ?? ''), 'base64') };
    }).filter((a) => a.data.length > 0 && a.data.length <= 15_000_000);
    const stored = storeMessage(db, {
      mailbox, direction: 'in', message_id: str(b.message_id, 500), in_reply_to: str(b.in_reply_to, 500),
      refs: String(b.references ?? '').split(/\s+/).filter(Boolean).slice(0, 30),
      from_addr: str(from.address, 300) || str(b.envelope_from, 300), from_name: str(from.name, 200),
      to: addrList(b.to), cc: addrList(b.cc), reply_to: addrList(b.reply_to)[0] ?? '',
      subject: str(b.subject, 500) || '(bez tematu)', text: typeof b.text === 'string' ? b.text.slice(0, 200_000) : '',
      html: typeof b.html === 'string' ? b.html.slice(0, 1_000_000) : '', date: b.date, attachments,
    });
    if (!stored) return c.json({ ok: true, duplicate: true });
    if (pushSender) {
      const users = all(`SELECT DISTINCT u.id FROM users u JOIN push_subscriptions p ON p.user_id = u.id
        WHERE u.notify_mail = 1 AND u.role = 'admin' AND u.property_ids IS NULL`) as { id: number }[];
      const msg = { title: `✉ ${str(from.name, 80) || str(from.address, 120)} · ${mailbox.split('@')[0]}@`, body: str(b.subject, 140) || '(bez tematu)', url: `/?tab=mail&thread=${stored.thread_id}`, tag: `mail-${stored.thread_id}` };
      Promise.allSettled(users.map((u) => sendToSubscriptions(db, pushSender, u.id, msg))).catch(() => {});
    }
    return c.json({ ok: true, id: stored.id, thread_id: stored.thread_id });
  });

  const api = new Hono<{ Variables: { user: User } }>();

  // ---- Dostęp do obiektów (konto może być ograniczone np. tylko do Osady Jantar) ----
  const canSee = (user: User, unitId: unknown) => {
    const units = allowedUnitIds(db, user);
    return !units || units.has(Number(unitId));
  };
  const requireUnit = (user: User, unitId: number) => {
    if (!canSee(user, unitId)) throw new HTTPException(403, { message: 'Brak dostępu do tego domku/apartamentu' });
  };
  // Fragment SQL zawężający rezerwacje do dostępnych domków (id to liczby z bazy — bezpieczne do wstawienia)
  const unitScope = (user: User) => {
    const units = allowedUnitIds(db, user);
    return units ? `AND unit_id IN (${[...units].join(',') || 'NULL'})` : '';
  };
  // Zarządzać użytkownikami może tylko admin bez ograniczenia do obiektów
  const isFullAdmin = (user: User) => user.role === 'admin' && !user.properties;

  const sessionInfo = (user: User) => {
    const names = user.properties
      ? (all(`SELECT name FROM properties WHERE id IN (${user.properties.join(',') || 'NULL'}) ORDER BY sort`) as { name: string }[]).map((p) => p.name)
      : null;
    return { username: user.username, role: user.role, properties: names, canManageUsers: isFullAdmin(user) };
  };

  // Powiadomienia o zmianach wysyłamy w tle — odpowiedź nie czeka na serwery Apple/Google.
  const notify = (events: ChangeEvent[], excludeUserId: number | null) => {
    announce(db, pushSender, events, excludeUserId).catch((err) => console.error('Powiadomienie o zmianie nie powiodło się', err));
  };
  // Klucz API dodaje proxy w Cloudflare Pages — bez niego serwer nie odpowiada nikomu.
  api.use('*', async (c, next) => {
    if (!safeEqual(c.req.header('x-api-key') ?? '', apiKey)) return c.json({ error: 'Brak autoryzacji serwera' }, 403);
    await next();
  });

  // ---- Logowanie ----
  const cookieOpts = (c: { req: { header: (n: string) => string | undefined } }) => ({
    path: '/', httpOnly: true, sameSite: 'Lax' as const, secure: c.req.header('x-forwarded-proto') === 'https',
  });

  api.post('/auth/login', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const username = str(b.username, 50);
    const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
    const keys = [`ip:${c.req.header('x-client-ip') ?? 'unknown'}`, `user:${username.toLowerCase()}`];
    const wait = lockedFor(keys);
    if (wait) return c.json({ error: `Za dużo nieudanych prób. Spróbuj za ${Math.ceil(wait / 60_000)} min.` }, 429);
    const user = username && password ? checkLogin(db, username, password) : null;
    if (!user) {
      registerFail(keys);
      return c.json({ error: 'Nieprawidłowy login lub hasło' }, 401);
    }
    clearFails(keys);
    setCookie(c, SESSION_COOKIE, createSession(db, user.id), { ...cookieOpts(c), maxAge: SESSION_DAYS * 86400 });
    return c.json(sessionInfo(user));
  });

  api.use('*', async (c, next) => {
    if (c.req.path.endsWith('/auth/login')) return next();
    const user = sessionUser(db, getCookie(c, SESSION_COOKIE));
    if (!user) return c.json({ error: 'Zaloguj się', code: 'unauthenticated' }, 401);
    c.set('user', user);
    // Konto „tylko podgląd”: wyłącznie odczyt, wylogowanie i zmiana własnego hasła.
    const readOnlyAllowed = c.req.method === 'GET' || c.req.path.endsWith('/auth/logout') || c.req.path.endsWith('/auth/password')
      || c.req.path.includes('/push/');
    if (user.role === 'viewer' && !readOnlyAllowed) return c.json({ error: 'Konto tylko do podglądu — brak uprawnień do zmian' }, 403);
    // Konto ograniczone do wybranych obiektów nie zmienia ustawień obiektów, domków ani kalendarzy Bookingu.
    if (user.properties && c.req.method !== 'GET' && /\/(properties|units|feeds)(\/|$)/.test(c.req.path)) {
      return c.json({ error: 'To konto ma dostęp tylko do wybranych obiektów — nie może zmieniać ich ustawień' }, 403);
    }
    await next();
  });

  api.get('/auth/me', (c) => c.json(sessionInfo(c.get('user'))));

  api.post('/auth/logout', (c) => {
    deleteSession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, cookieOpts(c));
    return c.json({ ok: true });
  });

  api.post('/auth/password', async (c) => {
    const b = await c.req.json();
    const user = c.get('user');
    const row = get('SELECT password_hash FROM users WHERE id = ?', user.id) as { password_hash: string };
    if (typeof b.current !== 'string' || !verifyPassword(b.current, row.password_hash)) bad('Obecne hasło jest nieprawidłowe');
    if (typeof b.next !== 'string' || b.next.length < 8) bad('Nowe hasło musi mieć co najmniej 8 znaków');
    setPassword(db, user.id, b.next); // usuwa też wszystkie sesje
    setCookie(c, SESSION_COOKIE, createSession(db, user.id), { ...cookieOpts(c), maxAge: SESSION_DAYS * 86400 });
    return c.json({ ok: true });
  });

  // ---- Powiadomienia push (dostępne też dla kont podglądu) ----
  api.get('/push/public-key', (c) => c.json({ publicKey: vapidKeys(db).publicKey }));

  const pushSettings = (userId: number) => {
    const row = get('SELECT notify_time, notify_changes, notify_requests, notify_mail FROM users WHERE id = ?', userId) as
      { notify_time: string; notify_changes: number; notify_requests: number; notify_mail: number };
    return { time: row.notify_time, changes: row.notify_changes === 1, requests: row.notify_requests === 1, mail: row.notify_mail === 1 };
  };

  api.get('/push/settings', (c) => c.json(pushSettings(c.get('user').id)));

  api.put('/push/settings', async (c) => {
    const b = await c.req.json();
    const user = c.get('user');
    if (b.time !== undefined) {
      if (typeof b.time !== 'string' || !TIME_RE.test(b.time)) bad('Podaj godzinę w formacie GG:MM');
      // Nowa godzina jeszcze dziś w przyszłości → powiadomienie przyjdzie dziś (także gdy dziś już było wysłane).
      if (b.time > warsawTime()) run('UPDATE users SET notified_on = NULL WHERE id = ?', user.id);
      run('UPDATE users SET notify_time = ? WHERE id = ?', b.time, user.id);
    }
    if (b.changes !== undefined) run('UPDATE users SET notify_changes = ? WHERE id = ?', b.changes ? 1 : 0, user.id);
    if (b.requests !== undefined) run('UPDATE users SET notify_requests = ? WHERE id = ?', b.requests ? 1 : 0, user.id);
    if (b.mail !== undefined) run('UPDATE users SET notify_mail = ? WHERE id = ?', b.mail ? 1 : 0, user.id);
    return c.json(pushSettings(user.id));
  });

  api.post('/push/subscribe', async (c) => {
    const b = await c.req.json();
    const sub = b.subscription;
    if (typeof sub?.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') {
      bad('Nieprawidłowa subskrypcja');
    }
    saveSubscription(db, c.get('user').id, sub);
    return c.json({ ok: true });
  });

  api.post('/push/unsubscribe', async (c) => {
    const b = await c.req.json();
    run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', str(b.endpoint, 1000), c.get('user').id);
    return c.json({ ok: true });
  });

  api.post('/push/test', async (c) => {
    if (!pushSender) return c.json({ error: 'Powiadomienia są wyłączone na serwerze' }, 503);
    const arrivals = arrivalMessages(db, warsawDate(), allowedUnitIds(db, c.get('user')));
    const messages = arrivals.length ? arrivals
      : [{ title: 'Powiadomienia działają ✓', body: 'Dziś brak przyjazdów. O ustawionej godzinie dostaniesz osobne powiadomienie o każdym przyjeździe.', url: '/?tab=agenda' }];
    let sent = 0;
    for (const msg of messages) sent += await sendToSubscriptions(db, pushSender, c.get('user').id, msg);
    return c.json({ sent });
  });

  // ---- Użytkownicy i uprawnienia (tylko pełny admin) ----
  const USERNAME_RE = /^[\w.@-]{3,50}$/;
  const requireFullAdmin = (user: User) => {
    if (!isFullAdmin(user)) throw new HTTPException(403, { message: 'Tylko administrator może zarządzać użytkownikami' });
  };
  const readScope = (v: unknown): number[] | null => {
    if (v === null || v === undefined) return null; // wszystkie obiekty
    if (!Array.isArray(v) || !v.length) bad('Wybierz co najmniej jeden obiekt albo „wszystkie”');
    const ids = [...new Set(v.map(Number))];
    const known = new Set((all('SELECT id FROM properties') as { id: number }[]).map((p) => p.id));
    if (ids.some((id) => !known.has(id))) bad('Nieznany obiekt');
    return ids;
  };
  const readRole = (v: unknown) => (v === 'admin' || v === 'viewer' ? v : bad('Wybierz rolę'));
  const userRow = (id: number) => {
    const u = get('SELECT id, username, role, property_ids, created_at FROM users WHERE id = ?', id) as
      { id: number; username: string; role: string; property_ids: string | null; created_at: string } | undefined;
    return u && { id: u.id, username: u.username, role: u.role, properties: u.property_ids ? JSON.parse(u.property_ids) as number[] : null, created_at: u.created_at };
  };
  const targetUser = (c: { req: { param: (k: string) => string } }, me: User, allowSelf = false) => {
    const u = userRow(int(c.req.param('id')));
    if (!u) throw new HTTPException(404, { message: 'Nie znaleziono użytkownika' });
    if (!allowSelf && u.id === me.id) bad('Nie możesz zmienić uprawnień ani usunąć własnego konta');
    return u;
  };

  api.get('/users', (c) => {
    requireFullAdmin(c.get('user'));
    const ids = (all('SELECT id FROM users ORDER BY username COLLATE NOCASE') as { id: number }[]).map((r) => r.id);
    return c.json(ids.map((id) => ({ ...userRow(id), me: id === c.get('user').id })));
  });

  api.post('/users', async (c) => {
    requireFullAdmin(c.get('user'));
    const b = await c.req.json();
    const username = str(b.username, 50);
    if (!USERNAME_RE.test(username)) bad('Login: 3–50 znaków (litery, cyfry, . _ - @)');
    if (get('SELECT 1 FROM users WHERE username = ?', username)) bad(`Użytkownik „${username}” już istnieje`);
    if (typeof b.password !== 'string' || b.password.length < 8) bad('Hasło musi mieć co najmniej 8 znaków');
    const role = readRole(b.role);
    const scope = readScope(b.properties);
    const r = run('INSERT INTO users (username, password_hash, role, property_ids) VALUES (?, ?, ?, ?)',
      username, hashPassword(b.password), role, scope ? JSON.stringify(scope) : null);
    return c.json(userRow(Number(r.lastInsertRowid)), 201);
  });

  api.put('/users/:id', async (c) => {
    const me = c.get('user');
    requireFullAdmin(me);
    const u = targetUser(c, me);
    const b = await c.req.json();
    const role = readRole(b.role);
    const scope = readScope(b.properties);
    run('UPDATE users SET role = ?, property_ids = ? WHERE id = ?', role, scope ? JSON.stringify(scope) : null, u.id);
    return c.json(userRow(u.id));
  });

  api.post('/users/:id/password', async (c) => {
    const me = c.get('user');
    requireFullAdmin(me);
    const u = targetUser(c, me, true);
    const b = await c.req.json();
    if (typeof b.password !== 'string' || b.password.length < 8) bad('Hasło musi mieć co najmniej 8 znaków');
    setPassword(db, u.id, b.password); // wylogowuje wszystkie sesje tego użytkownika
    if (u.id === me.id) setCookie(c, SESSION_COOKIE, createSession(db, me.id), { ...cookieOpts(c), maxAge: SESSION_DAYS * 86400 });
    return c.json({ ok: true });
  });

  api.delete('/users/:id', (c) => {
    const me = c.get('user');
    requireFullAdmin(me);
    const u = targetUser(c, me);
    run('DELETE FROM users WHERE id = ?', u.id);
    return c.json({ ok: true });
  });

  // ---- Obiekty i jednostki ----
  api.get('/properties', (c) => {
    const properties = all('SELECT * FROM properties ORDER BY sort, id') as Record<string, unknown>[];
    const units = all('SELECT * FROM units ORDER BY sort, id') as Record<string, unknown>[];
    const feeds = all('SELECT * FROM feeds ORDER BY id') as Record<string, unknown>[];
    const viewer = c.get('user').role === 'viewer';
    const allowed = c.get('user').properties;
    return c.json(properties.filter((p) => !allowed || allowed.includes(p.id as number)).map((p) => ({
      ...p,
      units: units.filter((u) => u.property_id === p.id).map((u) => (viewer
        // podgląd nie widzi prywatnych linków (token eksportu, adresy kalendarzy Bookingu)
        ? { ...u, export_token: '', feeds: [] }
        : { ...u, feeds: feeds.filter((f) => f.unit_id === u.id) })),
    })));
  });

  api.post('/properties', async (c) => {
    const b = await c.req.json();
    if (!str(b.name)) bad('Podaj nazwę obiektu');
    const { m } = get('SELECT COALESCE(MAX(sort), 0) + 1 AS m FROM properties') as { m: number };
    const r = run('INSERT INTO properties (name, location, address, sort) VALUES (?, ?, ?, ?)', str(b.name, 100), str(b.location, 100), str(b.address, 200), m);
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });

  api.put('/properties/:id', async (c) => {
    const b = await c.req.json();
    if (!str(b.name)) bad('Podaj nazwę obiektu');
    run('UPDATE properties SET name = ?, location = ?, address = ? WHERE id = ?', str(b.name, 100), str(b.location, 100), str(b.address, 200), c.req.param('id'));
    return c.json({ ok: true });
  });

  api.delete('/properties/:id', (c) => {
    run('DELETE FROM properties WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  api.post('/units', async (c) => {
    const b = await c.req.json();
    if (!str(b.name)) bad('Podaj nazwę');
    if (!get('SELECT 1 FROM properties WHERE id = ?', int(b.property_id))) bad('Nieznany obiekt');
    const { m } = get('SELECT COALESCE(MAX(sort), 0) + 1 AS m FROM units WHERE property_id = ?', int(b.property_id)) as { m: number };
    const r = run('INSERT INTO units (property_id, name, capacity, color, sort, export_token) VALUES (?, ?, ?, ?, ?, ?)',
      int(b.property_id), str(b.name, 100), int(b.capacity), /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#577267', m, newToken());
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });

  api.put('/units/:id', async (c) => {
    const b = await c.req.json();
    if (!str(b.name)) bad('Podaj nazwę');
    run('UPDATE units SET name = ?, capacity = ?, color = ? WHERE id = ?',
      str(b.name, 100), int(b.capacity), /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#577267', c.req.param('id'));
    return c.json({ ok: true });
  });

  api.post('/units/:id/regenerate-token', (c) => {
    run('UPDATE units SET export_token = ? WHERE id = ?', newToken(), c.req.param('id'));
    return c.json({ ok: true });
  });

  api.delete('/units/:id', (c) => {
    run('DELETE FROM units WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- Kalendarze zewnętrzne (Booking, Airbnb...) ----
  api.post('/feeds', async (c) => {
    const b = await c.req.json();
    const url = str(b.url, 1000);
    if (!/^https:\/\//.test(url)) bad('Adres kalendarza musi zaczynać się od https://');
    if (!get('SELECT 1 FROM units WHERE id = ?', int(b.unit_id))) bad('Nieznany domek/apartament');
    const source = str(b.source, 30) || 'booking';
    const r = run('INSERT INTO feeds (unit_id, source, url) VALUES (?, ?, ?)', int(b.unit_id), source, url);
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });

  // Podmiana linku (np. nowy eksport z Bookingu z zamkniętymi dniami) — rezerwacje i dane gości zostają.
  api.put('/feeds/:id', async (c) => {
    const b = await c.req.json();
    const url = str(b.url, 1000);
    if (!/^https:\/\//.test(url)) bad('Adres kalendarza musi zaczynać się od https://');
    const r = run('UPDATE feeds SET url = ?, last_error = NULL WHERE id = ?', url, c.req.param('id'));
    if (!r.changes) return c.json({ error: 'Nie znaleziono' }, 404);
    return c.json({ ok: true });
  });

  api.delete('/feeds/:id', (c) => {
    // Rezerwacje z usuniętego kalendarza stają się zwykłymi wpisami (feed_id = NULL) — nic nie ginie.
    run('DELETE FROM feeds WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  api.post('/sync', async (c) => {
    const results = await syncAll(db);
    notify(syncEvents(db, results.flatMap((r) => r.changes)), null);
    return c.json(results);
  });

  // ---- Rezerwacje ----
  api.get('/reservations/:id{[0-9]+}', (c) => {
    const row = get('SELECT * FROM reservations WHERE id = ?', int(c.req.param('id'))) as Record<string, unknown> | undefined;
    return row && canSee(c.get('user'), row.unit_id) ? c.json(row) : c.json({ error: 'Nie znaleziono rezerwacji' }, 404);
  });

  api.get('/reservations', (c) => {
    const from = c.req.query('from') ?? '0000-01-01';
    const to = c.req.query('to') ?? '9999-12-31';
    const withCancelled = c.req.query('cancelled') === '1';
    return c.json(all(`SELECT * FROM reservations WHERE check_out > ? AND check_in < ? ${withCancelled ? '' : "AND status != 'cancelled'"}
      ${unitScope(c.get('user'))} ORDER BY check_in, unit_id`, from, to));
  });

  api.get('/guests', (c) => {
    const q = `%${str(c.req.query('q'), 50)}%`;
    return c.json(all(`SELECT guest_name, guest_phone, guest_email, MAX(check_in) AS last_stay, COUNT(*) AS stays
      FROM reservations WHERE guest_name != '' AND (guest_name LIKE ? OR guest_phone LIKE ? OR guest_email LIKE ?) ${unitScope(c.get('user'))}
      GROUP BY lower(guest_name), guest_phone ORDER BY last_stay DESC LIMIT 10`, q, q, q));
  });

  function readReservation(b: Record<string, unknown>) {
    const r = {
      unit_id: int(b.unit_id),
      check_in: str(b.check_in, 10),
      check_out: str(b.check_out, 10),
      status: STATUSES.includes(b.status as string) ? (b.status as string) : 'confirmed',
      source: str(b.source, 30) || 'direct',
      guest_name: str(b.guest_name, 200),
      guest_phone: str(b.guest_phone, 50),
      guest_email: str(b.guest_email, 200),
      adults: int(b.adults),
      children: int(b.children),
      price: money(b.price),
      paid: money(b.paid),
      notes: str(b.notes, 5000),
      lang: readSiteLang(b.lang),
      deposit: money(b.deposit),
      deposit_due: DATE_RE.test(str(b.deposit_due, 10)) ? str(b.deposit_due, 10) : null,
      currency: readCurrency(b.currency),
    };
    if (!DATE_RE.test(r.check_in) || !DATE_RE.test(r.check_out)) bad('Nieprawidłowe daty');
    if (r.check_out <= r.check_in) bad('Wyjazd musi być po przyjeździe');
    if (!get('SELECT 1 FROM units WHERE id = ?', r.unit_id)) bad('Wybierz domek/apartament');
    return r;
  }

  const conflicts = (r: { unit_id: number; check_in: string; check_out: string; status: string }, exceptId: number) =>
    r.status === 'cancelled' ? [] : all(`SELECT id, check_in, check_out, guest_name, source FROM reservations
      WHERE unit_id = ? AND id != ? AND status != 'cancelled' AND check_in < ? AND check_out > ?`,
      r.unit_id, exceptId, r.check_out, r.check_in);

  api.post('/reservations', async (c) => {
    const b = await c.req.json();
    const r = readReservation(b);
    requireUnit(c.get('user'), r.unit_id);
    const found = conflicts(r, 0);
    if (found.length && !b.force) return c.json({ error: 'Termin nakłada się z inną rezerwacją', conflicts: found }, 409);
    const res = run(`INSERT INTO reservations (unit_id, check_in, check_out, status, source, guest_name, guest_phone, guest_email,
      adults, children, price, paid, notes, lang, deposit, deposit_due, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.unit_id, r.check_in, r.check_out, r.status, r.source, r.guest_name, r.guest_phone, r.guest_email,
      r.adults, r.children, r.price, r.paid, r.notes, r.lang, r.deposit, r.deposit_due, r.currency);
    const created = get('SELECT * FROM reservations WHERE id = ?', res.lastInsertRowid) as Record<string, unknown>;
    notify([{ kind: 'created', row: created, by: c.get('user').username }], c.get('user').id);
    return c.json(created, 201);
  });

  api.put('/reservations/:id', async (c) => {
    const id = int(c.req.param('id'));
    const existing = get('SELECT * FROM reservations WHERE id = ?', id) as Record<string, unknown> | undefined;
    if (!existing || !canSee(c.get('user'), existing.unit_id)) return c.json({ error: 'Nie znaleziono' }, 404);
    const b = await c.req.json();
    const r = readReservation(b);
    requireUnit(c.get('user'), r.unit_id);
    // Rezerwację z Bookingu można edytować w całości. Ręczna zmiana dat blokuje ich nadpisywanie przez synchronizację.
    const datesChanged = r.check_in !== existing.check_in || r.check_out !== existing.check_out;
    const datesLocked = existing.feed_id && datesChanged ? 1 : (existing.dates_locked as number);
    const found = conflicts(r, id);
    if (found.length && !b.force) return c.json({ error: 'Termin nakłada się z inną rezerwacją', conflicts: found }, 409);
    run(`UPDATE reservations SET unit_id = ?, check_in = ?, check_out = ?, status = ?, source = ?, guest_name = ?, guest_phone = ?,
      guest_email = ?, adults = ?, children = ?, price = ?, paid = ?, notes = ?, dates_locked = ?, lang = ?, deposit = ?, deposit_due = ?, currency = ?,
      updated_at = datetime('now') WHERE id = ?`,
      r.unit_id, r.check_in, r.check_out, r.status, r.source, r.guest_name, r.guest_phone, r.guest_email,
      r.adults, r.children, r.price, r.paid, r.notes, datesLocked, r.lang, r.deposit, r.deposit_due, r.currency, id);
    const updated = get('SELECT * FROM reservations WHERE id = ?', id) as Record<string, unknown>;
    notify([{ kind: 'updated', before: existing, after: updated, by: c.get('user').username }], c.get('user').id);
    return c.json(updated);
  });

  // ---- Odwołane na Bookingu: do przejrzenia / zamiany na prywatną ----
  api.get('/booking-cancellations', (c) => c.json(all(`SELECT * FROM reservations
    WHERE external_uid IS NOT NULL AND status = 'cancelled' AND cancelled_at IS NOT NULL AND cancel_reviewed = 0
    ${unitScope(c.get('user'))} ORDER BY check_in`)));

  const cancelledImport = (user: User, id: number) => {
    const row = get('SELECT * FROM reservations WHERE id = ?', id) as Record<string, unknown> | undefined;
    if (!row || !canSee(user, row.unit_id)) throw new HTTPException(404, { message: 'Nie znaleziono' });
    if (!row.external_uid || row.status !== 'cancelled') bad('To nie jest odwołana rezerwacja z Bookingu');
    return row;
  };

  api.post('/reservations/:id/convert-direct', async (c) => {
    const id = int(c.req.param('id'));
    const row = cancelledImport(c.get('user'), id);
    const b = await c.req.json().catch(() => ({}));
    const found = conflicts({ unit_id: row.unit_id as number, check_in: row.check_in as string, check_out: row.check_out as string, status: 'confirmed' }, id);
    if (found.length && !b.force) return c.json({ error: 'Termin nakłada się z inną rezerwacją', conflicts: found }, 409);
    const note = `Przeniesiona z ${row.source === 'booking' ? 'Booking.com' : row.source} po odwołaniu (${new Date().toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw' })}).`;
    // Odłączenie od kalendarza Bookingu: synchronizacja już jej nie dotknie.
    run(`UPDATE reservations SET feed_id = NULL, external_uid = NULL, source = 'direct', status = 'confirmed',
      cancelled_at = NULL, cancel_reviewed = 0, notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END,
      updated_at = datetime('now') WHERE id = ?`, note, note, id);
    const converted = get('SELECT * FROM reservations WHERE id = ?', id) as Record<string, unknown>;
    notify([{ kind: 'converted', row: converted, by: c.get('user').username }], c.get('user').id);
    return c.json(converted);
  });

  api.post('/reservations/:id/review-cancellation', (c) => {
    const id = int(c.req.param('id'));
    cancelledImport(c.get('user'), id);
    run('UPDATE reservations SET cancel_reviewed = 1 WHERE id = ?', id);
    return c.json(get('SELECT * FROM reservations WHERE id = ?', id));
  });

  api.delete('/reservations/:id', (c) => {
    const row = get('SELECT * FROM reservations WHERE id = ?', int(c.req.param('id'))) as Record<string, unknown> | undefined;
    if (!row || !canSee(c.get('user'), row.unit_id)) return c.json({ error: 'Nie znaleziono' }, 404);
    run('DELETE FROM reservations WHERE id = ?', c.req.param('id'));
    if (row) notify([{ kind: 'deleted', row, by: c.get('user').username }], c.get('user').id);
    return c.json({ ok: true });
  });

  // ---- Ceny (cennik na stronie www) ----
  /** Domki tego samego typu w obiekcie (np. 3 × „Mały domek”) — ceny zawsze wspólne; bez typu = sam domek. */
  const typeMembers = (id: number): number[] => {
    const u = get('SELECT property_id, type_name FROM units WHERE id = ?', id) as { property_id: number; type_name: string } | undefined;
    if (!u || !u.type_name.trim()) return [id];
    return (all(`SELECT id FROM units WHERE property_id = ? AND type_name != '' AND lower(trim(type_name)) = lower(trim(?)) ORDER BY sort, id`, u.property_id, u.type_name) as { id: number }[]).map((x) => x.id);
  };
  const unitIdsIn = (user: User, raw: unknown) => {
    const ids = Array.isArray(raw) ? [...new Set(raw.map(Number).filter(Number.isInteger))] : [];
    if (!ids.length) bad('Wybierz domek');
    for (const id of ids) {
      if (!get('SELECT 1 FROM units WHERE id = ?', id)) bad('Nieznany domek');
      requireUnit(user, id);
    }
    return [...new Set(ids.flatMap(typeMembers))];
  };

  api.get('/rates', (c) => {
    const from = str(c.req.query('from'), 10), to = str(c.req.query('to'), 10);
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) bad('Nieprawidłowe daty');
    return c.json(all(`SELECT unit_id, date, price, min_nights, closed FROM rates WHERE date >= ? AND date < ? ${unitScope(c.get('user'))} ORDER BY date`, from, to));
  });

  // Ustawienie ceny / min. nocy / blokady dla zakresu dni (opcjonalnie tylko wybrane dni tygodnia).
  // price: liczba = nowa cena, null = powrót do ceny podstawowej, undefined = bez zmian (tak samo min_nights i closed).
  api.put('/rates', async (c) => {
    const b = await c.req.json();
    const units = unitIdsIn(c.get('user'), b.unit_ids);
    const from = str(b.from, 10), to = str(b.to, 10);
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) bad('Nieprawidłowy zakres dat');
    if (nightsBetween(from, to) > 731) bad('Maksymalnie 2 lata naraz');
    const weekdays = Array.isArray(b.weekdays) && b.weekdays.length ? new Set(b.weekdays.map(Number)) : null;
    const price = b.price === undefined ? undefined : money(b.price);
    if (price != null && (price < 0 || price > 1_000_000)) bad('Nieprawidłowa cena');
    const minN = b.min_nights === undefined ? undefined : b.min_nights === null || b.min_nights === '' ? null : Math.min(60, Math.max(1, int(b.min_nights)));
    const closed = b.closed === undefined ? undefined : b.closed ? 1 : 0;
    const read = db.prepare('SELECT price, min_nights, closed FROM rates WHERE unit_id = ? AND date = ?');
    const upsert = db.prepare(`INSERT INTO rates (unit_id, date, price, min_nights, closed) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(unit_id, date) DO UPDATE SET price = excluded.price, min_nights = excluded.min_nights, closed = excluded.closed`);
    const drop = db.prepare('DELETE FROM rates WHERE unit_id = ? AND date = ?');
    let changed = 0;
    db.exec('BEGIN');
    try {
      for (const unitId of units) {
        for (let d = from; d <= to; d = addDays(d, 1)) {
          if (weekdays && !weekdays.has(new Date(`${d}T12:00:00Z`).getUTCDay())) continue;
          const cur = read.get(unitId, d) as { price: number | null; min_nights: number | null; closed: number } | undefined;
          const next = {
            price: price === undefined ? cur?.price ?? null : price,
            min_nights: minN === undefined ? cur?.min_nights ?? null : minN,
            closed: closed === undefined ? cur?.closed ?? 0 : closed,
          };
          // Wiersz bez żadnego nadpisania jest zbędny — dzień wraca do ustawień domku
          if (next.price == null && next.min_nights == null && !next.closed) drop.run(unitId, d);
          else upsert.run(unitId, d, next.price, next.min_nights, next.closed);
          changed++;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return c.json({ changed });
  });

  // Cena podstawowa, minimalny pobyt i widoczność domku na stronie (konto ograniczone może zmieniać swoje domki)
  api.put('/rates/unit/:id', async (c) => {
    const id = int(c.req.param('id'));
    if (!get('SELECT 1 FROM units WHERE id = ?', id)) return c.json({ error: 'Nie znaleziono' }, 404);
    requireUnit(c.get('user'), id);
    const b = await c.req.json();
    const price = money(b.base_price);
    if (price != null && (price < 0 || price > 1_000_000)) bad('Nieprawidłowa cena');
    const weekday = b.weekday_prices === undefined ? undefined : parseWeekdayPrices(b.weekday_prices);
    if (weekday?.some((v) => v != null && v > 1_000_000)) bad('Nieprawidłowa cena');
    if (b.type_name !== undefined) assignType(id, str(b.type_name, 60));
    // cennik wspólny dla wszystkich domków typu
    for (const m of typeMembers(id)) {
      run('UPDATE units SET base_price = ?, min_nights = ?, bookable = ? WHERE id = ?', price, Math.min(60, Math.max(1, int(b.min_nights) || 1)), b.bookable === false ? 0 : 1, m);
      if (weekday) run('UPDATE units SET weekday_prices = ? WHERE id = ?', weekday.some((v) => v != null) ? JSON.stringify(weekday) : null, m);
    }
    if (b.type_name_en !== undefined) for (const m of typeMembers(id)) run('UPDATE units SET type_name_en = ? WHERE id = ?', str(b.type_name_en, 60), m);
    return c.json(get('SELECT id, base_price, min_nights, bookable, weekday_prices, type_name, type_name_en FROM units WHERE id = ?', id));
  });

  /**
   * Przypisanie domku do typu (wybór z listy w aplikacji). Dołączając do istniejącego typu domek przejmuje
   * jego nazwę (także angielską), cennik i ceny na konkretne dni — wszystkie domki typu mają zawsze te same ceny.
   */
  const assignType = (id: number, name: string) => {
    const u = get('SELECT property_id FROM units WHERE id = ?', id) as { property_id: number };
    if (!name) { run(`UPDATE units SET type_name = '', type_name_en = '' WHERE id = ?`, id); return; }
    const model = get(`SELECT * FROM units WHERE property_id = ? AND id != ? AND type_name != '' AND lower(trim(type_name)) = lower(trim(?)) ORDER BY sort, id LIMIT 1`, u.property_id, id, name) as
      { id: number; type_name: string; type_name_en: string; base_price: number | null; min_nights: number; bookable: number; weekday_prices: string | null } | undefined;
    if (!model) { run('UPDATE units SET type_name = ? WHERE id = ?', name, id); return; }
    db.exec('BEGIN');
    try {
      run('UPDATE units SET type_name = ?, type_name_en = ?, base_price = ?, min_nights = ?, bookable = ?, weekday_prices = ? WHERE id = ?',
        model.type_name, model.type_name_en, model.base_price, model.min_nights, model.bookable, model.weekday_prices, id);
      const from = warsawToday();
      run('DELETE FROM rates WHERE unit_id = ? AND date >= ?', id, from);
      run('INSERT INTO rates (unit_id, date, price, min_nights, closed) SELECT ?, date, price, min_nights, closed FROM rates WHERE unit_id = ? AND date >= ?', id, model.id, from);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  api.put('/rates/unit/:id/type', async (c) => {
    const id = int(c.req.param('id'));
    if (!get('SELECT 1 FROM units WHERE id = ?', id)) return c.json({ error: 'Nie znaleziono' }, 404);
    requireUnit(c.get('user'), id);
    const b = await c.req.json();
    assignType(id, str(b.type_name, 60));
    return c.json(get('SELECT id, base_price, min_nights, bookable, weekday_prices, type_name, type_name_en FROM units WHERE id = ?', id));
  });
  // Zmiana nazwy typu (PL/EN) dla wszystkich jego domków
  api.put('/rates/type', async (c) => {
    const b = await c.req.json();
    const id = int(b.unit_id);
    if (!get('SELECT 1 FROM units WHERE id = ?', id)) return c.json({ error: 'Nie znaleziono' }, 404);
    requireUnit(c.get('user'), id);
    const members = typeMembers(id);
    const name = str(b.type_name, 60);
    if (!name) bad('Podaj nazwę typu');
    const u = get('SELECT property_id FROM units WHERE id = ?', id) as { property_id: number };
    const clash = get(`SELECT 1 FROM units WHERE property_id = ? AND type_name != '' AND lower(trim(type_name)) = lower(trim(?)) AND id NOT IN (${members.join(',')})`, u.property_id, name);
    if (clash) bad(`Typ „${name}” już istnieje — przypisz domki do niego z listy`);
    for (const m of members) run('UPDATE units SET type_name = ?, type_name_en = ? WHERE id = ?', name, str(b.type_name_en, 60), m);
    return c.json({ ok: true, unit_ids: members });
  });

  // ---- Zamknięcie obiektu (remont, poza sezonem…) — konto ograniczone może zamykać swoje obiekty ----
  api.put('/rates/property/:id/closure', async (c) => {
    const id = int(c.req.param('id'));
    if (!get('SELECT 1 FROM properties WHERE id = ?', id)) return c.json({ error: 'Nie znaleziono' }, 404);
    const user = c.get('user');
    if (user.properties && !user.properties.includes(id)) throw new HTTPException(403, { message: 'Brak dostępu do tego obiektu' });
    const b = await c.req.json();
    const from = b.from ? str(b.from, 10) : null, to = b.to ? str(b.to, 10) : null;
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) bad('Nieprawidłowe daty');
    if (from && to && to < from) bad('Data końca musi być po dacie początku');
    run('UPDATE properties SET closed = ?, closed_from = ?, closed_to = ?, closed_note = ?, closed_note_en = ? WHERE id = ?',
      b.closed ? 1 : 0, from, to, str(b.note, 300), str(b.note_en, 300), id);
    return c.json(get('SELECT id, closed, closed_from, closed_to, closed_note, closed_note_en FROM properties WHERE id = ?', id));
  });

  // ---- Opcje płatne (parking, zwierzę, łóżeczko…) ----
  const readExtra = (b: Record<string, unknown>) => {
    const name = str(b.name, 80);
    if (!name) bad('Podaj nazwę opcji');
    const price = money(b.price);
    if (price == null || price < 0 || price > 100_000) bad('Podaj cenę (0 = bezpłatnie)');
    const scope = b.property_ids == null ? null : readScope(b.property_ids);
    return {
      name, name_en: str(b.name_en, 80), description: str(b.description, 300), price,
      per: b.per === 'night' ? 'night' : 'stay', max_qty: Math.min(20, Math.max(1, int(b.max_qty) || 1)),
      property_ids: scope ? JSON.stringify(scope) : null, active: b.active === false ? 0 : 1,
    };
  };
  api.get('/extras', (c) => c.json(all('SELECT * FROM extras ORDER BY sort, id')));
  api.post('/extras', async (c) => {
    requireFullAdmin(c.get('user'));
    const e = readExtra(await c.req.json());
    const { m } = get('SELECT COALESCE(MAX(sort), 0) + 1 AS m FROM extras') as { m: number };
    const r = run('INSERT INTO extras (name, name_en, description, price, per, max_qty, property_ids, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      e.name, e.name_en, e.description, e.price, e.per, e.max_qty, e.property_ids, e.active, m);
    return c.json(get('SELECT * FROM extras WHERE id = ?', r.lastInsertRowid), 201);
  });
  api.put('/extras/:id', async (c) => {
    requireFullAdmin(c.get('user'));
    const e = readExtra(await c.req.json());
    const r = run('UPDATE extras SET name = ?, name_en = ?, description = ?, price = ?, per = ?, max_qty = ?, property_ids = ?, active = ? WHERE id = ?',
      e.name, e.name_en, e.description, e.price, e.per, e.max_qty, e.property_ids, e.active, int(c.req.param('id')));
    if (!r.changes) return c.json({ error: 'Nie znaleziono' }, 404);
    return c.json(get('SELECT * FROM extras WHERE id = ?', int(c.req.param('id'))));
  });
  api.delete('/extras/:id', (c) => {
    requireFullAdmin(c.get('user'));
    run('DELETE FROM extras WHERE id = ?', int(c.req.param('id')));
    return c.json({ ok: true });
  });

  // Na ile dni do przodu strona pokazuje ceny i przyjmuje zapytania; jak przydzielać domek przy akceptacji
  const ASSIGN_KEY = 'assign_mode';
  const assignMode = () => ((get('SELECT value FROM settings WHERE key = ?', ASSIGN_KEY) as { value: string } | undefined)?.value === 'manual' ? 'manual' : 'auto');
  const bookingSettings = () => ({
    horizon_days: bookingHorizon(db), horizon_until: horizonUntil(db), horizon_last: addDays(horizonEnd(db), -1),
    default_days: DEFAULT_HORIZON, assign_mode: assignMode(),
  });
  const setSetting = (key: string, value: string) => run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  api.get('/settings/booking', (c) => c.json(bookingSettings()));
  api.put('/settings/booking', async (c) => {
    requireFullAdmin(c.get('user'));
    const b = await c.req.json();
    if (b.horizon_days !== undefined) {
      const days = int(b.horizon_days);
      if (days < 7 || days > 730) bad('Podaj liczbę dni od 7 do 730');
      setSetting(HORIZON_KEY, String(days));
      run('DELETE FROM settings WHERE key = ?', HORIZON_UNTIL_KEY);
    }
    if (b.horizon_until !== undefined) {
      const until = str(b.horizon_until, 10);
      if (!until) run('DELETE FROM settings WHERE key = ?', HORIZON_UNTIL_KEY);
      else {
        if (!DATE_RE.test(until) || until < warsawToday()) bad('Wybierz datę w przyszłości');
        if (nightsBetween(warsawToday(), until) > 1100) bad('Maksymalnie 3 lata do przodu');
        setSetting(HORIZON_UNTIL_KEY, until);
      }
    }
    if (b.assign_mode !== undefined) setSetting(ASSIGN_KEY, b.assign_mode === 'manual' ? 'manual' : 'auto');
    return c.json(bookingSettings());
  });

  // ---- Zapytania o rezerwację ze strony www ----
  const requestRow = (id: number) => get(`SELECT r.*, u.name AS unit_name, p.name AS property_name FROM booking_requests r
    JOIN units u ON u.id = r.unit_id JOIN properties p ON p.id = u.property_id WHERE r.id = ?`, id) as (RequestRow & Record<string, unknown>) | undefined;

  // Nierozpatrzone zapytania z minioną datą przyjazdu → archiwum („wygasłe”)
  const expireRequests = () => run(`UPDATE booking_requests SET expired_at = datetime('now')
    WHERE status = 'pending' AND expired_at IS NULL AND check_in < ?`, warsawToday());

  api.get('/requests', (c) => {
    expireRequests();
    const status = c.req.query('status');
    const where = status === 'pending' ? "r.status = 'pending' AND r.expired_at IS NULL"
      : status === 'decided' ? "(r.status != 'pending' OR r.expired_at IS NOT NULL)" : '1';
    const rows = all(`SELECT r.*, u.name AS unit_name, p.name AS property_name FROM booking_requests r
      JOIN units u ON u.id = r.unit_id JOIN properties p ON p.id = u.property_id
      WHERE ${where} ${unitScope(c.get('user')).replace('unit_id', 'r.unit_id')}
      ORDER BY ${status === 'pending' ? 'r.created_at' : 'COALESCE(r.decided_at, r.expired_at, r.created_at) DESC'} LIMIT 200`) as (RequestRow & Record<string, unknown>)[];
    // Czy termin w międzyczasie się zajął (np. rezerwacja z Bookingu) + które domki z typu są wolne do przydziału
    return c.json(rows.map((r) => {
      if (r.status !== 'pending' || r.expired_at) {
        const offer = get('SELECT * FROM offers WHERE request_id = ? ORDER BY id DESC LIMIT 1', r.id) as OfferRow | undefined;
        const res = r.reservation_id ? get('SELECT status FROM reservations WHERE id = ?', r.reservation_id) as { status: string } | undefined : undefined;
        return { ...r, conflicts: [], group_units: [], offer: offer ? { ...publicOffer(offer), expired: offerExpired(offer) } : null, reservation_status: res?.status ?? null };
      }
      const groupUnits = requestGroup(r).map((id) => {
        const u = get('SELECT id, name, type_name FROM units WHERE id = ?', id) as { id: number; name: string; type_name: string } | undefined;
        return u && { ...u, free: !conflicts({ unit_id: id, check_in: r.check_in, check_out: r.check_out, status: 'confirmed' }, 0).length };
      }).filter(Boolean);
      const offer = get('SELECT * FROM offers WHERE request_id = ? ORDER BY id DESC LIMIT 1', r.id) as OfferRow | undefined;
      return {
        ...r, conflicts: conflicts({ ...r, status: 'confirmed' }, 0), group_units: groupUnits, assign_mode: assignMode(),
        offer: offer ? { ...publicOffer(offer), expired: offerExpired(offer) } : null,
      };
    }));
  });

  /** Domki, do których można przydzielić zapytanie (typ domku); najpierw proponowany. */
  const requestGroup = (r: RequestRow): number[] => {
    let ids: number[] = [];
    try { ids = r.group_unit_ids ? JSON.parse(r.group_unit_ids) : []; } catch { ids = []; }
    return [r.unit_id, ...ids.filter((id) => id !== r.unit_id)];
  };

  const pendingRequest = (user: User, id: number) => {
    const r = requestRow(id);
    if (!r || !canSee(user, r.unit_id)) throw new HTTPException(404, { message: 'Nie znaleziono zapytania' });
    if (r.status !== 'pending') bad('To zapytanie zostało już rozpatrzone');
    if (r.check_in < warsawToday()) bad('Termin przyjazdu z tego zapytania już minął — zapytanie jest w archiwum');
    return r;
  };

  /** Zapytanie → rezerwacja w kalendarzu (akceptacja przez admina albo przez gościa z linku w ofercie). */
  const reservationFromRequest = (r: RequestRow, unitId: number, price: number | null,
    o: { by: string; note: string; deposit?: number | null; deposit_due?: string | null; extraNote?: string; currency?: string }) => {
    const chosen = parseChosenExtras(r.extras);
    const notes = [r.message && `Wiadomość od gościa: ${r.message}`, chosen.length && `Opcje dodatkowe: ${extrasLines(chosen).join('; ')}`,
      `Rezerwacja ze strony www (zapytanie #${r.id}).`, o.extraNote].filter(Boolean).join('\n');
    // kod do linku „Poproś o anulację” w e-mailu z potwierdzeniem
    const cancelToken = newToken();
    db.exec('BEGIN');
    try {
      const res = run(`INSERT INTO reservations (unit_id, check_in, check_out, status, source, guest_name, guest_phone, guest_email, adults, children, price, notes, lang, deposit, deposit_due, currency)
        VALUES (?, ?, ?, 'confirmed', 'website', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, unitId, r.check_in, r.check_out, r.guest_name, r.guest_phone, r.guest_email,
        r.adults, r.children, price, notes, readSiteLang(r.lang), o.deposit ?? null, o.deposit_due ?? null, readCurrency(o.currency));
      run(`UPDATE booking_requests SET status = 'accepted', decided_by = ?, decided_at = datetime('now'), decision_note = ?, reservation_id = ?, unit_id = ?,
        cancel_token = ? WHERE id = ?`, o.by, o.note, res.lastInsertRowid, unitId, cancelToken, r.id);
      const created = get('SELECT * FROM reservations WHERE id = ?', res.lastInsertRowid) as Record<string, unknown>;
      db.exec('COMMIT');
      return { created, cancelToken };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  /** Nowa oferta / decyzja unieważnia poprzednie niezaakceptowane oferty */
  const withdrawOffers = (col: 'request_id' | 'reservation_id', id: number) =>
    run(`UPDATE offers SET status = 'withdrawn', decided_at = datetime('now') WHERE ${col} = ? AND status = 'sent'`, id);

  // Podgląd e-maila do gościa przed akceptacją / odrzuceniem (te same dane co w formularzu decyzji)
  api.post('/requests/:id/preview', async (c) => {
    const r = pendingRequest(c.get('user'), int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    const accepted = b.action !== 'reject';
    const note = str(b.note, 3000);
    if (!accepted) return c.json(pick(composeDecision(db, { ...r, decision_note: note }, false, null)));
    const groupIds = requestGroup(r);
    const unitId = b.unit_id && groupIds.includes(int(b.unit_id)) ? int(b.unit_id) : r.unit_id;
    const price = b.price === undefined ? r.quoted_price : money(b.price);
    const deposit = money(b.deposit);
    const depositDue = DATE_RE.test(str(b.deposit_due, 10)) ? str(b.deposit_due, 10) : null;
    const stay = { ...r, unit_id: unitId, deposit, deposit_due: depositDue };
    // kod do linku „Poproś o anulację” powstaje dopiero przy akceptacji — w podglądzie przykładowy
    return c.json(pick(composeDecision(db, { ...r, unit_id: unitId, decision_note: note, cancel_token: '0'.repeat(48) }, true, price, depositRows(db, stay), depositImages(db, stay))));
  });
  const pick = (m: { subject: string; html: string }) => ({ subject: m.subject, html: m.html });

  api.post('/requests/:id/accept', async (c) => {
    const user = c.get('user');
    const r = pendingRequest(user, int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    // Przydział domku: wybrany przez admina albo automatycznie pierwszy wolny z typu (proponowany ma pierwszeństwo)
    const groupIds = requestGroup(r);
    const isFree = (id: number) => !conflicts({ unit_id: id, check_in: r.check_in, check_out: r.check_out, status: 'confirmed' }, 0).length;
    let unitId: number;
    if (b.unit_id !== undefined && b.unit_id !== null && b.unit_id !== '') {
      unitId = int(b.unit_id);
      if (!groupIds.includes(unitId)) bad('Wybierz domek z listy');
    } else {
      if (groupIds.length > 1 && assignMode() === 'manual') bad('Wybierz domek, do którego przydzielić rezerwację');
      unitId = groupIds.find(isFree) ?? r.unit_id;
    }
    const found = conflicts({ unit_id: unitId, check_in: r.check_in, check_out: r.check_out, status: 'confirmed' }, 0);
    if (found.length && !b.force) return c.json({ error: 'Termin nakłada się z inną rezerwacją', conflicts: found }, 409);
    const price = b.price === undefined ? r.quoted_price : money(b.price);
    const note = str(b.note, 3000);
    const deposit = money(b.deposit);
    const depositDue = DATE_RE.test(str(b.deposit_due, 10)) ? str(b.deposit_due, 10) : null;
    const { created, cancelToken } = reservationFromRequest(r, unitId, price, { by: user.username, note, deposit, deposit_due: depositDue });
    withdrawOffers('request_id', r.id);
    notify([{ kind: 'created', row: created, by: user.username }], user.id);
    const stay = { ...r, unit_id: unitId, deposit, deposit_due: depositDue };
    const emailed = b.email === false ? false : await mailDecision(db, mailer, { ...r, unit_id: unitId, decision_note: note, cancel_token: cancelToken }, true, price, depositRows(db, stay), depositImages(db, stay))
      .catch((err) => { console.error('E-mail z potwierdzeniem nie wysłany', err); return false; });
    return c.json({ request: requestRow(r.id), reservation: created, emailed });
  });

  // ---- Prośby o anulację od gości ----
  api.get('/cancellations', (c) => c.json(all(`SELECT r.*, u.name AS unit_name, p.name AS property_name FROM booking_requests r
    JOIN units u ON u.id = r.unit_id JOIN properties p ON p.id = u.property_id
    WHERE r.cancel_status = 'requested' ${unitScope(c.get('user')).replace('unit_id', 'r.unit_id')} ORDER BY r.cancel_requested_at`)));

  const cancelRequested = (user: User, id: number) => {
    const r = requestRow(id);
    if (!r || !canSee(user, r.unit_id)) throw new HTTPException(404, { message: 'Nie znaleziono' });
    if ((r as Record<string, unknown>).cancel_status !== 'requested') bad('Ta prośba o anulację została już rozpatrzona');
    return r;
  };

  api.post('/requests/:id/cancel-confirm', async (c) => {
    const user = c.get('user');
    const r = cancelRequested(user, int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    const note = str(b.note, 3000);
    const before = r.reservation_id ? get('SELECT * FROM reservations WHERE id = ?', r.reservation_id) as Record<string, unknown> | undefined : undefined;
    if (before) {
      const line = `Anulowana na prośbę gościa (${new Date().toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw' })})${r.cancel_reason ? `: ${r.cancel_reason}` : ''}.`;
      run(`UPDATE reservations SET status = 'cancelled', notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END, updated_at = datetime('now') WHERE id = ?`, line, line, before.id as number);
      notify([{ kind: 'updated', before, after: get('SELECT * FROM reservations WHERE id = ?', before.id as number) as Record<string, unknown>, by: user.username }], user.id);
    }
    run(`UPDATE booking_requests SET cancel_status = 'confirmed', cancel_note = ? WHERE id = ?`, note, r.id);
    const emailed = b.email === false ? false : await mailCancelDecision(db, mailer, { ...r, cancel_note: note }, true)
      .catch((err) => { console.error('E-mail o anulacji nie wysłany', err); return false; });
    return c.json({ ok: true, emailed });
  });

  api.post('/requests/:id/cancel-decline', async (c) => {
    const user = c.get('user');
    const r = cancelRequested(user, int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    const note = str(b.note, 3000);
    run(`UPDATE booking_requests SET cancel_status = 'declined', cancel_note = ? WHERE id = ?`, note, r.id);
    const emailed = b.email === false ? false : await mailCancelDecision(db, mailer, { ...r, cancel_note: note }, false)
      .catch((err) => { console.error('E-mail o anulacji nie wysłany', err); return false; });
    return c.json({ ok: true, emailed });
  });

  api.post('/requests/:id/reject', async (c) => {
    const user = c.get('user');
    const r = pendingRequest(user, int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    const note = str(b.note, 3000);
    run(`UPDATE booking_requests SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`, user.username, note, r.id);
    withdrawOffers('request_id', r.id);
    const emailed = b.email === false ? false : await mailDecision(db, mailer, { ...r, decision_note: note }, false, null)
      .catch((err) => { console.error('E-mail z odmową nie wysłany', err); return false; });
    return c.json({ request: requestRow(r.id), emailed });
  });

  // ---- Oferty cenowe (link „Akceptuję” z obowiązkiem zapłaty) ----
  const publicOffer = (o: OfferRow) => ({
    id: o.id, status: o.status, price: o.price, deposit: o.deposit, deposit_due: o.deposit_due, valid_until: o.valid_until, message: o.message,
    currency: o.currency, lang: o.lang, created_by: o.created_by, created_at: o.created_at, decided_at: o.decided_at, decline_reason: o.decline_reason,
    request_id: o.request_id, reservation_id: o.reservation_id, url: offerUrl(o), expired: offerExpired(o),
  });
  const readOffer = (b: Record<string, unknown>, checkIn: string) => {
    const price = money(b.price);
    if (price == null || price <= 0 || price > 10_000_000) bad('Podaj cenę za cały pobyt');
    const deposit = money(b.deposit);
    if (deposit != null && (deposit < 0 || deposit > price)) bad('Zaliczka nie może być większa niż cena');
    const depositDue = str(b.deposit_due, 10);
    if (depositDue && !DATE_RE.test(depositDue)) bad('Nieprawidłowy termin zaliczki');
    let validUntil = str(b.valid_until, 10);
    if (validUntil && !DATE_RE.test(validUntil)) bad('Nieprawidłowa data ważności oferty');
    if (!validUntil) {
      const days = paymentSettings(db).offer_days;
      validUntil = days ? plusDays(warsawToday(), days) : '';
    }
    if (validUntil && validUntil > checkIn) validUntil = checkIn;
    return { price, deposit: deposit || null, deposit_due: deposit ? depositDue || null : null, valid_until: validUntil || null, message: str(b.message, 3000), currency: readCurrency(b.currency) };
  };
  const createOffer = async (user: User, stay: Stay, link: { request_id?: number; reservation_id?: number; unit_id: number }, b: Record<string, unknown>) => {
    const o = readOffer(b, stay.check_in);
    const lang = readSiteLang(stay.lang);
    const sendEmail = b.email !== false;
    if (sendEmail && !isEmail(stay.guest_email)) bad('Brak adresu e-mail gościa — uzupełnij go albo wyślij gościowi link w SMS/WhatsApp');
    if (sendEmail && !mailer) bad('Wysyłka e-maili nie jest skonfigurowana — odznacz e-mail i wyślij gościowi link w SMS/WhatsApp');
    withdrawOffers(link.request_id ? 'request_id' : 'reservation_id', (link.request_id ?? link.reservation_id)!);
    const res = run(`INSERT INTO offers (token, request_id, reservation_id, unit_id, price, deposit, deposit_due, valid_until, message, lang, created_by, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newToken(), link.request_id ?? null, link.reservation_id ?? null, link.unit_id,
      o.price, o.deposit, o.deposit_due, o.valid_until, o.message, lang, user.username, o.currency);
    const offer = get('SELECT * FROM offers WHERE id = ?', res.lastInsertRowid) as OfferRow;
    let emailed = false;
    if (sendEmail && mailer) {
      await sendGuestMessage(db, mailer, { ...stay, price: o.price, deposit: o.deposit, deposit_due: o.deposit_due, currency: o.currency }, {
        kind: 'offer', body: typeof b.body === 'string' ? str(b.body, 3000) : undefined, offerUrl: offerUrl(offer), validUntil: o.valid_until, offerNote: o.message,
      }, { reservation_id: link.reservation_id ?? null, request_id: link.request_id ?? null, sent_by: user.username });
      emailed = true;
    }
    return { offer: publicOffer(offer), emailed };
  };

  api.post('/requests/:id/offers', async (c) => {
    const user = c.get('user');
    const r = pendingRequest(user, int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    const group = requestGroup(r);
    const unitId = b.unit_id ? int(b.unit_id) : r.unit_id;
    if (!group.includes(unitId)) bad('Wybierz domek z listy');
    const lang = (SITE_LANGS as readonly string[]).includes(b.lang) ? b.lang : r.lang;
    return c.json(await createOffer(user, { ...r, unit_id: unitId, lang }, { request_id: r.id, unit_id: unitId }, b), 201);
  });

  const visibleReservation = (user: User, id: number) => {
    const row = get('SELECT * FROM reservations WHERE id = ?', id) as (Stay & Record<string, unknown> & { id: number; status: string }) | undefined;
    if (!row || !canSee(user, row.unit_id)) throw new HTTPException(404, { message: 'Nie znaleziono rezerwacji' });
    return row;
  };

  api.post('/reservations/:id/offers', async (c) => {
    const user = c.get('user');
    const r = visibleReservation(user, int(c.req.param('id')));
    if (r.status === 'cancelled') bad('Rezerwacja jest anulowana');
    const b = await c.req.json().catch(() => ({}));
    if ((SITE_LANGS as readonly string[]).includes(b.lang)) run('UPDATE reservations SET lang = ? WHERE id = ?', b.lang, r.id);
    const stay = { ...r, lang: (SITE_LANGS as readonly string[]).includes(b.lang) ? b.lang : r.lang };
    return c.json(await createOffer(user, stay, { reservation_id: r.id, unit_id: r.unit_id }, b), 201);
  });

  // Podgląd e-maila z ofertą (te same dane co w formularzu; link „Zobacz ofertę” przykładowy — powstaje przy wysyłce)
  const offerPreview = (stay: Stay, b: Record<string, unknown>) => {
    const o = readOffer(b, stay.check_in);
    const lang = readSiteLang(stay.lang);
    const m = composeMessage(db, { ...stay, lang, price: o.price, deposit: o.deposit, deposit_due: o.deposit_due, currency: o.currency }, {
      kind: 'offer', body: typeof b.body === 'string' ? str(b.body, 3000) : undefined,
      offerUrl: offerUrl({ token: '0'.repeat(48), lang }), validUntil: o.valid_until, offerNote: o.message,
    });
    return { subject: m.subject, html: m.html };
  };
  api.post('/requests/:id/offers/preview', async (c) => {
    const r = pendingRequest(c.get('user'), int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    const lang = (SITE_LANGS as readonly string[]).includes(b.lang) ? b.lang : r.lang;
    return c.json(offerPreview({ ...r, unit_id: b.unit_id && requestGroup(r).includes(int(b.unit_id)) ? int(b.unit_id) : r.unit_id, lang }, b));
  });
  api.post('/reservations/:id/offers/preview', async (c) => {
    const r = visibleReservation(c.get('user'), int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    return c.json(offerPreview({ ...r, lang: (SITE_LANGS as readonly string[]).includes(b.lang) ? b.lang : r.lang }, b));
  });

  api.post('/offers/:id/withdraw', (c) => {
    const o = get('SELECT * FROM offers WHERE id = ?', int(c.req.param('id'))) as OfferRow | undefined;
    const unit = o && (o.unit_id ?? (o.request_id ? (get('SELECT unit_id FROM booking_requests WHERE id = ?', o.request_id) as { unit_id: number } | undefined)?.unit_id : undefined));
    if (!o || !canSee(c.get('user'), unit)) return c.json({ error: 'Nie znaleziono oferty' }, 404);
    if (o.status !== 'sent') bad('Tej oferty nie można już wycofać');
    run(`UPDATE offers SET status = 'withdrawn', decided_at = datetime('now') WHERE id = ?`, o.id);
    return c.json(publicOffer(get('SELECT * FROM offers WHERE id = ?', o.id) as OfferRow));
  });

  // ---- Korespondencja z gościem: zaliczka, dopłata, potwierdzenie wpłaty, dowolna wiadomość ----
  const cancelUrlFor = (reservationId: number) => {
    const req = get(`SELECT cancel_token, lang FROM booking_requests WHERE reservation_id = ? AND cancel_token IS NOT NULL ORDER BY id DESC LIMIT 1`, reservationId) as { cancel_token: string; lang: string } | undefined;
    return req ? `${(process.env.SITE_URL || 'https://odmorzadogor.pl').replace(/\/$/, '')}${sitePath(req.lang, 'cancel')}?t=${req.cancel_token}` : null;
  };
  const readKind = (v: unknown) => (MESSAGE_KINDS.includes(v as MessageKind) && v !== 'invoice' ? v as MessageKind : bad('Wybierz rodzaj wiadomości'));
  const messageInput = (b: Record<string, unknown>, kind: MessageKind, reservationId: number) => ({
    kind, subject: str(b.subject, 200) || undefined, body: typeof b.body === 'string' ? str(b.body, 5000) : undefined,
    amount: b.amount === undefined ? undefined : money(b.amount), due: b.due === undefined ? undefined : (DATE_RE.test(str(b.due, 10)) ? str(b.due, 10) : null),
    title: str(b.title, 140) || undefined, cancelUrl: kind === 'confirmation' ? cancelUrlFor(reservationId) : null,
  });

  api.get('/reservations/:id/activity', (c) => {
    const r = visibleReservation(c.get('user'), int(c.req.param('id')));
    const reqIds = (all('SELECT id FROM booking_requests WHERE reservation_id = ?', r.id) as { id: number }[]).map((x) => x.id);
    const reqList = reqIds.join(',') || 'NULL';
    return c.json({
      offers: (all(`SELECT * FROM offers WHERE reservation_id = ? OR request_id IN (${reqList}) ORDER BY id DESC`, r.id) as OfferRow[]).map(publicOffer),
      messages: all(`SELECT id, kind, to_email, subject, body, sent_by, sent_at FROM guest_messages WHERE reservation_id = ? OR request_id IN (${reqList}) ORDER BY sent_at DESC, id DESC`, r.id),
      invoices: all('SELECT id, number, issue_date, total, currency FROM invoices WHERE reservation_id = ? ORDER BY id DESC', r.id),
      email_configured: !!mailer,
    });
  });

  api.get('/reservations/:id/messages/draft', (c) => {
    const r = visibleReservation(c.get('user'), int(c.req.param('id')));
    const kind = readKind(c.req.query('kind'));
    const lang = c.req.query('lang');
    const stay = { ...r, lang: (SITE_LANGS as readonly string[]).includes(lang ?? '') ? lang : r.lang };
    const amount = c.req.query('amount'), due = c.req.query('due');
    const ps = paymentSettings(db);
    return c.json({
      ...draftMessage(db, stay, kind, amount === undefined ? undefined : money(amount), due === undefined ? undefined : (DATE_RE.test(due) ? due : null)),
      has_account: !!accountFor(ps, readCurrency(r.currency)) || !!revolutLink(ps), default_deposit: defaultDeposit(ps, r.price as number | null, r.check_in),
    });
  });

  api.post('/reservations/:id/messages/preview', async (c) => {
    const r = visibleReservation(c.get('user'), int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    const kind = readKind(b.kind);
    const stay = { ...r, lang: (SITE_LANGS as readonly string[]).includes(b.lang) ? b.lang : r.lang };
    const m = composeMessage(db, stay, messageInput(b, kind, r.id));
    return c.json({ subject: m.subject, html: m.html });
  });

  api.post('/reservations/:id/messages', async (c) => {
    const user = c.get('user');
    const r = visibleReservation(user, int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    const kind = readKind(b.kind);
    if (!mailer) bad('Wysyłka e-maili nie jest skonfigurowana na serwerze (RESEND_API_KEY albo SMTP_HOST w .env)');
    if (!isEmail(r.guest_email)) bad('Brak adresu e-mail gościa — uzupełnij go w rezerwacji');
    if (kind === 'custom' && !str(b.body)) bad('Wpisz treść wiadomości');
    if (kind === 'unpaid_cancel') bad('Użyj przycisku „Anuluj — brak zaliczki”');
    const lang = (SITE_LANGS as readonly string[]).includes(b.lang) ? b.lang : r.lang;
    if (lang !== r.lang) run('UPDATE reservations SET lang = ? WHERE id = ?', lang, r.id);
    const input = messageInput(b, kind, r.id);
    // prośba o zaliczkę zapisuje kwotę i termin w rezerwacji
    if (kind === 'deposit' && input.amount != null) run('UPDATE reservations SET deposit = ?, deposit_due = ?, updated_at = datetime(\'now\') WHERE id = ?', input.amount, input.due ?? null, r.id);
    const stay = { ...(get('SELECT * FROM reservations WHERE id = ?', r.id) as unknown as Stay) };
    try {
      await sendGuestMessage(db, mailer!, stay, input, { reservation_id: r.id, sent_by: user.username });
    } catch (err) {
      console.error('Wiadomość do gościa nie wysłana', err);
      return c.json({ error: `Nie udało się wysłać: ${err instanceof Error ? err.message : err}` }, 502);
    }
    return c.json({ ok: true, reservation: get('SELECT * FROM reservations WHERE id = ?', r.id) });
  });

  // ---- Anulacja z powodu niewpłaconej zaliczki (opcjonalnie e-mail do gościa) ----
  api.post('/reservations/:id/cancel-unpaid', async (c) => {
    const user = c.get('user');
    const r = visibleReservation(user, int(c.req.param('id')));
    if (r.status === 'cancelled') bad('Rezerwacja jest już anulowana');
    const b = await c.req.json().catch(() => ({}));
    const sendEmail = b.email !== false;
    if (sendEmail && !mailer) bad('Wysyłka e-maili nie jest skonfigurowana — odznacz e-mail');
    if (sendEmail && !isEmail(r.guest_email)) bad('Brak adresu e-mail gościa — odznacz e-mail');
    const line = `Anulowana — brak wpłaty zaliczki (${new Date().toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw' })}, ${user.username}).`;
    run(`UPDATE reservations SET status = 'cancelled', notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END, updated_at = datetime('now') WHERE id = ?`, line, line, r.id);
    withdrawOffers('reservation_id', r.id);
    const after = get('SELECT * FROM reservations WHERE id = ?', r.id) as Record<string, unknown>;
    notify([{ kind: 'updated', before: r as Record<string, unknown>, after, by: user.username }], user.id);
    let emailed = false;
    if (sendEmail) {
      try {
        await sendGuestMessage(db, mailer!, r, { kind: 'unpaid_cancel', subject: str(b.subject, 200) || undefined, body: typeof b.body === 'string' ? str(b.body, 5000) : undefined },
          { reservation_id: r.id, sent_by: user.username });
        emailed = true;
      } catch (err) {
        console.error('E-mail o anulacji nie wysłany', err);
        return c.json({ error: `Rezerwacja anulowana, ale e-mail się nie wysłał: ${err instanceof Error ? err.message : err}`, reservation: after }, 502);
      }
    }
    return c.json({ ok: true, emailed, reservation: after });
  });

  // ---- Ustawienia płatności (konto, zaliczka, warunki) ----
  api.get('/settings/payments', (c) => c.json(paymentSettings(db)));
  api.put('/settings/payments', async (c) => {
    requireFullAdmin(c.get('user'));
    const ps = readPaymentSettings(await c.req.json());
    setSetting(PAYMENT_SETTINGS_KEY, JSON.stringify(ps));
    return c.json(ps);
  });

  // ---- Rachunki ----
  const invoiceTemplate = () => {
    const t = invoiceSettings(db);
    const ps = paymentSettings(db);
    return { ...t, account: t.account || ps.account_number, bank: t.bank || ps.bank_name, auto_footer: autoFooter(t) };
  };
  api.get('/settings/invoice', (c) => c.json(invoiceTemplate()));
  api.put('/settings/invoice', async (c) => {
    const t = readInvoiceSettings(await c.req.json());
    setSetting(INVOICE_SETTINGS_KEY, JSON.stringify(t));
    return c.json(invoiceTemplate());
  });

  const invoiceRow = (user: User, id: number) => {
    const row = get('SELECT * FROM invoices WHERE id = ?', id) as InvoiceRow | undefined;
    if (!row) throw new HTTPException(404, { message: 'Nie znaleziono rachunku' });
    const res = row.reservation_id ? get('SELECT unit_id FROM reservations WHERE id = ?', row.reservation_id) as { unit_id: number } | undefined : undefined;
    if (res ? !canSee(user, res.unit_id) : !isFullAdmin(user)) throw new HTTPException(404, { message: 'Nie znaleziono rachunku' });
    return row;
  };
  const readInvoice = (b: Record<string, unknown>): InvoiceData => {
    const issue = str(b.issue_date, 10);
    const sale = str(b.sale_date, 10), due = str(b.payment_due, 10);
    const seller = (b.seller && typeof b.seller === 'object' ? b.seller : {}) as Record<string, unknown>;
    return {
      number: str(b.number, 40), issue_date: DATE_RE.test(issue) ? issue : warsawToday(), sale_date: DATE_RE.test(sale) ? sale : '', place: str(b.place, 120),
      seller: { ...readParty(seller), account: str(seller.account, 60), bank: str(seller.bank, 120) }, buyer: readParty(b.buyer), items: readItems(b.items),
      payment_method: str(b.payment_method, 60), payment_due: DATE_RE.test(due) ? due : '', paid: money(b.paid), note: str(b.note, 1000), footer: str(b.footer, 300),
      signatures: b.signatures !== false, seller_signature: readSignature(b.seller_signature), buyer_signature: readSignature(b.buyer_signature),
      currency: readCurrency(b.currency),
    };
  };
  const invoiceOut = (row: InvoiceRow) => {
    const guest = row.reservation_id
      ? get('SELECT guest_name AS name, guest_email AS email, guest_phone AS phone, lang FROM reservations WHERE id = ?', row.reservation_id) as { name: string; email: string; phone: string; lang: string } | undefined
      : undefined;
    return {
      id: row.id, reservation_id: row.reservation_id, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at, total: row.total, ...invoiceData(row),
      share_url: invoiceShareUrl(row.id, row.number), guest: guest ?? null,
    };
  };
  const pdfResponse = (c: { body: (b: Uint8Array, s: 200, h: Record<string, string>) => Response }, pdf: Buffer, number: string, download: boolean) =>
    c.body(new Uint8Array(pdf), 200, {
      'Content-Type': 'application/pdf', 'Cache-Control': 'no-store',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${invoiceFileName(number)}"`,
    });
  /** Kod QR do zapłaty pozostałej kwoty na rachunku (PLN — ZBP, EUR — EPC), jeśli włączone w ustawieniach */
  const invoicePdf = async (inv: InvoiceData) => {
    const ps = paymentSettings(db);
    const due = Math.round((itemsTotal(inv.items) - (inv.paid ?? 0)) * 100) / 100;
    let qr: Buffer | undefined;
    if (ps.show_qr && due > 0 && inv.seller.account && /przelew/i.test(inv.payment_method || 'przelew')) {
      const title = `Rachunek ${inv.number}`.trim();
      const payload = inv.currency === 'PLN' ? plBankPayload({ account: inv.seller.account, amount: due, name: inv.seller.name, title })
        : inv.currency === 'EUR' ? epcPayload({ account: inv.seller.account, amount: due, name: inv.seller.name, text: title, bic: (inv.seller.bank.match(/BIC\/SWIFT (\S+)/) ?? [])[1] }) : null;
      if (payload) qr = await qrPng(payload, 300);
    }
    return renderInvoicePdf(inv, { qr });
  };

  /** Zapamiętanie danych z rachunku jako szablonu na następny raz */
  const saveInvoiceTemplate = (inv: InvoiceData) => {
    const cur = invoiceSettings(db);
    const days = inv.payment_due && inv.issue_date ? Math.round((Date.parse(inv.payment_due) - Date.parse(inv.issue_date)) / 86_400_000) : null;
    const { account, bank, ...party } = inv.seller;
    setSetting(INVOICE_SETTINGS_KEY, JSON.stringify(readInvoiceSettings({
      ...cur, ...party, account, bank, place: inv.place, note: inv.note, footer: inv.footer, payment_method: inv.payment_method,
      signatures: inv.signatures, seller_signature: inv.seller_signature,
      payment_days: days != null && days >= 0 ? days : cur.payment_days,
    })));
  };

  api.get('/invoices', (c) => {
    const user = c.get('user');
    const resId = c.req.query('reservation_id');
    const rows = all(`SELECT i.id, i.number, i.issue_date, i.total, i.currency, i.buyer, i.reservation_id, r.unit_id, r.check_in, r.check_out FROM invoices i
      LEFT JOIN reservations r ON r.id = i.reservation_id ${resId ? 'WHERE i.reservation_id = ?' : ''} ORDER BY i.issue_date DESC, i.id DESC LIMIT 500`, ...(resId ? [int(resId)] : [])) as
      { id: number; number: string; issue_date: string; total: number; currency: string; buyer: string; reservation_id: number | null; unit_id: number | null; check_in: string | null; check_out: string | null }[];
    return c.json(rows.filter((r) => (r.unit_id ? canSee(user, r.unit_id) : isFullAdmin(user))).map(({ buyer, ...r }) => {
      let name = '';
      try { name = (JSON.parse(buyer) as { name?: string }).name ?? ''; } catch { name = ''; }
      return { ...r, buyer_name: name };
    }));
  });

  api.get('/invoices/draft', (c) => {
    const t = invoiceTemplate();
    const today = warsawToday();
    const resId = int(c.req.query('reservation_id'));
    const r = resId ? visibleReservation(c.get('user'), resId) : undefined;
    if (!r && !isFullAdmin(c.get('user'))) bad('Wybierz rezerwację');
    const u = r ? get(`SELECT u.name, u.type_name, p.name AS property FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ?`, r.unit_id) as { name: string; type_name: string; property: string } : undefined;
    const nightsCount = r ? nightsBetween(r.check_in, r.check_out) : 0;
    const currency = readCurrency(c.req.query('currency') ?? r?.currency);
    // konto: z szablonu dla PLN, konto walutowe z ustawień płatności dla EUR, GBP…
    const foreign = currency !== 'PLN' ? accountFor(paymentSettings(db), currency) : null;
    const account = currency === 'PLN' ? { account: t.account, bank: t.bank } : { account: foreign?.account_number ?? '', bank: [foreign?.bank_name, foreign?.bic && `BIC/SWIFT ${foreign.bic}`].filter(Boolean).join(', ') };
    const draft: InvoiceData = {
      number: nextInvoiceNumber(db, today, t.numbering), issue_date: today, sale_date: r ? r.check_out : today, place: t.place,
      seller: { name: t.name, address: t.address, city: t.city, nip: t.nip, phone: t.phone, email: t.email, account: t.show_account ? account.account : '', bank: t.show_account ? account.bank : '' },
      buyer: { name: r?.guest_name ?? '', address: '', city: '', nip: '', phone: '', email: '' },
      items: r ? [{
        name: `Usługa noclegowa — ${u?.type_name || u?.name} (${u?.property}), ${dateRange(r.check_in, r.check_out)}, ${nightsCount} ${nightsCount === 1 ? 'noc' : nightsCount % 10 >= 2 && nightsCount % 10 <= 4 && (nightsCount % 100 < 12 || nightsCount % 100 > 14) ? 'noce' : 'nocy'}`,
        qty: 1, unit: 'usł.', price: (r.price as number | null) ?? 0,
      }] : [{ name: '', qty: 1, unit: 'usł.', price: 0 }],
      payment_method: t.payment_method, payment_due: t.payment_days != null ? plusDays(today, t.payment_days) : '', paid: r ? (r.paid as number | null) : null,
      note: t.note, footer: t.footer ?? t.auto_footer,
      signatures: t.signatures, seller_signature: t.seller_signature, buyer_signature: '', currency,
    };
    return c.json({ ...draft, reservation_id: r?.id ?? null });
  });

  api.post('/invoices/preview', async (c) => {
    const inv = readInvoice(await c.req.json().catch(() => ({})));
    if (!inv.number) inv.number = nextInvoiceNumber(db, inv.issue_date, invoiceSettings(db).numbering);
    return pdfResponse(c, await invoicePdf(inv), inv.number, false);
  });

  const writeInvoice = async (c: { get: (k: 'user') => User; req: { json: () => Promise<unknown> } }, existing?: InvoiceRow) => {
    const user = c.get('user');
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const inv = readInvoice(b);
    const resId = existing ? existing.reservation_id : (b.reservation_id ? int(b.reservation_id) : null);
    if (resId && !existing) visibleReservation(user, resId);
    if (!resId && !isFullAdmin(user)) bad('Wybierz rezerwację');
    if (!inv.number) inv.number = nextInvoiceNumber(db, inv.issue_date, invoiceSettings(db).numbering);
    if (get('SELECT 1 FROM invoices WHERE number = ? AND id != ?', inv.number, existing?.id ?? 0)) bad(`Rachunek nr ${inv.number} już istnieje — zmień numer`);
    const vals = [inv.number, inv.issue_date, inv.sale_date, inv.place, JSON.stringify(inv.seller), JSON.stringify(inv.buyer), JSON.stringify(inv.items),
      itemsTotal(inv.items), inv.payment_method, inv.payment_due, inv.paid, inv.note, inv.footer, inv.signatures ? 1 : 0, inv.seller_signature, inv.buyer_signature, inv.currency];
    let id: number;
    if (existing) {
      run(`UPDATE invoices SET number = ?, issue_date = ?, sale_date = ?, place = ?, seller = ?, buyer = ?, items = ?, total = ?, payment_method = ?, payment_due = ?,
        paid = ?, note = ?, footer = ?, signatures = ?, seller_signature = ?, buyer_signature = ?, currency = ?, updated_at = datetime('now') WHERE id = ?`, ...vals, existing.id);
      id = existing.id;
    } else {
      id = Number(run(`INSERT INTO invoices (number, issue_date, sale_date, place, seller, buyer, items, total, payment_method, payment_due, paid, note, footer,
        signatures, seller_signature, buyer_signature, currency, reservation_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...vals, resId, user.username).lastInsertRowid);
    }
    if (b.save_template !== false) saveInvoiceTemplate(inv);
    return invoiceOut(get('SELECT * FROM invoices WHERE id = ?', id) as InvoiceRow);
  };
  api.post('/invoices', async (c) => c.json(await writeInvoice(c), 201));
  api.get('/invoices/:id{[0-9]+}', (c) => c.json(invoiceOut(invoiceRow(c.get('user'), int(c.req.param('id'))))));
  api.put('/invoices/:id{[0-9]+}', async (c) => c.json(await writeInvoice(c, invoiceRow(c.get('user'), int(c.req.param('id'))))));
  api.delete('/invoices/:id{[0-9]+}', (c) => {
    const row = invoiceRow(c.get('user'), int(c.req.param('id')));
    run('DELETE FROM invoices WHERE id = ?', row.id);
    return c.json({ ok: true });
  });
  api.get('/invoices/:id{[0-9]+}/pdf', async (c) => {
    const row = invoiceRow(c.get('user'), int(c.req.param('id')));
    return pdfResponse(c, await invoicePdf(invoiceData(row)), row.number, c.req.query('download') === '1');
  });
  api.post('/invoices/:id{[0-9]+}/send', async (c) => {
    const user = c.get('user');
    const row = invoiceRow(user, int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    if (!mailer) bad('Wysyłka e-maili nie jest skonfigurowana na serwerze');
    if (!row.reservation_id) bad('Rachunek nie jest przypisany do rezerwacji');
    const r = visibleReservation(user, row.reservation_id);
    const to = str(b.to, 200) || r.guest_email;
    if (!isEmail(to)) bad('Podaj adres e-mail gościa');
    const pdf = await invoicePdf(invoiceData(row));
    try {
      await sendGuestMessage(db, mailer!, { ...r, guest_email: to }, {
        kind: 'invoice', subject: str(b.subject, 200) || undefined, body: typeof b.body === 'string' ? str(b.body, 3000) : undefined,
      }, { reservation_id: r.id, sent_by: user.username }, [{ filename: invoiceFileName(row.number), content: pdf, contentType: 'application/pdf' }]);
    } catch (err) {
      console.error('Rachunek nie wysłany', err);
      return c.json({ error: `Nie udało się wysłać: ${err instanceof Error ? err.message : err}` }, 502);
    }
    return c.json({ ok: true, to });
  });

  // ---- Poczta (tylko administrator z dostępem do wszystkich obiektów) ----
  const mailSettings = () => {
    const mode = (get('SELECT value FROM settings WHERE key = ?', REPLY_TO_KEY) as { value: string } | undefined)?.value ?? 'auto';
    return {
      mailboxes: mailboxes(db), reply_to: mode, last_inbound: lastInbound(db), sending: !!mailer,
      unread: (get('SELECT COALESCE(SUM(unread), 0) AS n FROM mail_threads WHERE archived = 0') as { n: number }).n,
    };
  };
  api.get('/mail/summary', (c) => {
    if (!isFullAdmin(c.get('user'))) return c.json({ ...mailSettings(), mailboxes: [], unread: 0, allowed: false });
    return c.json({ ...mailSettings(), allowed: true });
  });
  api.put('/mail/settings', async (c) => {
    requireFullAdmin(c.get('user'));
    const b = await c.req.json();
    if (Array.isArray(b.mailboxes)) {
      const list = [...new Set((b.mailboxes as unknown[]).map((x) => addrOf(String(x))).filter((x) => isEmail(x)))].slice(0, 10);
      if (!list.length) bad('Podaj co najmniej jeden adres skrzynki');
      setSetting(MAILBOXES_KEY, JSON.stringify(list));
    }
    if (b.reply_to !== undefined) setSetting(REPLY_TO_KEY, ['inbox', 'admin', 'auto'].includes(b.reply_to) ? b.reply_to : 'auto');
    return c.json({ ...mailSettings(), allowed: true });
  });

  api.get('/mail/threads', (c) => {
    requireFullAdmin(c.get('user'));
    const box = addrOf(str(c.req.query('mailbox'), 200));
    const q = str(c.req.query('q'), 100);
    const archived = c.req.query('archived') === '1' ? 1 : 0;
    const where = ['t.archived = ?'], params: SQLInputValue[] = [archived];
    if (box) { where.push('t.mailbox = ?'); params.push(box); }
    if (q) {
      where.push(`(t.subject LIKE ? OR t.counterpart LIKE ? OR t.counterpart_name LIKE ? OR EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id AND m.text LIKE ?))`);
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    return c.json(all(`SELECT t.* FROM mail_threads t WHERE ${where.join(' AND ')} ORDER BY t.last_at DESC LIMIT 200`, ...params));
  });

  const mailThread = (id: number) => {
    const t = get('SELECT * FROM mail_threads WHERE id = ?', id) as Record<string, unknown> | undefined;
    if (!t) throw new HTTPException(404, { message: 'Nie znaleziono wiadomości' });
    return t;
  };
  api.get('/mail/threads/:id{[0-9]+}', (c) => {
    requireFullAdmin(c.get('user'));
    const t = mailThread(int(c.req.param('id')));
    const messages = (all('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY created_at, id', t.id as number) as Record<string, unknown>[]).map((m) => ({
      ...m, to_addrs: JSON.parse(String(m.to_addrs || '[]')), cc_addrs: JSON.parse(String(m.cc_addrs || '[]')),
      attachments: all('SELECT id, filename, content_type, size, content_id FROM mail_attachments WHERE message_id = ?', m.id as number),
    }));
    if (c.req.query('keep') !== '1') {
      run('UPDATE mail_messages SET is_read = 1 WHERE thread_id = ?', t.id as number);
      run('UPDATE mail_threads SET unread = 0 WHERE id = ?', t.id as number);
    }
    // rezerwacje i zapytania tej osoby (po adresie e-mail)
    const who = String(t.counterpart);
    const reservations = who ? all(`SELECT r.id, r.check_in, r.check_out, r.status, r.guest_name, u.name AS unit_name, p.name AS property_name FROM reservations r
      JOIN units u ON u.id = r.unit_id JOIN properties p ON p.id = u.property_id WHERE lower(r.guest_email) = ? ORDER BY r.check_in DESC LIMIT 10`, who) : [];
    const requests = who ? all(`SELECT id, check_in, check_out, status, created_at FROM booking_requests WHERE lower(guest_email) = ? ORDER BY created_at DESC LIMIT 10`, who) : [];
    return c.json({ thread: { ...t, unread: c.req.query('keep') === '1' ? t.unread : 0 }, messages, reservations, requests });
  });
  api.post('/mail/threads/:id{[0-9]+}/state', async (c) => {
    requireFullAdmin(c.get('user'));
    const t = mailThread(int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    if (b.archived !== undefined) run('UPDATE mail_threads SET archived = ? WHERE id = ?', b.archived ? 1 : 0, t.id as number);
    if (b.read !== undefined) {
      run('UPDATE mail_messages SET is_read = ? WHERE thread_id = ? AND direction = ?', b.read ? 1 : 0, t.id as number, 'in');
      run(`UPDATE mail_threads SET unread = ? WHERE id = ?`, b.read ? 0 : Math.max(1, (get(`SELECT COUNT(*) AS n FROM mail_messages WHERE thread_id = ? AND direction = 'in'`, t.id as number) as { n: number }).n ? 1 : 0), t.id as number);
    }
    return c.json(mailThread(t.id as number));
  });
  api.delete('/mail/threads/:id{[0-9]+}', (c) => {
    requireFullAdmin(c.get('user'));
    run('DELETE FROM mail_threads WHERE id = ?', mailThread(int(c.req.param('id'))).id as number);
    return c.json({ ok: true });
  });
  api.get('/mail/attachments/:id{[0-9]+}', (c) => {
    requireFullAdmin(c.get('user'));
    const a = get('SELECT filename, content_type, data FROM mail_attachments WHERE id = ?', int(c.req.param('id'))) as { filename: string; content_type: string; data: Uint8Array } | undefined;
    if (!a) return c.json({ error: 'Nie znaleziono załącznika' }, 404);
    const safeType = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/i.test(a.content_type) ? a.content_type : 'application/octet-stream';
    return c.body(new Uint8Array(a.data), 200, {
      'Content-Type': safeType, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${c.req.query('download') === '1' || safeType === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    });
  });

  // Wysyłka z Poczty: nowa wiadomość albo odpowiedź w rozmowie (z cytatem i nagłówkami wątku)
  api.post('/mail/send', async (c) => {
    const user = c.get('user');
    requireFullAdmin(user);
    if (!mailer) bad('Wysyłka e-maili nie jest skonfigurowana na serwerze (RESEND_API_KEY albo SMTP_HOST w .env)');
    const b = await c.req.json().catch(() => ({}));
    const from = addrOf(str(b.from, 200));
    if (!mailboxes(db).includes(from)) bad('Wybierz adres nadawcy z listy skrzynek');
    const to = parseEmails(str(b.to, 1000));
    const cc = parseEmails(str(b.cc, 1000));
    if (!to.length) bad('Podaj adres odbiorcy');
    const text = str(b.text, 50_000);
    if (!text) bad('Wpisz treść wiadomości');
    let subject = str(b.subject, 300);
    const headers: Record<string, string> = {};
    let quote: { header: string; text: string } | undefined;
    if (b.thread_id) {
      const t = mailThread(int(b.thread_id));
      const last = get(`SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, t.id as number) as Record<string, string> | undefined;
      if (last) {
        if (last.message_id) {
          headers['In-Reply-To'] = last.message_id;
          headers.References = [last.refs, last.message_id].filter(Boolean).join(' ').trim();
        }
        if (!subject) subject = /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`;
        if (b.quote !== false && last.text) {
          const when = new Date(`${String(last.date).replace(' ', 'T')}Z`).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'medium', timeStyle: 'short' });
          quote = { header: `${when}, ${last.from_name || last.from_addr} napisał(a):`, text: String(last.text).slice(0, 5000) };
        }
      }
    }
    if (!subject) bad('Wpisz temat');
    const fullText = quote ? `${text}\n\n${quote.header}\n${quote.text.split('\n').map((l) => `> ${l}`).join('\n')}` : text;
    try {
      await mailer!.send({ from: fromHeader(from), to, cc, subject, text: fullText, html: replyHtml(text, quote), headers, sentBy: user.username });
    } catch (err) {
      console.error('Wiadomość nie wysłana', err);
      return c.json({ error: `Nie udało się wysłać: ${err instanceof Error ? err.message : err}` }, 502);
    }
    const sent = get(`SELECT thread_id FROM mail_messages WHERE direction = 'out' ORDER BY id DESC LIMIT 1`) as { thread_id: number } | undefined;
    return c.json({ ok: true, thread_id: sent?.thread_id ?? null });
  });

  // ---- Powiadomienia e-mail (adresy właściciela) ----
  api.get('/settings/email', (c) => {
    requireFullAdmin(c.get('user'));
    return c.json({ configured: !!mailer, kind: mailer?.kind ?? null, from: mailer?.from ?? null, emails: adminEmails(db).join(', '), notify: emailNotify(db) });
  });

  api.put('/settings/email', async (c) => {
    requireFullAdmin(c.get('user'));
    const b = await c.req.json();
    if (b.emails !== undefined) {
      const raw = str(b.emails, 1000);
      const emails = parseEmails(raw);
      if (raw && !emails.length) bad('Podaj poprawny adres e-mail');
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', NOTIFY_EMAILS_KEY, emails.join(', '));
    }
    if (b.notify && typeof b.notify === 'object') {
      const cur = emailNotify(db);
      const n = b.notify as Record<string, unknown>;
      const next = Object.fromEntries((Object.keys(cur) as (keyof typeof cur)[]).map((k) => [k, typeof n[k] === 'boolean' ? n[k] : cur[k]]));
      setSetting(EMAIL_NOTIFY_KEY, JSON.stringify(next));
    }
    return c.json({ configured: !!mailer, kind: mailer?.kind ?? null, from: mailer?.from ?? null, emails: adminEmails(db).join(', '), notify: emailNotify(db) });
  });

  api.post('/settings/email/test', async (c) => {
    requireFullAdmin(c.get('user'));
    if (!mailer) return c.json({ error: 'Wysyłka e-maili nie jest skonfigurowana na serwerze (RESEND_API_KEY albo SMTP_HOST w .env)' }, 503);
    const to = adminEmails(db);
    if (!to.length) bad('Najpierw zapisz adres e-mail');
    try {
      await mailTest(mailer, to);
    } catch (err) {
      console.error('Test e-mail nie powiódł się', err);
      return c.json({ error: `Nie udało się wysłać: ${err instanceof Error ? err.message : err}` }, 502);
    }
    return c.json({ sent: to.length });
  });

  app.route('/api', api);
  return app;
}
