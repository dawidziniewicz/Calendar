import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';
import { newToken } from './db.ts';
import {
  SESSION_COOKIE, SESSION_DAYS, checkLogin, clearFails, createSession, deleteSession, lockedFor, registerFail, sessionUser, setPassword,
  verifyPassword, type User,
} from './auth.ts';
import { buildIcal } from './ical.ts';
import { syncAll } from './sync.ts';

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

export function createApp(db: DatabaseSync, apiKey: string) {
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
    return c.json({ username: user.username, role: user.role });
  });

  api.use('*', async (c, next) => {
    if (c.req.path.endsWith('/auth/login')) return next();
    const user = sessionUser(db, getCookie(c, SESSION_COOKIE));
    if (!user) return c.json({ error: 'Zaloguj się', code: 'unauthenticated' }, 401);
    c.set('user', user);
    // Konto „tylko podgląd”: wyłącznie odczyt, wylogowanie i zmiana własnego hasła.
    const readOnlyAllowed = c.req.method === 'GET' || c.req.path.endsWith('/auth/logout') || c.req.path.endsWith('/auth/password');
    if (user.role === 'viewer' && !readOnlyAllowed) return c.json({ error: 'Konto tylko do podglądu — brak uprawnień do zmian' }, 403);
    await next();
  });

  api.get('/auth/me', (c) => c.json({ username: c.get('user').username, role: c.get('user').role }));

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

  // ---- Obiekty i jednostki ----
  api.get('/properties', (c) => {
    const properties = all('SELECT * FROM properties ORDER BY sort, id') as Record<string, unknown>[];
    const units = all('SELECT * FROM units ORDER BY sort, id') as Record<string, unknown>[];
    const feeds = all('SELECT * FROM feeds ORDER BY id') as Record<string, unknown>[];
    const viewer = c.get('user').role === 'viewer';
    return c.json(properties.map((p) => ({
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

  api.post('/sync', async (c) => c.json(await syncAll(db)));

  // ---- Rezerwacje ----
  api.get('/reservations', (c) => {
    const from = c.req.query('from') ?? '0000-01-01';
    const to = c.req.query('to') ?? '9999-12-31';
    const withCancelled = c.req.query('cancelled') === '1';
    return c.json(all(`SELECT * FROM reservations WHERE check_out > ? AND check_in < ? ${withCancelled ? '' : "AND status != 'cancelled'"}
      ORDER BY check_in, unit_id`, from, to));
  });

  api.get('/guests', (c) => {
    const q = `%${str(c.req.query('q'), 50)}%`;
    return c.json(all(`SELECT guest_name, guest_phone, guest_email, MAX(check_in) AS last_stay, COUNT(*) AS stays
      FROM reservations WHERE guest_name != '' AND (guest_name LIKE ? OR guest_phone LIKE ? OR guest_email LIKE ?)
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
    const found = conflicts(r, 0);
    if (found.length && !b.force) return c.json({ error: 'Termin nakłada się z inną rezerwacją', conflicts: found }, 409);
    const res = run(`INSERT INTO reservations (unit_id, check_in, check_out, status, source, guest_name, guest_phone, guest_email,
      adults, children, price, paid, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.unit_id, r.check_in, r.check_out, r.status, r.source, r.guest_name, r.guest_phone, r.guest_email,
      r.adults, r.children, r.price, r.paid, r.notes);
    return c.json(get('SELECT * FROM reservations WHERE id = ?', res.lastInsertRowid), 201);
  });

  api.put('/reservations/:id', async (c) => {
    const id = int(c.req.param('id'));
    const existing = get('SELECT * FROM reservations WHERE id = ?', id) as Record<string, unknown> | undefined;
    if (!existing) return c.json({ error: 'Nie znaleziono' }, 404);
    const b = await c.req.json();
    const r = readReservation(b);
    // Terminy i obiekt rezerwacji z Bookingu są zarządzane przez synchronizację.
    if (existing.feed_id) {
      r.unit_id = existing.unit_id as number;
      r.check_in = existing.check_in as string;
      r.check_out = existing.check_out as string;
      r.source = existing.source as string;
    }
    const found = conflicts(r, id);
    if (found.length && !b.force) return c.json({ error: 'Termin nakłada się z inną rezerwacją', conflicts: found }, 409);
    run(`UPDATE reservations SET unit_id = ?, check_in = ?, check_out = ?, status = ?, source = ?, guest_name = ?, guest_phone = ?,
      guest_email = ?, adults = ?, children = ?, price = ?, paid = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
      r.unit_id, r.check_in, r.check_out, r.status, r.source, r.guest_name, r.guest_phone, r.guest_email,
      r.adults, r.children, r.price, r.paid, r.notes, id);
    return c.json(get('SELECT * FROM reservations WHERE id = ?', id));
  });

  // ---- Odwołane na Bookingu: do przejrzenia / zamiany na bezpośrednią ----
  api.get('/booking-cancellations', (c) => c.json(all(`SELECT * FROM reservations
    WHERE external_uid IS NOT NULL AND status = 'cancelled' AND cancelled_at IS NOT NULL AND cancel_reviewed = 0
    ORDER BY check_in`)));

  const cancelledImport = (id: number) => {
    const row = get('SELECT * FROM reservations WHERE id = ?', id) as Record<string, unknown> | undefined;
    if (!row) throw new HTTPException(404, { message: 'Nie znaleziono' });
    if (!row.external_uid || row.status !== 'cancelled') bad('To nie jest odwołana rezerwacja z Bookingu');
    return row;
  };

  api.post('/reservations/:id/convert-direct', async (c) => {
    const id = int(c.req.param('id'));
    const row = cancelledImport(id);
    const b = await c.req.json().catch(() => ({}));
    const found = conflicts({ unit_id: row.unit_id as number, check_in: row.check_in as string, check_out: row.check_out as string, status: 'confirmed' }, id);
    if (found.length && !b.force) return c.json({ error: 'Termin nakłada się z inną rezerwacją', conflicts: found }, 409);
    const note = `Przeniesiona z ${row.source === 'booking' ? 'Booking.com' : row.source} po odwołaniu (${new Date().toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw' })}).`;
    // Odłączenie od kalendarza Bookingu: synchronizacja już jej nie dotknie.
    run(`UPDATE reservations SET feed_id = NULL, external_uid = NULL, source = 'direct', status = 'confirmed',
      cancelled_at = NULL, cancel_reviewed = 0, notes = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END,
      updated_at = datetime('now') WHERE id = ?`, note, note, id);
    return c.json(get('SELECT * FROM reservations WHERE id = ?', id));
  });

  api.post('/reservations/:id/review-cancellation', (c) => {
    const id = int(c.req.param('id'));
    cancelledImport(id);
    run('UPDATE reservations SET cancel_reviewed = 1 WHERE id = ?', id);
    return c.json(get('SELECT * FROM reservations WHERE id = ?', id));
  });

  api.delete('/reservations/:id', (c) => {
    run('DELETE FROM reservations WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  app.route('/api', api);
  return app;
}
