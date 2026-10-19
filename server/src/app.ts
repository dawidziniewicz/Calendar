import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';
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
  DEFAULT_HORIZON, HORIZON_KEY, chooseUnit, propertyClosure, unitGroup, extrasFor, extrasLines, parseChosenExtras, priceExtras, NOTIFY_EMAILS_KEY, addDays, adminEmails, bookingHorizon, horizonEnd, parseWeekdayPrices, announceRequest, mailDecision, mailTest, nights, nightsBetween, quote, unitPricing, type RequestRow,
} from './booking.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['confirmed', 'tentative', 'cancelled'];

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

export function createApp(db: DatabaseSync, apiKey: string, pushSender?: Sender, mailer?: Mailer) {
  const app = new Hono();
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
          return { id, name: u.name, type_name: u.type_name, capacity: u.capacity, base_price: u.base_price, min_nights: u.min_nights, price_from: prices.length ? Math.min(...prices) : null };
        });
        // Typy: domki z tym samym typem pokazujemy jako jedną opcję („Mały domek · 3 domki”), pozostałe osobno
        const types: { key: string; name: string; unit_ids: number[]; count: number; capacity: number; min_nights: number; price_from: number | null }[] = [];
        for (const u of list) {
          const key = u.type_name ? `t:${u.type_name.toLowerCase()}` : `u:${u.id}`;
          const t = types.find((x) => x.key === key);
          if (!t) types.push({ key, name: u.type_name || u.name, unit_ids: [u.id], count: 1, capacity: u.capacity, min_nights: u.min_nights, price_from: u.price_from });
          else {
            t.unit_ids.push(u.id);
            t.count++;
            t.capacity = Math.min(t.capacity, u.capacity);
            t.min_nights = Math.min(t.min_nights, u.min_nights);
            t.price_from = [t.price_from, u.price_from].filter((v): v is number => v != null).reduce((a, b) => Math.min(a, b), Infinity);
            if (t.price_from === Infinity) t.price_from = null;
          }
        }
        return { units: list.map(({ type_name: _, ...u }) => u), types };
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
    return c.json(quote(db, unit, checkIn, checkOut, c.req.query('lang') === 'en' ? 'en' : 'pl'));
  });

  pub.post('/requests', async (c) => {
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    // Pole-pułapka: ludzie go nie widzą, boty wypełniają → udajemy sukces
    if (str(b.website)) return c.json({ ok: true, id: 0 }, 201);
    const ip = c.req.header('x-client-ip') || 'unknown';
    if (!allowHit(`ip:${ip}`, PUBLIC_LIMIT_PER_IP) || !allowHit('total', PUBLIC_LIMIT_TOTAL)) {
      return c.json({ error: b.lang === 'en' ? 'Too many requests. Please try again later or call +48 510 248 693.' : 'Za dużo zapytań. Spróbuj za jakiś czas albo zadzwoń: +48 510 248 693.' }, 429);
    }
    const en = b.lang === 'en';
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
    if (r.guest_name.length < 2) bad(t('Podaj imię i nazwisko', 'Please enter your full name'));
    if (!isEmail(r.guest_email)) bad(t('Podaj poprawny adres e-mail', 'Please enter a valid e-mail address'));
    if (r.guest_phone && !/^[+\d][\d\s()-]{6,}$/.test(r.guest_phone)) bad(t('Podaj poprawny numer telefonu', 'Please enter a valid phone number'));
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
      r.adults, r.children, r.message, total, ip.slice(0, 64), b.lang === 'en' ? 'en' : 'pl', extras.length ? JSON.stringify(extras) : null,
      group.length > 1 ? JSON.stringify(fits.map((u) => u.id)) : null);
    const row = get('SELECT * FROM booking_requests WHERE id = ?', res.lastInsertRowid) as RequestRow;
    announceRequest(db, pushSender, mailer, row).catch((err) => console.error('Powiadomienie o zapytaniu nie powiodło się', err));
    return c.json({ ok: true, id: row.id, quoted_price: total, extras_total: extrasTotal, nights: q.nights }, 201);
  });

  app.route('/public', pub);

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
    const row = get('SELECT notify_time, notify_changes, notify_requests FROM users WHERE id = ?', userId) as
      { notify_time: string; notify_changes: number; notify_requests: number };
    return { time: row.notify_time, changes: row.notify_changes === 1, requests: row.notify_requests === 1 };
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
      adults, children, price, paid, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.unit_id, r.check_in, r.check_out, r.status, r.source, r.guest_name, r.guest_phone, r.guest_email,
      r.adults, r.children, r.price, r.paid, r.notes);
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
      guest_email = ?, adults = ?, children = ?, price = ?, paid = ?, notes = ?, dates_locked = ?, updated_at = datetime('now') WHERE id = ?`,
      r.unit_id, r.check_in, r.check_out, r.status, r.source, r.guest_name, r.guest_phone, r.guest_email,
      r.adults, r.children, r.price, r.paid, r.notes, datesLocked, id);
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
  const unitIdsIn = (user: User, raw: unknown) => {
    const ids = Array.isArray(raw) ? [...new Set(raw.map(Number).filter(Number.isInteger))] : [];
    if (!ids.length) bad('Wybierz domek');
    for (const id of ids) {
      if (!get('SELECT 1 FROM units WHERE id = ?', id)) bad('Nieznany domek');
      requireUnit(user, id);
    }
    return ids;
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
    run('UPDATE units SET base_price = ?, min_nights = ?, bookable = ? WHERE id = ?', price, Math.min(60, Math.max(1, int(b.min_nights) || 1)), b.bookable === false ? 0 : 1, id);
    if (weekday) run('UPDATE units SET weekday_prices = ? WHERE id = ?', weekday.some((v) => v != null) ? JSON.stringify(weekday) : null, id);
    if (b.type_name !== undefined) run('UPDATE units SET type_name = ? WHERE id = ?', str(b.type_name, 60), id);
    return c.json(get('SELECT id, base_price, min_nights, bookable, weekday_prices, type_name FROM units WHERE id = ?', id));
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
  const bookingSettings = () => ({ horizon_days: bookingHorizon(db), default_days: DEFAULT_HORIZON, assign_mode: assignMode() });
  const setSetting = (key: string, value: string) => run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  api.get('/settings/booking', (c) => c.json(bookingSettings()));
  api.put('/settings/booking', async (c) => {
    requireFullAdmin(c.get('user'));
    const b = await c.req.json();
    if (b.horizon_days !== undefined) {
      const days = int(b.horizon_days);
      if (days < 7 || days > 730) bad('Podaj liczbę dni od 7 do 730');
      setSetting(HORIZON_KEY, String(days));
    }
    if (b.assign_mode !== undefined) setSetting(ASSIGN_KEY, b.assign_mode === 'manual' ? 'manual' : 'auto');
    return c.json(bookingSettings());
  });

  // ---- Zapytania o rezerwację ze strony www ----
  const requestRow = (id: number) => get(`SELECT r.*, u.name AS unit_name, p.name AS property_name FROM booking_requests r
    JOIN units u ON u.id = r.unit_id JOIN properties p ON p.id = u.property_id WHERE r.id = ?`, id) as (RequestRow & Record<string, unknown>) | undefined;

  api.get('/requests', (c) => {
    const status = c.req.query('status');
    const where = status === 'pending' ? "r.status = 'pending'" : status === 'decided' ? "r.status != 'pending'" : '1';
    const rows = all(`SELECT r.*, u.name AS unit_name, p.name AS property_name FROM booking_requests r
      JOIN units u ON u.id = r.unit_id JOIN properties p ON p.id = u.property_id
      WHERE ${where} ${unitScope(c.get('user')).replace('unit_id', 'r.unit_id')}
      ORDER BY ${status === 'pending' ? 'r.created_at' : 'COALESCE(r.decided_at, r.created_at) DESC'} LIMIT 200`) as (RequestRow & Record<string, unknown>)[];
    // Czy termin w międzyczasie się zajął (np. rezerwacja z Bookingu) + które domki z typu są wolne do przydziału
    return c.json(rows.map((r) => {
      if (r.status !== 'pending') return { ...r, conflicts: [], group_units: [] };
      const groupUnits = requestGroup(r).map((id) => {
        const u = get('SELECT id, name, type_name FROM units WHERE id = ?', id) as { id: number; name: string; type_name: string } | undefined;
        return u && { ...u, free: !conflicts({ unit_id: id, check_in: r.check_in, check_out: r.check_out, status: 'confirmed' }, 0).length };
      }).filter(Boolean);
      return { ...r, conflicts: conflicts({ ...r, status: 'confirmed' }, 0), group_units: groupUnits, assign_mode: assignMode() };
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
    return r;
  };

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
    const chosen = parseChosenExtras(r.extras);
    const notes = [r.message && `Wiadomość od gościa: ${r.message}`, chosen.length && `Opcje dodatkowe: ${extrasLines(chosen).join('; ')}`,
      `Rezerwacja ze strony www (zapytanie #${r.id}).`].filter(Boolean).join('\n');
    db.exec('BEGIN');
    let created: Record<string, unknown>;
    try {
      const res = run(`INSERT INTO reservations (unit_id, check_in, check_out, status, source, guest_name, guest_phone, guest_email, adults, children, price, notes)
        VALUES (?, ?, ?, 'confirmed', 'website', ?, ?, ?, ?, ?, ?, ?)`, unitId, r.check_in, r.check_out, r.guest_name, r.guest_phone, r.guest_email,
        r.adults, r.children, price, notes);
      run(`UPDATE booking_requests SET status = 'accepted', decided_by = ?, decided_at = datetime('now'), decision_note = ?, reservation_id = ?, unit_id = ? WHERE id = ?`,
        user.username, note, res.lastInsertRowid, unitId, r.id);
      created = get('SELECT * FROM reservations WHERE id = ?', res.lastInsertRowid) as Record<string, unknown>;
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    notify([{ kind: 'created', row: created, by: user.username }], user.id);
    const emailed = b.email === false ? false : await mailDecision(db, mailer, { ...r, unit_id: unitId, decision_note: note }, true, price)
      .catch((err) => { console.error('E-mail z potwierdzeniem nie wysłany', err); return false; });
    return c.json({ request: requestRow(r.id), reservation: created, emailed });
  });

  api.post('/requests/:id/reject', async (c) => {
    const user = c.get('user');
    const r = pendingRequest(user, int(c.req.param('id')));
    const b = await c.req.json().catch(() => ({}));
    const note = str(b.note, 3000);
    run(`UPDATE booking_requests SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`, user.username, note, r.id);
    const emailed = b.email === false ? false : await mailDecision(db, mailer, { ...r, decision_note: note }, false, null)
      .catch((err) => { console.error('E-mail z odmową nie wysłany', err); return false; });
    return c.json({ request: requestRow(r.id), emailed });
  });

  // ---- Powiadomienia e-mail (adresy właściciela) ----
  api.get('/settings/email', (c) => {
    requireFullAdmin(c.get('user'));
    return c.json({ configured: !!mailer, kind: mailer?.kind ?? null, from: mailer?.from ?? null, emails: adminEmails(db).join(', ') });
  });

  api.put('/settings/email', async (c) => {
    requireFullAdmin(c.get('user'));
    const b = await c.req.json();
    const raw = str(b.emails, 1000);
    const emails = parseEmails(raw);
    if (raw && !emails.length) bad('Podaj poprawny adres e-mail');
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', NOTIFY_EMAILS_KEY, emails.join(', '));
    return c.json({ configured: !!mailer, kind: mailer?.kind ?? null, from: mailer?.from ?? null, emails: emails.join(', ') });
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
