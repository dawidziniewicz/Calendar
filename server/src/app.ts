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

export function createApp(db: DatabaseSync, apiKey: string, pushSender?: Sender) {
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
    const row = get('SELECT notify_time, notify_changes FROM users WHERE id = ?', userId) as { notify_time: string; notify_changes: number };
    return { time: row.notify_time, changes: row.notify_changes === 1 };
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
      int(b.property_id), str(b.name, 100), int(b.capacity), /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#2f7d6d', m, newToken());
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });

  api.put('/units/:id', async (c) => {
    const b = await c.req.json();
    if (!str(b.name)) bad('Podaj nazwę');
    run('UPDATE units SET name = ?, capacity = ?, color = ? WHERE id = ?',
      str(b.name, 100), int(b.capacity), /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#2f7d6d', c.req.param('id'));
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

  app.route('/api', api);
  return app;
}
