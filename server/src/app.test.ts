import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { hashPassword } from './auth.ts';
import { createApp } from './app.ts';
import { parseIcal } from './ical.ts';
import { syncFeed } from './sync.ts';
import { dailyArrivalsTick, saveSubscription, type Sender } from './push.ts';
import { announce, syncEvents } from './changes.ts';

const KEY = 'test-key-1234567890';

function setup() {
  const db = openDb(':memory:');
  const app = createApp(db, KEY);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('dawid', hashPassword('tajne-haslo-123'));
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { 'x-api-key': KEY, 'content-type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const login = () => call('POST', '/api/auth/login', { username: 'dawid', password: 'tajne-haslo-123' });
  return { db, app, call, login };
}

test('wymaga klucza API i zalogowania', async () => {
  const { app, call, login } = setup();
  assert.equal((await app.request('/api/properties')).status, 403);
  assert.equal((await call('GET', '/api/properties')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'dawid', password: 'zle' })).status, 401);
  const res = await login();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/);
  assert.equal((await call('GET', '/api/properties')).status, 200);
  assert.deepEqual(await (await call('GET', '/api/auth/me')).json(), { username: 'dawid', role: 'admin', properties: null, canManageUsers: true });
  await call('POST', '/api/auth/logout');
  assert.equal((await call('GET', '/api/properties')).status, 401);
});

test('blokuje po 5 błędnych hasłach', async () => {
  const { app } = setup();
  const attempt = (password: string) => app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json', 'x-client-ip': '10.0.0.9' },
    body: JSON.stringify({ username: 'kto-inny', password }),
  });
  for (let i = 0; i < 5; i++) assert.equal((await attempt('zle')).status, 401);
  assert.equal((await attempt('zle')).status, 429);
});

test('zmiana hasła', async () => {
  const { call, login } = setup();
  await login();
  assert.equal((await call('POST', '/api/auth/password', { current: 'zle', next: 'nowe-haslo-456' })).status, 400);
  assert.equal((await call('POST', '/api/auth/password', { current: 'tajne-haslo-123', next: 'nowe-haslo-456' })).status, 200);
  assert.equal((await call('GET', '/api/auth/me')).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { username: 'dawid', password: 'nowe-haslo-456' })).status, 200);
});

test('seed zawiera obiekty z odmorzadogor.pl', async () => {
  const { call, login } = setup();
  await login();
  const props = await (await call('GET', '/api/properties')).json();
  assert.equal(props.length, 4);
  assert.equal(props.flatMap((p: { units: unknown[] }) => p.units).length, 10);
});

test('wykrywa nakładające się rezerwacje', async () => {
  const { call, login } = setup();
  await login();
  const base = { unit_id: 1, check_in: '2030-07-01', check_out: '2030-07-05', guest_name: 'Jan' };
  assert.equal((await call('POST', '/api/reservations', base)).status, 201);
  // wyjazd i przyjazd tego samego dnia to nie konflikt
  assert.equal((await call('POST', '/api/reservations', { ...base, check_in: '2030-07-05', check_out: '2030-07-07' })).status, 201);
  const res = await call('POST', '/api/reservations', { ...base, check_in: '2030-07-04', check_out: '2030-07-06' });
  assert.equal(res.status, 409);
  assert.equal((await call('POST', '/api/reservations', { ...base, check_in: '2030-07-04', force: true })).status, 201);
});

test('parsuje iCal Bookingu', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20300710\r\nDTEND;VALUE=DATE:20300714\r\nUID:abc@booking\r\nSUMMARY:CLOSED - Not av\r\n ailable\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.deepEqual(parseIcal(ics), [{ uid: 'abc@booking', start: '2030-07-10', end: '2030-07-14', summary: 'CLOSED - Not available' }]);
});

test('synchronizacja dodaje, aktualizuje i anuluje, zachowując dane gościa', async () => {
  const { db, call, app, login } = setup();
  await login();
  const ev = (uid: string, s: string, e: string) => `BEGIN:VEVENT\nUID:${uid}\nDTSTART;VALUE=DATE:${s}\nDTEND;VALUE=DATE:${e}\nEND:VEVENT\n`;
  let feedBody = `BEGIN:VCALENDAR\n${ev('a', '20300801', '20300805')}${ev('b', '20300810', '20300812')}END:VCALENDAR`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(feedBody)) as typeof fetch;
  try {
    await call('POST', '/api/feeds', { unit_id: 2, url: 'https://example.com/x.ics' });
    const feed = { id: 1, unit_id: 2, source: 'booking', url: 'https://example.com/x.ics' };
    assert.equal((await syncFeed(db, feed)).added, 2);

    const [a] = await (await call('GET', '/api/reservations?from=2030-08-01&to=2030-08-02')).json();
    await call('PUT', `/api/reservations/${a.id}`, { ...a, guest_name: 'Anna Nowak' });

    feedBody = `BEGIN:VCALENDAR\n${ev('a', '20300802', '20300806')}END:VCALENDAR`;
    const r = await syncFeed(db, feed);
    assert.deepEqual([r.added, r.updated, r.cancelled], [0, 1, 1]);
    const rows = await (await call('GET', '/api/reservations?cancelled=1')).json();
    const updated = rows.find((x: { id: number }) => x.id === a.id);
    assert.equal(updated.guest_name, 'Anna Nowak');
    assert.equal(updated.check_in, '2030-08-02');
    assert.equal(rows.find((x: { external_uid: string }) => x.external_uid === 'b').status, 'cancelled');

    const token = (db.prepare('SELECT export_token FROM units WHERE id = 2').get() as { export_token: string }).export_token;
    const ics = await (await app.request(`/ical/${token}.ics`)).text();
    assert.match(ics, /DTSTART;VALUE=DATE:20300802/);
    assert.doesNotMatch(await (await app.request(`/ical/${token}.ics?exclude=booking`)).text(), /VEVENT/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('odwołana na Bookingu → zamiana na rezerwację prywatną', async () => {
  const { db, call, login } = setup();
  await login();
  let body = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x1\nDTSTART;VALUE=DATE:20300901\nDTEND;VALUE=DATE:20300904\nEND:VEVENT\nEND:VCALENDAR';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body)) as typeof fetch;
  try {
    await call('POST', '/api/feeds', { unit_id: 3, url: 'https://example.com/y.ics' });
    const feed = { id: 1, unit_id: 3, source: 'booking', url: 'https://example.com/y.ics' };
    await syncFeed(db, feed);
    const [r] = await (await call('GET', '/api/reservations?from=2030-09-01&to=2030-09-02')).json();
    await call('PUT', `/api/reservations/${r.id}`, { ...r, guest_name: 'Ewa Gość', guest_phone: '600' });

    // nie da się zamienić aktywnej rezerwacji z Bookingu
    assert.equal((await call('POST', `/api/reservations/${r.id}/convert-direct`)).status, 400);

    body = 'BEGIN:VCALENDAR\nEND:VCALENDAR';
    await syncFeed(db, feed);
    const list = await (await call('GET', '/api/booking-cancellations')).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].guest_name, 'Ewa Gość');

    const converted = await (await call('POST', `/api/reservations/${r.id}/convert-direct`)).json();
    assert.equal(converted.source, 'direct');
    assert.equal(converted.status, 'confirmed');
    assert.equal(converted.feed_id, null);
    assert.match(converted.notes, /Przeniesiona z Booking.com/);
    assert.equal((await (await call('GET', '/api/booking-cancellations')).json()).length, 0);

    // kolejna synchronizacja nie rusza już tej rezerwacji
    await syncFeed(db, feed);
    const after = (await (await call('GET', '/api/reservations?from=2030-09-01&to=2030-09-02')).json())[0];
    assert.equal(after.status, 'confirmed');
    assert.equal(after.guest_name, 'Ewa Gość');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('odwołanie można oznaczyć jako przejrzane', async () => {
  const { db, call, login } = setup();
  await login();
  let body = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:z\nDTSTART;VALUE=DATE:20301001\nDTEND;VALUE=DATE:20301003\nEND:VEVENT\nEND:VCALENDAR';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body)) as typeof fetch;
  try {
    await call('POST', '/api/feeds', { unit_id: 4, url: 'https://example.com/z.ics' });
    const feed = { id: 1, unit_id: 4, source: 'booking', url: 'https://example.com/z.ics' };
    await syncFeed(db, feed);
    body = 'BEGIN:VCALENDAR\nEND:VCALENDAR';
    await syncFeed(db, feed);
    const [c] = await (await call('GET', '/api/booking-cancellations')).json();
    assert.equal((await call('POST', `/api/reservations/${c.id}/review-cancellation`)).status, 200);
    assert.equal((await (await call('GET', '/api/booking-cancellations')).json()).length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('konto tylko do podglądu nie może nic zmieniać', async () => {
  const { db, app } = setup();
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('jan', ?, 'viewer')").run(hashPassword('podglad-123'));
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const login = await call('POST', '/api/auth/login', { username: 'jan', password: 'podglad-123' });
  assert.deepEqual(await login.json(), { username: 'jan', role: 'viewer', properties: null, canManageUsers: false });

  assert.equal((await call('GET', '/api/reservations')).status, 200);
  const props = await (await call('GET', '/api/properties')).json();
  assert.equal(props[0].units[0].export_token, '');

  const res = { unit_id: 1, check_in: '2030-01-01', check_out: '2030-01-03' };
  for (const [m, path, body] of [
    ['POST', '/api/reservations', res], ['PUT', '/api/reservations/1', res], ['DELETE', '/api/reservations/1'],
    ['POST', '/api/units', { property_id: 1, name: 'x' }], ['POST', '/api/sync'], ['POST', '/api/feeds', { unit_id: 1, url: 'https://x' }],
  ] as [string, string, unknown?][]) {
    assert.equal((await call(m, path, body)).status, 403, `${m} ${path}`);
  }
  assert.equal((await call('POST', '/api/auth/password', { current: 'podglad-123', next: 'nowe-haslo-789' })).status, 200);
  assert.equal((await call('POST', '/api/auth/logout')).status, 200);
});

test('podmiana linku kalendarza nie dubluje rezerwacji (nawet gdy zmienią się UID)', async () => {
  const { db, call, login } = setup();
  await login();
  const ev = (uid: string, a: string, b: string) => `BEGIN:VEVENT\nUID:${uid}\nDTSTART;VALUE=DATE:${a}\nDTEND;VALUE=DATE:${b}\nEND:VEVENT\n`;
  let body = `BEGIN:VCALENDAR\n${ev('old-1', '20301101', '20301105')}END:VCALENDAR`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body)) as typeof fetch;
  try {
    await call('POST', '/api/feeds', { unit_id: 5, url: 'https://example.com/a.ics' });
    await syncFeed(db, { id: 1, unit_id: 5, source: 'booking', url: 'https://example.com/a.ics' });
    const [r] = await (await call('GET', '/api/reservations?from=2030-11-01&to=2030-11-02')).json();
    await call('PUT', `/api/reservations/${r.id}`, { ...r, guest_name: 'Stały Gość' });

    assert.equal((await call('PUT', '/api/feeds/1', { url: 'http://zly' })).status, 400);
    assert.equal((await call('PUT', '/api/feeds/1', { url: 'https://example.com/b.ics' })).status, 200);

    // nowy link: ta sama rezerwacja z innym UID + zamknięty termin
    body = `BEGIN:VCALENDAR\n${ev('new-1', '20301101', '20301105')}${ev('closed-1', '20301110', '20301112')}END:VCALENDAR`;
    const res = await syncFeed(db, { id: 1, unit_id: 5, source: 'booking', url: 'https://example.com/b.ics' });
    assert.deepEqual([res.added, res.cancelled], [1, 0]);
    const rows = await (await call('GET', '/api/reservations?from=2030-11-01&to=2030-11-30&cancelled=1')).json();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].guest_name, 'Stały Gość');
    assert.equal(rows[0].external_uid, 'new-1');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('rezerwację z Bookingu można edytować, a ręcznie zmienionych dat synchronizacja nie nadpisuje', async () => {
  const { db, call, login } = setup();
  await login();
  const ev = (a: string, b: string) => `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:bk\nDTSTART;VALUE=DATE:${a}\nDTEND;VALUE=DATE:${b}\nEND:VEVENT\nEND:VCALENDAR`;
  let body = ev('20301201', '20301204');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body)) as typeof fetch;
  try {
    await call('POST', '/api/feeds', { unit_id: 1, url: 'https://example.com/e.ics' });
    const feed = { id: 1, unit_id: 1, source: 'booking', url: 'https://example.com/e.ics' };
    await syncFeed(db, feed);
    const [r] = await (await call('GET', '/api/reservations?from=2030-12-01&to=2030-12-02')).json();

    // tylko dane gościa → daty dalej synchronizowane
    await call('PUT', `/api/reservations/${r.id}`, { ...r, guest_name: 'Marta' });
    body = ev('20301202', '20301205');
    await syncFeed(db, feed);
    let row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(r.id) as Record<string, unknown>;
    assert.deepEqual([row.check_in, row.dates_locked], ['2030-12-02', 0]);

    // zmiana domku i dat
    const res = await call('PUT', `/api/reservations/${r.id}`, { ...row, unit_id: 2, check_in: '2030-12-10', check_out: '2030-12-14' });
    assert.equal(res.status, 200);
    body = ev('20301203', '20301206');
    await syncFeed(db, feed);
    row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(r.id) as Record<string, unknown>;
    assert.deepEqual([row.unit_id, row.check_in, row.check_out, row.guest_name, row.dates_locked], [2, '2030-12-10', '2030-12-14', 'Marta', 1]);

    // anulowanie na Bookingu dalej wykrywane
    body = 'BEGIN:VCALENDAR\nEND:VCALENDAR';
    await syncFeed(db, feed);
    row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(r.id) as Record<string, unknown>;
    assert.equal(row.status, 'cancelled');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('powiadomienia o przyjazdach: osobne na każdy przyjazd, o godzinie każdego użytkownika, raz dziennie', async () => {
  const { db, call, login } = setup();
  await login();
  db.prepare("INSERT INTO users (username, password_hash, notify_time) VALUES ('jozek', 'x', '07:30')").run();
  const sent: { endpoint: string; payload: string }[] = [];
  const send: Sender = async (sub, payload) => {
    if (sub.endpoint.includes('dead')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    sent.push({ endpoint: sub.endpoint, payload });
  };
  const keys = { p256dh: 'p', auth: 'a' };
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/dawid', keys } })).status, 200);
  saveSubscription(db, 1, { endpoint: 'https://push.example/dead', keys });
  saveSubscription(db, 2, { endpoint: 'https://push.example/jozek', keys });

  // ustawienia godziny
  assert.deepEqual(await (await call('GET', '/api/push/settings')).json(), { time: '09:00', changes: true, requests: true });
  assert.equal((await call('PUT', '/api/push/settings', { time: '25:00' })).status, 400);
  assert.equal((await call('PUT', '/api/push/settings', { time: '10:15' })).status, 200);

  const at = (iso: string) => new Date(iso); // czas UTC; w lipcu Warszawa = UTC+2
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-01T08:00:00Z')), 0); // brak przyjazdów

  await call('POST', '/api/reservations', { unit_id: 1, check_in: '2030-07-02', check_out: '2030-07-05', guest_name: 'Ola', adults: 2, children: 1 });
  await call('POST', '/api/reservations', { unit_id: 7, check_in: '2030-07-02', check_out: '2030-07-04', source: 'booking' });

  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-02T05:00:00Z')), 0); // 7:00 — za wcześnie dla obu
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-02T05:31:00Z')), 2); // 7:31 — Józek, 2 przyjazdy = 2 powiadomienia
  assert.deepEqual(sent.map((s) => s.endpoint), ['https://push.example/jozek', 'https://push.example/jozek']);
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-02T07:30:00Z')), 0); // 9:30 — Dawid ma 10:15
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-02T08:16:00Z')), 2); // 10:16 — Dawid
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-02T08:17:00Z')), 0); // już wysłane obu

  const [first, second] = sent.slice(2).map((s) => JSON.parse(s.payload));
  assert.equal(first.title, 'Przyjazd dziś: Mały domek 1 · Osada Jantar');
  assert.equal(first.body, 'Ola · 3 os. · 3 noce, wyjazd 5 lip');
  assert.match(first.url, /^\/\?reservation=\d+$/);
  assert.equal(second.title, 'Przyjazd dziś: Karpatka 1 · Apartamenty Karpatka');
  assert.equal(second.body, 'Gość z Booking.com · 2 noce, wyjazd 4 lip');
  assert.notEqual(first.tag, second.tag);
  assert.equal((await call('GET', first.url.replace('/?reservation=', '/api/reservations/'))).status, 200);
  // martwa subskrypcja usunięta
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%dead'").get() as { n: number }).n, 0);

  // serwer wyłączony o 7:30 — nadrabia do 3 godzin, później już nie
  db.prepare('UPDATE users SET notified_on = NULL').run();
  await call('POST', '/api/reservations', { unit_id: 2, check_in: '2030-07-03', check_out: '2030-07-05' });
  sent.length = 0;
  // 11:00: Dawid (10:15) nadrabia, Józek (7:30) — minęło ponad 3 godziny, więc już nie
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-03T09:00:00Z')), 1);
  assert.deepEqual(sent.map((s) => s.endpoint), ['https://push.example/dawid']);
});

function setupWithPush() {
  const db = openDb(':memory:');
  const sent: { endpoint: string; msg: { title: string; body: string; url: string } }[] = [];
  const send: Sender = async (sub, payload) => { sent.push({ endpoint: sub.endpoint, msg: JSON.parse(payload) }); };
  const app = createApp(db, KEY, send);
  const hash = hashPassword('haslo-12345');
  for (const name of ['dawid', 'jozek', 'jan']) db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(name, hash);
  const keys = { p256dh: 'p', auth: 'a' };
  saveSubscription(db, 1, { endpoint: 'https://push.example/dawid', keys });
  saveSubscription(db, 2, { endpoint: 'https://push.example/jozek', keys });
  saveSubscription(db, 3, { endpoint: 'https://push.example/jan', keys });
  const session = (username: string) => {
    let cookie = '';
    return async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return res;
    };
  };
  const loginAs = async (username: string) => {
    const call = session(username);
    await call('POST', '/api/auth/login', { username, password: 'haslo-12345' });
    return call;
  };
  const flush = () => new Promise((r) => setTimeout(r, 10));
  return { db, sent, send, loginAs, flush };
}

test('powiadomienia o zmianach: inni użytkownicy dostają info o dodaniu, zmianie i usunięciu', async () => {
  const { sent, loginAs, flush } = setupWithPush();
  const dawid = await loginAs('dawid');
  const jan = await loginAs('jan');
  await jan('PUT', '/api/push/settings', { changes: false }); // Jan wyłączył powiadomienia o zmianach
  const to = () => [...new Set(sent.map((s) => s.endpoint.split('/').pop()))];

  const r = await (await dawid('POST', '/api/reservations', { unit_id: 1, check_in: '2030-08-10', check_out: '2030-08-13', guest_name: 'Ewa', adults: 2 })).json();
  await flush();
  assert.deepEqual(to(), ['jozek']); // nie autor, nie Jan
  assert.equal(sent[0].msg.title, 'Nowa rezerwacja · Mały domek 1 · Osada Jantar');
  assert.equal(sent[0].msg.body, 'Ewa · 10–13 sie (3 noce) · dodane przez dawid');
  assert.equal(sent[0].msg.url, `/?reservation=${r.id}`);

  const jozek = await loginAs('jozek');
  sent.length = 0;
  await jozek('PUT', `/api/reservations/${r.id}`, { ...r, check_in: '2030-08-30', check_out: '2030-09-02', paid: 500 });
  await flush();
  assert.deepEqual(to(), ['dawid']);
  assert.equal(sent[0].msg.title, 'Zmiana rezerwacji · Mały domek 1 · Osada Jantar');
  assert.equal(sent[0].msg.body, 'Ewa · 30 sie – 2 wrz\nZmieniono: daty (było: 10–13 sie), wpłata · jozek');

  // zapis bez zmian → bez powiadomienia
  sent.length = 0;
  const same = await (await jozek('GET', `/api/reservations/${r.id}`)).json();
  await jozek('PUT', `/api/reservations/${r.id}`, same);
  await flush();
  assert.equal(sent.length, 0);

  await dawid('DELETE', `/api/reservations/${r.id}`);
  await flush();
  assert.equal(sent[0].msg.title, 'Usunięta rezerwacja · Mały domek 1 · Osada Jantar');
  assert.deepEqual(to(), ['jozek']);
});

test('powiadomienia o zmianach z Bookingu: nie przy pierwszym pobraniu; nowe, zmiana terminu, odwołanie; zbiorcze przy wielu', async () => {
  const { db, sent, send, loginAs, flush } = setupWithPush();
  const dawid = await loginAs('dawid');
  await dawid('POST', '/api/feeds', { unit_id: 6, url: 'https://example.com/s.ics' });
  const ev = (uid: string, a: string, b: string) => `BEGIN:VEVENT\nUID:${uid}\nDTSTART;VALUE=DATE:${a}\nDTEND;VALUE=DATE:${b}\nEND:VEVENT\n`;
  let body = `BEGIN:VCALENDAR\n${ev('a', '20300901', '20300904')}END:VCALENDAR`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body)) as typeof fetch;
  const feed = () => db.prepare('SELECT id, unit_id, source, url, last_sync_at FROM feeds WHERE id = 1').get() as Parameters<typeof syncFeed>[1];
  const runSync = async () => { const r = await syncFeed(db, feed()); await announce(db, send, syncEvents(db, r.changes), null); };
  try {
    await runSync(); // pierwsze pobranie
    assert.equal(sent.length, 0);

    body = `BEGIN:VCALENDAR\n${ev('a', '20300902', '20300905')}${ev('b', '20300910', '20300912')}END:VCALENDAR`;
    await runSync();
    const titles = sent.filter((s) => s.endpoint.endsWith('dawid')).map((s) => s.msg.title);
    assert.deepEqual(titles.sort(), ['Booking.com: zmiana terminu · Sopot Holiday Sauna · Apartament Sopot', 'Nowa rezerwacja z Booking.com · Sopot Holiday Sauna · Apartament Sopot']);
    assert.equal(sent.find((s) => s.msg.title.startsWith('Booking.com: zmiana'))!.msg.body, 'Gość z Booking.com · teraz 2–5 wrz (było: 1–4 wrz)');
    assert.equal(new Set(sent.map((s) => s.endpoint)).size, 3); // zmiany z Bookingu → wszyscy

    sent.length = 0;
    body = `BEGIN:VCALENDAR\n${ev('a', '20300902', '20300905')}END:VCALENDAR`;
    await runSync();
    assert.equal(sent[0].msg.title, 'Odwołana na Booking.com · Sopot Holiday Sauna · Apartament Sopot');

    sent.length = 0;
    body = 'BEGIN:VCALENDAR\n' + Array.from({ length: 7 }, (_, i) => ev(`m${i}`, `203010${10 + i * 3}`, `203010${11 + i * 3}`)).join('') + 'END:VCALENDAR';
    await runSync();
    const forDawid = sent.filter((s) => s.endpoint.endsWith('dawid'));
    assert.equal(forDawid.length, 1);
    assert.match(forDawid[0].msg.title, /^Zmiany w rezerwacjach: 8$/); // 7 nowych + odwołanie „a”
    await flush();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('konto ograniczone do Osady Jantar widzi i zmienia tylko Jantar', async () => {
  const { db, sent, send, loginAs, flush } = setupWithPush();
  // Osada Jantar = obiekt 1 (domki 1–5), Sopot = obiekt 2 (domek 6)
  db.prepare("INSERT INTO users (username, password_hash, property_ids) VALUES ('jantar', ?, '[1]')").run(hashPassword('haslo-12345'));
  saveSubscription(db, 4, { endpoint: 'https://push.example/jantar', keys: { p256dh: 'p', auth: 'a' } });
  const dawid = await loginAs('dawid');
  const jantar = await loginAs('jantar');

  assert.deepEqual(await (await jantar('GET', '/api/auth/me')).json(), { username: 'jantar', role: 'admin', properties: ['Osada Jantar'], canManageUsers: false });
  const props = await (await jantar('GET', '/api/properties')).json();
  assert.deepEqual(props.map((p: { name: string }) => p.name), ['Osada Jantar']);

  const inJantar = await (await dawid('POST', '/api/reservations', { unit_id: 2, check_in: '2030-06-01', check_out: '2030-06-04', guest_name: 'Jantar Gość' })).json();
  const inSopot = await (await dawid('POST', '/api/reservations', { unit_id: 6, check_in: '2030-06-01', check_out: '2030-06-04', guest_name: 'Sopot Gość' })).json();
  await flush();

  // widzi tylko Jantar
  const list = await (await jantar('GET', '/api/reservations')).json();
  assert.deepEqual(list.map((r: { guest_name: string }) => r.guest_name), ['Jantar Gość']);
  assert.equal((await jantar('GET', `/api/reservations/${inSopot.id}`)).status, 404);
  const guests = await (await jantar('GET', '/api/guests?q=Gość')).json();
  assert.deepEqual(guests.map((g: { guest_name: string }) => g.guest_name), ['Jantar Gość']);

  // zmienia tylko Jantar
  assert.equal((await jantar('POST', '/api/reservations', { unit_id: 3, check_in: '2030-07-01', check_out: '2030-07-02' })).status, 201);
  assert.equal((await jantar('POST', '/api/reservations', { unit_id: 6, check_in: '2030-07-01', check_out: '2030-07-02' })).status, 403);
  assert.equal((await jantar('PUT', `/api/reservations/${inJantar.id}`, { ...inJantar, unit_id: 6 })).status, 403); // przeniesienie do Sopotu
  assert.equal((await jantar('PUT', `/api/reservations/${inSopot.id}`, inSopot)).status, 404);
  assert.equal((await jantar('DELETE', `/api/reservations/${inSopot.id}`)).status, 404);
  assert.equal((await jantar('PUT', '/api/units/1', { name: 'X', capacity: 1, color: '#000000' })).status, 403);
  assert.equal((await jantar('POST', '/api/feeds', { unit_id: 1, url: 'https://x.pl/a.ics' })).status, 403);

  // powiadomienia o zmianach: tylko z Jantaru
  sent.length = 0;
  await dawid('PUT', `/api/reservations/${inSopot.id}`, { ...inSopot, paid: 100 });
  await dawid('PUT', `/api/reservations/${inJantar.id}`, { ...inJantar, paid: 100 });
  await flush();
  const forJantar = sent.filter((x) => x.endpoint.endsWith('jantar')).map((x) => x.msg.title);
  assert.deepEqual(forJantar, ['Zmiana rezerwacji · Mały domek 2 · Osada Jantar']);

  // poranne przyjazdy: tylko z Jantaru
  sent.length = 0;
  db.prepare('UPDATE users SET notified_on = NULL').run();
  await dailyArrivalsTick(db, send, new Date('2030-06-01T08:00:00Z'));
  const arrivals = sent.filter((x) => x.endpoint.endsWith('jantar')).map((x) => x.msg.title);
  assert.deepEqual(arrivals, ['Przyjazd dziś: Mały domek 2 · Osada Jantar']);
  assert.equal(sent.filter((x) => x.endpoint.endsWith('dawid')).length, 2); // admin bez ograniczeń: oba
});

test('zarządzanie użytkownikami: admin dodaje, zmienia uprawnienia i hasło, usuwa; inni nie mają dostępu', async () => {
  const { loginAs } = setupWithPush(); // dawid, jozek, jan — wszyscy admini bez ograniczeń
  const dawid = await loginAs('dawid');

  // nowe konto: tylko podgląd, tylko Osada Jantar
  const created = await dawid('POST', '/api/users', { username: 'jantar', password: 'haslo-12345', role: 'viewer', properties: [1] }); // hasło jak w loginAs
  assert.equal(created.status, 201);
  const jantarUser = await created.json();
  assert.deepEqual([jantarUser.username, jantarUser.role, jantarUser.properties], ['jantar', 'viewer', [1]]);
  assert.equal((await dawid('POST', '/api/users', { username: 'jantar', password: 'obsluga-123', role: 'viewer' })).status, 400); // duplikat
  assert.equal((await dawid('POST', '/api/users', { username: 'x', password: 'obsluga-123', role: 'viewer' })).status, 400); // za krótki login
  assert.equal((await dawid('POST', '/api/users', { username: 'nowy', password: 'krotkie', role: 'viewer' })).status, 400);
  assert.equal((await dawid('POST', '/api/users', { username: 'nowy', password: 'obsluga-123', role: 'viewer', properties: [] })).status, 400);
  assert.equal((await dawid('POST', '/api/users', { username: 'nowy', password: 'obsluga-123', role: 'viewer', properties: [99] })).status, 400);

  // obsługa loguje się, widzi tylko Jantar i nie może nic zmieniać ani zarządzać kontami
  const jantar = await loginAs('jantar');
  assert.deepEqual(await (await jantar('GET', '/api/auth/me')).json(), { username: 'jantar', role: 'viewer', properties: ['Osada Jantar'], canManageUsers: false });
  assert.equal((await jantar('POST', '/api/reservations', { unit_id: 1, check_in: '2030-01-01', check_out: '2030-01-02' })).status, 403);
  assert.equal((await jantar('GET', '/api/users')).status, 403);

  // lista
  const list = await (await dawid('GET', '/api/users')).json();
  assert.deepEqual(list.map((u: { username: string; me: boolean }) => `${u.username}${u.me ? '*' : ''}`), ['dawid*', 'jan', 'jantar', 'jozek']);

  // zmiana uprawnień: Jantar + Sopot, admin
  const upd = await dawid('PUT', `/api/users/${jantarUser.id}`, { role: 'admin', properties: [1, 2] });
  assert.deepEqual((await upd.json()).properties, [1, 2]);
  assert.deepEqual((await (await jantar('GET', '/api/auth/me')).json()).properties, ['Osada Jantar', 'Apartament Sopot']); // działa od razu

  // zmiana hasła wylogowuje użytkownika
  assert.equal((await dawid('POST', `/api/users/${jantarUser.id}/password`, { password: 'nowe-haslo-999' })).status, 200);
  assert.equal((await jantar('GET', '/api/auth/me')).status, 401);

  // własnego konta nie da się zdegradować ani usunąć
  const me = list.find((u: { me: boolean }) => u.me);
  assert.equal((await dawid('PUT', `/api/users/${me.id}`, { role: 'viewer', properties: null })).status, 400);
  assert.equal((await dawid('DELETE', `/api/users/${me.id}`)).status, 400);

  // admin z ograniczeniem nie zarządza kontami
  const jozek = await loginAs('jozek');
  await dawid('PUT', `/api/users/${list.find((u: { username: string }) => u.username === 'jozek').id}`, { role: 'admin', properties: [1] });
  assert.equal((await jozek('GET', '/api/users')).status, 403);

  assert.equal((await dawid('DELETE', `/api/users/${jantarUser.id}`)).status, 200);
  assert.equal((await dawid('GET', '/api/users').then((r) => r.json())).length, 3);
});

// ---- Strona www: cennik, dostępność, zapytania o rezerwację ----

function setupWithMail() {
  const db = openDb(':memory:');
  const sent: { to: string[]; subject: string; text: string }[] = [];
  const mailer = { from: 'test@x.pl', kind: 'resend' as const, send: async (m: { to: string[]; subject: string; text: string }) => { sent.push(m); } };
  const app = createApp(db, KEY, undefined, mailer);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('dawid', hashPassword('tajne-haslo-123'));
  db.prepare("INSERT INTO settings (key, value) VALUES ('notify_emails', 'wlasciciel@x.pl')").run();
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { 'x-api-key': KEY, 'content-type': 'application/json', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const login = () => call('POST', '/api/auth/login', { username: 'dawid', password: 'tajne-haslo-123' });
  return { db, app, call, login, sent };
}

const inDays = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const flush = () => new Promise((r) => setTimeout(r, 20));

test('cennik: cena podstawowa, nadpisania dni i dni tygodnia', async () => {
  const { call, login, app } = setupWithMail();
  assert.equal((await app.request('/public/catalog')).status, 403); // bez klucza API
  await login();
  assert.equal((await call('PUT', '/api/rates/unit/1', { base_price: 400, min_nights: 2 })).status, 200);
  const from = inDays(10), to = inDays(16);
  assert.equal((await call('PUT', '/api/rates', { unit_ids: [1], from, to: from, price: 650 })).status, 200);
  const cal = await (await call('GET', `/public/calendar?unit=1&from=${from}&to=${to}`)).json();
  assert.equal(cal.days.length, 6);
  assert.deepEqual(cal.days[0], [from, 650, 2, 0]);
  assert.equal(cal.days[1][1], 400);
  // powrót do ceny podstawowej
  await call('PUT', '/api/rates', { unit_ids: [1], from, to: from, price: null });
  assert.equal((await (await call('GET', `/public/calendar?unit=1&from=${from}&to=${to}`)).json()).days[0][1], 400);
  const catalog = await (await call('GET', '/public/catalog')).json();
  assert.equal(catalog[0].units[0].price_from, 400);
  assert.equal(catalog[0].units[1].price_from, null);
  // ukryty domek znika ze strony
  await call('PUT', '/api/rates/unit/2', { base_price: null, min_nights: 1, bookable: false });
  assert.equal((await (await call('GET', '/public/catalog')).json())[0].units.some((u: { id: number }) => u.id === 2), false);
});

test('zapytanie ze strony → akceptacja tworzy rezerwację i wysyła e-maile', async () => {
  const { call, login, sent, db } = setupWithMail();
  await login();
  await call('PUT', '/api/rates/unit/1', { base_price: 500, min_nights: 1 });
  const body = { unit_id: 1, check_in: inDays(20), check_out: inDays(23), name: 'Jan Kowalski', phone: '+48 600 100 200', email: 'Jan@Example.com', adults: 2, children: 1, message: 'Przyjedziemy z psem', consent: true };
  const res = await call('POST', '/public/requests', body, { 'x-client-ip': '1.1.1.1' });
  assert.equal(res.status, 201);
  const { id, quoted_price } = await res.json();
  assert.equal(quoted_price, 1500);
  await flush();
  assert.deepEqual(sent.map((m) => m.to[0]).sort(), ['jan@example.com', 'wlasciciel@x.pl']);
  assert.match(sent.find((m) => m.to[0] === 'wlasciciel@x.pl')!.text, /Jan Kowalski/);

  const pending = await (await call('GET', '/api/requests?status=pending')).json();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].unit_name, 'Mały domek 1');

  const acc = await call('POST', `/api/requests/${id}/accept`, { note: 'Zaliczka 30% na konto' });
  assert.equal(acc.status, 200);
  const out = await acc.json();
  assert.equal(out.reservation.source, 'website');
  assert.equal(out.reservation.price, 1500);
  assert.equal(out.emailed, true);
  assert.match(sent.at(-1)!.text, /Zaliczka 30%/);
  assert.equal((await call('POST', `/api/requests/${id}/accept`)).status, 400); // już rozpatrzone

  // termin jest teraz zajęty — kolejne zapytanie odrzucone od razu
  const again = await call('POST', '/public/requests', body, { 'x-client-ip': '1.1.1.2' });
  assert.equal(again.status, 409);
  const cal = await (await call('GET', `/public/calendar?unit=1&from=${inDays(20)}&to=${inDays(24)}`)).json();
  assert.deepEqual(cal.days.map((d: unknown[]) => d[3]), [1, 1, 1, 0]);
  // dane gości nie wyciekają na stronę
  assert.equal(JSON.stringify(cal).includes('Kowalski'), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE source = 'website'").get() as { n: number }).n, 1);
});

test('odrzucenie zapytania, walidacja i ochrona przed spamem', async () => {
  const { call, login, sent } = setupWithMail();
  await login();
  const base = { unit_id: 1, check_in: inDays(5), check_out: inDays(7), name: 'Anna Nowak', phone: '600 100 200', email: 'anna@example.com', adults: 2, consent: true };
  assert.equal((await call('POST', '/public/requests', { ...base, email: 'zly-adres' })).status, 400);
  assert.equal((await call('POST', '/public/requests', { ...base, phone: '' }, { 'x-client-ip': '2.2.9.1' })).status, 400, 'telefon jest obowiązkowy');
  assert.equal((await call('POST', '/public/requests', { ...base, name: 'Anna' }, { 'x-client-ip': '2.2.9.1' })).status, 400, 'imię i nazwisko');
  assert.equal((await call('POST', '/public/requests', { ...base, consent: false })).status, 400);
  assert.equal((await call('POST', '/public/requests', { ...base, adults: 20 })).status, 400);
  assert.equal((await call('POST', '/public/requests', { ...base, check_in: inDays(-3) })).status, 400);
  // pole-pułapka: udany wynik, ale nic nie zapisane
  const bot = await call('POST', '/public/requests', { ...base, website: 'http://spam' });
  assert.equal((await bot.json()).id, 0);
  // minimalny pobyt
  await call('PUT', '/api/rates', { unit_ids: [1], from: inDays(5), to: inDays(5), min_nights: 3 });
  assert.equal((await call('POST', '/public/requests', base, { 'x-client-ip': '2.2.2.2' })).status, 409);
  await call('PUT', '/api/rates', { unit_ids: [1], from: inDays(5), to: inDays(5), min_nights: null });

  const ok = await call('POST', '/public/requests', base, { 'x-client-ip': '2.2.2.2' });
  assert.equal(ok.status, 201);
  const { id } = await ok.json();
  await flush();
  const rej = await (await call('POST', `/api/requests/${id}/reject`, { note: 'Termin zarezerwowany telefonicznie' })).json();
  assert.equal(rej.request.status, 'rejected');
  assert.match(sent.at(-1)!.text, /zarezerwowany telefonicznie/);
  assert.equal((await (await call('GET', '/api/requests?status=pending')).json()).length, 0);

  // limit na adres IP
  for (let i = 0; i < 3; i++) await call('POST', '/public/requests', { ...base, unit_id: 2 }, { 'x-client-ip': '2.2.2.2' });
  assert.equal((await call('POST', '/public/requests', { ...base, unit_id: 3 }, { 'x-client-ip': '2.2.2.2' })).status, 429);
});

test('ustawienia e-mail i konto podglądu', async () => {
  const { call, login, db } = setupWithMail();
  await login();
  assert.equal((await call('PUT', '/api/settings/email', { emails: 'nie-email' })).status, 400);
  const saved = await (await call('PUT', '/api/settings/email', { emails: 'a@x.pl; b@y.pl' })).json();
  assert.equal(saved.emails, 'a@x.pl, b@y.pl');
  assert.equal((await call('POST', '/api/settings/email/test')).status, 200);
  db.prepare("UPDATE users SET role = 'viewer'").run();
  assert.equal((await call('PUT', '/api/rates', { unit_ids: [1], from: inDays(1), to: inDays(2), price: 1 })).status, 403);
  assert.equal((await call('GET', '/api/requests')).status, 200);
});

test('ceny wg dni tygodnia, pierwszeństwo ceny na dzień i horyzont rezerwacji', async () => {
  const { call, login } = setupWithMail();
  await login();
  // 300 zł w tygodniu, 600 zł w piątek i sobotę (0 = niedziela … 6 = sobota)
  const res = await call('PUT', '/api/rates/unit/1', { base_price: 300, min_nights: 1, weekday_prices: [null, null, null, null, null, 600, 600] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).weekday_prices, '[null,null,null,null,null,600,600]');
  const from = inDays(7), to = inDays(21);
  const cal = await (await call('GET', `/public/calendar?unit=1&from=${from}&to=${to}`)).json();
  for (const [d, price] of cal.days) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    assert.equal(price, dow === 5 || dow === 6 ? 600 : 300, d);
  }
  // cena ustawiona na konkretny dzień wygrywa z ceną dnia tygodnia
  const friday = cal.days.find(([d]: [string]) => new Date(`${d}T12:00:00Z`).getUTCDay() === 5)[0];
  await call('PUT', '/api/rates', { unit_ids: [1], from: friday, to: friday, price: 999 });
  const again = await (await call('GET', `/public/calendar?unit=1&from=${friday}&to=${inDays(30)}`)).json();
  assert.equal(again.days[0][1], 999);
  // wyczyszczenie cen dni tygodnia
  await call('PUT', '/api/rates/unit/1', { base_price: 300, min_nights: 1, weekday_prices: [] });
  assert.equal((await (await call('GET', `/public/calendar?unit=1&from=${inDays(7)}&to=${inDays(14)}`)).json()).days.every((d: unknown[]) => d[1] === 300 || d[1] === 999), true);

  // horyzont: domyślnie 365 dni, po zmianie na 30 kalendarz kończy się po 30 dniach, a dalsze zapytania są odrzucane
  assert.equal((await (await call('GET', '/api/settings/booking')).json()).horizon_days, 365);
  assert.equal((await call('PUT', '/api/settings/booking', { horizon_days: 3 })).status, 400);
  assert.equal((await (await call('PUT', '/api/settings/booking', { horizon_days: 30 })).json()).horizon_days, 30);
  const short = await (await call('GET', `/public/calendar?unit=1&from=${inDays(0)}&to=${inDays(200)}`)).json();
  assert.equal(short.to, inDays(30));
  const late = await call('POST', '/public/requests', { unit_id: 1, check_in: inDays(40), check_out: inDays(42), name: 'Jan Nowak', phone: '600 100 200', email: 'jan@example.com', adults: 2, consent: true }, { 'x-client-ip': '3.3.3.3' });
  assert.equal(late.status, 409);
  assert.match((await late.json()).error, /30 dni/);
});

test('opcje płatne: admin ustawia, gość wybiera, cena dolicza się do wyceny i e-maili', async () => {
  const { call, login, sent } = setupWithMail();
  await login();
  await call('PUT', '/api/rates/unit/1', { base_price: 300, min_nights: 1 });
  assert.equal((await call('POST', '/api/extras', { name: '', price: 10 })).status, 400);
  const parking = await (await call('POST', '/api/extras', { name: 'Parking', name_en: 'Parking', price: 40, per: 'night', max_qty: 2 })).json();
  const pet = await (await call('POST', '/api/extras', { name: 'Zwierzę', name_en: 'Pet', price: 100, per: 'stay' })).json();
  // opcja tylko dla Sopotu — nie pojawia się przy Jantarze
  await call('POST', '/api/extras', { name: 'Sauna', price: 50, per: 'stay', property_ids: [2] });
  const hidden = await (await call('POST', '/api/extras', { name: 'Stara opcja', price: 5, active: false })).json();
  const catalog = await (await call('GET', '/public/catalog')).json();
  assert.deepEqual(catalog[0].extras.map((e: { name: string }) => e.name), ['Parking', 'Zwierzę']);
  assert.equal(catalog.find((p: { name: string }) => p.name === 'Apartament Sopot').extras.length, 3);

  const res = await call('POST', '/public/requests', {
    unit_id: 1, check_in: inDays(10), check_out: inDays(13), name: 'Ola Kowal', phone: '600 100 200', email: 'ola@example.com', adults: 2, consent: true,
    extras: [{ id: parking.id, qty: 5 }, { id: pet.id, qty: 1 }, { id: hidden.id, qty: 1 }, { id: 9999, qty: 1 }],
  }, { 'x-client-ip': '4.4.4.4' });
  const body = await res.json();
  // 3 noce × 300 + parking 2 szt. (maks.) × 40 × 3 noce + zwierzę 100
  assert.equal(body.extras_total, 340);
  assert.equal(body.quoted_price, 900 + 340);
  await flush();
  assert.match(sent.find((m) => m.to[0] === 'wlasciciel@x.pl')!.text, /Parking × 2/);

  const out = await (await call('POST', `/api/requests/${body.id}/accept`, {})).json();
  assert.equal(out.reservation.price, 1240);
  assert.match(out.reservation.notes, /Opcje dodatkowe: Parking × 2/);

  // edycja i usuwanie
  assert.equal((await (await call('PUT', `/api/extras/${pet.id}`, { name: 'Pies', price: 120, per: 'stay' })).json()).price, 120);
  assert.equal((await call('DELETE', `/api/extras/${pet.id}`)).status, 200);
  assert.equal((await (await call('GET', '/api/extras')).json()).length, 3);
});

test('typy domków: strona widzi typ, zapytanie dostaje wolny domek, admin przydziela automatycznie lub ręcznie', async () => {
  const { call, login, db } = setupWithMail();
  await login();
  // Jantar: 3 małe (id 1–3) i 2 duże (id 4–5)
  for (const id of [1, 2, 3]) await call('PUT', `/api/rates/unit/${id}`, { base_price: 400, min_nights: 1, type_name: 'Mały domek' });
  // cena dla jednego domku typu zmienia ceny wszystkich trzech (osobno się nie da)
  await call('PUT', '/api/rates/unit/2', { base_price: 350, min_nights: 1 });
  assert.deepEqual((db.prepare('SELECT base_price FROM units WHERE id IN (1, 2, 3)').all() as { base_price: number }[]).map((u) => u.base_price), [350, 350, 350]);
  await call('PUT', '/api/rates/unit/2', { base_price: 400, min_nights: 1 });
  await call('PUT', '/api/rates', { unit_ids: [3], from: inDays(60), to: inDays(61), price: 999 });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM rates WHERE price = 999').get() as { n: number }).n, 6, 'ceny na dni dla całego typu');
  const jantar = (await (await call('GET', '/public/catalog')).json())[0];
  const small = jantar.types.find((t: { name: string }) => t.name === 'Mały domek');
  assert.deepEqual(small.unit_ids, [1, 2, 3]);
  assert.equal(small.count, 3);
  assert.equal(small.price_from, 400);
  assert.equal(jantar.types.filter((t: { count: number }) => t.count === 1).length, 2); // duże bez typu — osobno

  // domki 2 i 3 zajęte w tym terminie → wolny tylko 1
  const [a, b] = [inDays(15), inDays(18)];
  for (const id of [2, 3]) db.prepare('INSERT INTO reservations (unit_id, check_in, check_out) VALUES (?, ?, ?)').run(id, a, b);
  const cal = await (await call('GET', `/public/calendar?units=1,2,3&from=${a}&to=${b}`)).json();
  assert.deepEqual(cal.unit_ids, [1, 2, 3]);
  assert.deepEqual(cal.days[0][3], 0b110); // bit 1 i 2 = zajęte
  const req = async (ip: string) => (await call('POST', '/public/requests', {
    unit_ids: [1, 2, 3], check_in: a, check_out: b, name: 'Grupa Test', phone: '600 100 200', email: 'g@example.com', adults: 2, consent: true,
  }, { 'x-client-ip': ip })).json();
  const r1 = await req('5.5.5.1');
  assert.equal(r1.quoted_price, 1200); // jedyny wolny: domek 1 (3 × 400)
  let pending = (await (await call('GET', '/api/requests?status=pending')).json())[0];
  assert.equal(pending.unit_id, 1);
  assert.deepEqual(pending.group_units.map((u: { id: number; free: boolean }) => [u.id, u.free]), [[1, true], [2, false], [3, false]]);

  // wszystkie zajęte → zapytanie odrzucone od razu
  db.prepare('INSERT INTO reservations (unit_id, check_in, check_out) VALUES (1, ?, ?)').run(inDays(30), inDays(32));
  for (const id of [2, 3]) db.prepare('INSERT INTO reservations (unit_id, check_in, check_out) VALUES (?, ?, ?)').run(id, inDays(30), inDays(32));
  assert.equal((await call('POST', '/public/requests', { unit_ids: [1, 2, 3], check_in: inDays(30), check_out: inDays(32), name: 'Ktoś Nowy', phone: '600 100 200', email: 'k@example.com', adults: 2, consent: true }, { 'x-client-ip': '5.5.5.2' })).status, 409);

  // admin wybiera domek spoza grupy → błąd; ręcznie wybrany domek 1 → OK
  assert.equal((await call('POST', `/api/requests/${r1.id}/accept`, { unit_id: 4 })).status, 400);
  // tryb ręczny: bez wyboru nie da się zaakceptować
  await call('PUT', '/api/settings/booking', { assign_mode: 'manual' });
  assert.equal((await call('POST', `/api/requests/${r1.id}/accept`, {})).status, 400);
  const acc = await (await call('POST', `/api/requests/${r1.id}/accept`, { unit_id: 1 })).json();
  assert.equal(acc.reservation.unit_id, 1);

  // tryb automatyczny: proponowany domek zajęty w międzyczasie → wybierany inny wolny
  await call('PUT', '/api/settings/booking', { assign_mode: 'auto' });
  const [c1, c2] = [inDays(40), inDays(42)];
  const r2 = await (await call('POST', '/public/requests', { unit_ids: [1, 2, 3], check_in: c1, check_out: c2, name: 'Auto Test', phone: '600 100 200', email: 'a@example.com', adults: 2, consent: true }, { 'x-client-ip': '5.5.5.3' })).json();
  pending = (await (await call('GET', '/api/requests?status=pending')).json()).find((x: { id: number }) => x.id === r2.id);
  assert.equal(pending.unit_id, 1); // pierwszy wg kolejności
  db.prepare('INSERT INTO reservations (unit_id, check_in, check_out) VALUES (1, ?, ?)').run(c1, c2);
  const auto = await (await call('POST', `/api/requests/${r2.id}/accept`, {})).json();
  assert.equal(auto.reservation.unit_id, 2);
});

test('obiekt zamknięty: w terminie (dni zajęte) i do odwołania (komunikat, brak zapytań)', async () => {
  const { call, login } = setupWithMail();
  await login();
  await call('PUT', '/api/rates/unit/1', { base_price: 400, min_nights: 1 });
  const [from, to] = [inDays(10), inDays(12)]; // zamknięte noce 10, 11, 12
  assert.equal((await call('PUT', '/api/rates/property/1/closure', { closed: true, from: to, to: from })).status, 400);
  await call('PUT', '/api/rates/property/1/closure', { closed: true, from, to, note: 'Remont basenu', note_en: 'Pool renovation' });
  const cat = (await (await call('GET', '/public/catalog')).json())[0];
  assert.deepEqual(cat.closed, { from, to, note: 'Remont basenu', note_en: 'Pool renovation' });
  const cal = await (await call('GET', `/public/calendar?unit=1&from=${inDays(9)}&to=${inDays(14)}`)).json();
  assert.deepEqual(cal.days.map((d: unknown[]) => d[3]), [0, 1, 1, 1, 0]);
  const ask = (a: string, b: string, ip: string) => call('POST', '/public/requests', { unit_id: 1, check_in: a, check_out: b, name: 'Jan Test', phone: '600 100 200', email: 'j@example.com', adults: 2, consent: true }, { 'x-client-ip': ip });
  const blocked = await ask(inDays(11), inDays(14), '6.6.6.1');
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /zamknięty/);
  assert.equal((await ask(inDays(13), inDays(15), '6.6.6.2')).status, 201); // po zamknięciu — OK

  // do odwołania: wszystkie dni zamknięte
  await call('PUT', '/api/rates/property/1/closure', { closed: true, note: 'Zapraszamy od maja' });
  assert.deepEqual((await (await call('GET', '/public/catalog')).json())[0].closed, { from: null, to: null, note: 'Zapraszamy od maja', note_en: 'Zapraszamy od maja' });
  assert.equal((await ask(inDays(50), inDays(52), '6.6.6.3')).status, 409);
  // otwarcie
  await call('PUT', '/api/rates/property/1/closure', { closed: false });
  assert.equal((await (await call('GET', '/public/catalog')).json())[0].closed, null);
  assert.equal((await ask(inDays(50), inDays(52), '6.6.6.4')).status, 201);
});

test('zapytanie z minioną datą przyjazdu trafia do archiwum', async () => {
  const { call, login, db } = setupWithMail();
  await login();
  const ok = await (await call('POST', '/public/requests', { unit_id: 1, check_in: inDays(5), check_out: inDays(7), name: 'Stary Termin', phone: '600 100 200', email: 's@example.com', adults: 2, consent: true }, { 'x-client-ip': '7.7.7.1' })).json();
  assert.equal((await (await call('GET', '/api/requests?status=pending')).json()).length, 1);
  // data przyjazdu minęła (symulacja: przesuwamy zapytanie w przeszłość)
  db.prepare('UPDATE booking_requests SET check_in = ?, check_out = ? WHERE id = ?').run(inDays(-3), inDays(-1), ok.id);
  assert.equal((await (await call('GET', '/api/requests?status=pending')).json()).length, 0);
  const archived = await (await call('GET', '/api/requests?status=decided')).json();
  assert.equal(archived.length, 1);
  assert.ok(archived[0].expired_at);
  assert.equal((await call('POST', `/api/requests/${ok.id}/accept`, {})).status, 400);
});

test('prośba o anulację: link w e-mailu, prośba gościa, potwierdzenie lub odrzucenie przez admina', async () => {
  const { call, login, sent, app } = setupWithMail();
  await login();
  await call('PUT', '/api/rates/unit/1', { base_price: 400, min_nights: 1 });
  const book = async (from: number, ip: string) => {
    const r = await (await call('POST', '/public/requests', { unit_id: 1, check_in: inDays(from), check_out: inDays(from + 2), name: 'Ewa Lis', phone: '600 100 200', email: 'ewa@example.com', adults: 2, consent: true }, { 'x-client-ip': ip })).json();
    await call('POST', `/api/requests/${r.id}/accept`, {});
    const mail = sent.at(-1)!;
    const token = mail.text.match(/anulacja\/\?t=([a-f0-9]{48})/)?.[1];
    assert.ok(token, 'link anulacji w e-mailu z potwierdzeniem');
    return { id: r.id as number, token: token! };
  };
  const pub = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', 'x-client-ip': '8.8.8.8' }, body: body ? JSON.stringify(body) : undefined });

  const a = await book(10, '8.1.1.1');
  assert.equal((await pub('GET', '/public/cancel?t=' + 'f'.repeat(48))).status, 404);
  const info = await (await pub('GET', `/public/cancel?t=${a.token}`)).json();
  assert.equal(info.state, 'active');
  assert.equal(info.guest, 'Ewa');
  assert.equal(JSON.stringify(info).includes('ewa@example.com'), false);
  assert.equal((await pub('POST', '/public/cancel', { t: a.token, reason: 'Choroba w rodzinie' })).status, 200);
  await flush();
  assert.match(sent.find((m) => m.to[0] === 'wlasciciel@x.pl' && /Prośba o anulację/.test(m.subject))!.text, /Choroba w rodzinie/);
  assert.equal((await (await call('GET', '/api/cancellations')).json()).length, 1);
  assert.equal((await (await call('POST', `/api/requests/${a.id}/cancel-confirm`, { note: 'Zwrot zaliczki w 7 dni' })).json()).ok, true);
  assert.match(sent.at(-1)!.text, /Zwrot zaliczki w 7 dni/);
  assert.equal((await (await pub('GET', `/public/cancel?t=${a.token}`)).json()).state, 'cancelled');
  assert.equal((await (await call('GET', '/api/cancellations')).json()).length, 0);
  // termin znowu wolny na stronie
  assert.equal((await (await call('GET', `/public/calendar?unit=1&from=${inDays(10)}&to=${inDays(11)}`)).json()).days[0][3], 0);

  // odrzucenie prośby — rezerwacja zostaje
  const b = await book(20, '8.1.1.2');
  await pub('POST', '/public/cancel', { t: b.token });
  await call('POST', `/api/requests/${b.id}/cancel-decline`, { note: 'Zaliczka bezzwrotna' });
  assert.equal((await (await pub('GET', `/public/cancel?t=${b.token}`)).json()).state, 'active');
  assert.equal((await call('POST', `/api/requests/${b.id}/cancel-decline`, {})).status, 400);
});

test('angielska nazwa typu domku: katalog i e-mail do gościa ze strony EN', async () => {
  const { call, login, sent } = setupWithMail();
  await login();
  for (const id of [1, 2]) await call('PUT', `/api/rates/unit/${id}`, { base_price: 400, min_nights: 1, type_name: 'Mały domek', type_name_en: 'Small cottage' });
  const t = (await (await call('GET', '/public/catalog')).json())[0].types.find((x: { count: number }) => x.count === 2);
  assert.equal(t.name, 'Mały domek');
  assert.equal(t.name_en, 'Small cottage');
  await call('POST', '/public/requests', { unit_ids: [1, 2], check_in: inDays(10), check_out: inDays(12), name: 'John Smith', phone: '600 100 200', email: 'john@example.com', adults: 2, consent: true, lang: 'en' }, { 'x-client-ip': '9.1.1.1' });
  await flush();
  const guest = sent.find((m) => m.to[0] === 'john@example.com')!;
  assert.match(guest.text, /Small cottage/);
  assert.doesNotMatch(guest.text, /Mały domek/);
});

test('oferta cenowa do zapytania: e-mail z linkiem, akceptacja gościa z obowiązkiem zapłaty, rezerwacja z zaliczką', async () => {
  const { db, call, login, sent } = setupWithMail();
  await login();
  await call('PUT', '/api/settings/payments', { account_number: '12 3456 7890', account_name: 'Jan Kowalski', deposit_percent: 30, deposit_days: 3, offer_days: 3, terms: 'Zaliczka bezzwrotna.' });
  const { id } = await (await call('POST', '/public/requests', { unit_id: 1, check_in: inDays(20), check_out: inDays(23), name: 'Ewa Nowak', phone: '600 100 200', email: 'ewa@example.com', adults: 2, consent: true }, { 'x-client-ip': '8.8.8.1' })).json();
  await flush();
  assert.equal((await call('POST', `/api/requests/${id}/offers`, { price: 0 })).status, 400);
  assert.equal((await call('POST', `/api/requests/${id}/offers`, { price: 1000, deposit: 2000 })).status, 400);
  const made = await (await call('POST', `/api/requests/${id}/offers`, { price: 1350, deposit: 400, deposit_due: inDays(5), message: 'Cena ze zniżką za 3 noce' })).json();
  assert.equal(made.emailed, true);
  assert.match(made.offer.url, /\/oferta\/\?t=[a-f0-9]{48}$/);
  const mail = sent.at(-1)!;
  assert.deepEqual(mail.to, ['ewa@example.com']);
  assert.match(mail.text, /1350 zł/);
  assert.match(mail.text, /zobowiązujesz się do zapłaty/);
  assert.match(mail.text, new RegExp(made.offer.url.replace(/[?]/g, '\\?')));
  // lista zapytań pokazuje ofertę
  const list = await (await call('GET', '/api/requests?status=pending')).json();
  assert.equal(list[0].offer.status, 'sent');

  const t = made.offer.url.split('t=')[1];
  const view = await (await call('GET', `/public/offer?t=${t}`)).json();
  assert.equal(view.state, 'open');
  assert.equal(view.price, 1350);
  assert.equal(view.payment, null, 'konto dopiero po akceptacji');
  assert.equal(view.terms, 'Zaliczka bezzwrotna.');
  assert.equal((await call('POST', '/public/offer', { t, action: 'accept' }, { 'x-client-ip': '8.8.8.2' })).status, 400, 'bez zgody');
  const acc = await (await call('POST', '/public/offer', { t, action: 'accept', consent: true }, { 'x-client-ip': '8.8.8.2' })).json();
  assert.equal(acc.state, 'accepted');
  assert.equal(acc.payment.account_number, '12 3456 7890');
  await flush();
  const res = db.prepare("SELECT * FROM reservations WHERE source = 'website'").get() as Record<string, unknown>;
  assert.equal(res.price, 1350);
  assert.equal(res.deposit, 400);
  assert.match(res.notes as string, /zaakceptował ofertę 1350 zł .* z obowiązkiem zapłaty: .*IP 8\.8\.8\.2/);
  assert.equal((db.prepare('SELECT status FROM booking_requests WHERE id = ?').get(id) as { status: string }).status, 'accepted');
  const guestMail = sent.find((m) => m.to[0] === 'ewa@example.com' && /Rezerwacja potwierdzona/.test(m.subject))!;
  assert.match(guestMail.text, /12 3456 7890/);
  assert.match(guestMail.text, /anulacja\/\?t=/);
  assert.ok(sent.some((m) => m.to[0] === 'wlasciciel@x.pl' && /zaakceptował ofertę/.test(m.subject)));
  // ponowne kliknięcie nic nie psuje
  assert.equal((await (await call('POST', '/public/offer', { t, action: 'accept', consent: true }, { 'x-client-ip': '8.8.8.2' })).json()).state, 'accepted');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM reservations").get() as { n: number }).n, 1);
});

test('oferta: odrzucenie przez gościa, wycofanie, nowa oferta unieważnia poprzednią', async () => {
  const { db, call, login, sent } = setupWithMail();
  await login();
  const { id } = await (await call('POST', '/public/requests', { unit_id: 1, check_in: inDays(30), check_out: inDays(32), name: 'Adam Lis', phone: '600 100 200', email: 'adam@example.com', adults: 2, consent: true, lang: 'en' }, { 'x-client-ip': '8.8.9.1' })).json();
  const first = await (await call('POST', `/api/requests/${id}/offers`, { price: 900 })).json();
  assert.match(first.offer.url, /\/en\/offer\//);
  assert.match(sent.at(-1)!.text, /View and accept the offer/);
  const second = await (await call('POST', `/api/requests/${id}/offers`, { price: 850, email: false })).json();
  assert.equal(second.emailed, false);
  const t1 = first.offer.url.split('t=')[1], t2 = second.offer.url.split('t=')[1];
  assert.equal((await (await call('GET', `/public/offer?t=${t1}`)).json()).state, 'withdrawn');
  const dec = await (await call('POST', '/public/offer', { t: t2, action: 'decline', reason: 'Too expensive', lang: 'en' }, { 'x-client-ip': '8.8.9.2' })).json();
  assert.equal(dec.state, 'declined');
  await flush();
  assert.ok(sent.some((m) => /odrzucił ofertę/.test(m.subject)));
  assert.equal((db.prepare('SELECT status FROM booking_requests WHERE id = ?').get(id) as { status: string }).status, 'pending', 'zapytanie czeka na decyzję admina');
  // wycofanie
  const third = await (await call('POST', `/api/requests/${id}/offers`, { price: 800, email: false })).json();
  assert.equal((await (await call('POST', `/api/offers/${third.offer.id}/withdraw`)).json()).status, 'withdrawn');
  assert.equal((await call('POST', '/public/offer', { t: third.offer.url.split('t=')[1], action: 'accept', consent: true })).status, 400);
  // odrzucenie zapytania unieważnia oferty
  const fourth = await (await call('POST', `/api/requests/${id}/offers`, { price: 800, email: false })).json();
  await call('POST', `/api/requests/${id}/reject`, { email: false });
  assert.equal((await (await call('GET', `/public/offer?t=${fourth.offer.url.split('t=')[1]}`)).json()).state, 'withdrawn');
});

test('rezerwacja z kalendarza: oferta do akceptacji, prośba o zaliczkę, potwierdzenie wpłaty, historia', async () => {
  const { call, login, sent } = setupWithMail();
  await login();
  await call('PUT', '/api/settings/payments', { account_number: '98 7654', account_name: 'Od Morza do Gór', deposit_percent: 30 });
  const r = await (await call('POST', '/api/reservations', { unit_id: 2, check_in: inDays(40), check_out: inDays(44), guest_name: 'Piotr Zieliński', guest_phone: '601', guest_email: 'piotr@example.com', price: 2000 })).json();
  const draft = await (await call('GET', `/api/reservations/${r.id}/messages/draft?kind=deposit`)).json();
  assert.equal(draft.amount, 600);
  assert.match(draft.body, /600 zł/);
  const prev = await (await call('POST', `/api/reservations/${r.id}/messages/preview`, { kind: 'deposit', amount: 500, due: inDays(10) })).json();
  assert.match(prev.html, /98 7654/);
  const sentDep = await (await call('POST', `/api/reservations/${r.id}/messages`, { kind: 'deposit', amount: 500, due: inDays(10), body: 'Prosimy o zaliczkę 500 zł.' })).json();
  assert.equal(sentDep.reservation.deposit, 500);
  assert.match(sent.at(-1)!.text, /Prosimy o zaliczkę 500 zł\./);
  assert.match(sent.at(-1)!.text, /Numer konta: 98 7654/);
  assert.equal((await call('POST', `/api/reservations/${r.id}/messages`, { kind: 'custom', body: '' })).status, 400);
  await call('POST', `/api/reservations/${r.id}/messages`, { kind: 'custom', subject: 'Kod do domku', body: 'Kod do skrzynki: 1234' });
  assert.equal(sent.at(-1)!.subject, 'Kod do domku');
  // oferta do istniejącej rezerwacji (np. umówionej telefonicznie)
  const of = await (await call('POST', `/api/reservations/${r.id}/offers`, { price: 1900, deposit: 500 })).json();
  const acc = await (await call('POST', '/public/offer', { t: of.offer.url.split('t=')[1], action: 'accept', consent: true }, { 'x-client-ip': '8.8.7.1' })).json();
  assert.equal(acc.state, 'accepted');
  const after = await (await call('GET', `/api/reservations/${r.id}`)).json();
  assert.equal(after.price, 1900);
  assert.match(after.notes, /zaakceptował ofertę 1900 zł/);
  await flush();
  const act = await (await call('GET', `/api/reservations/${r.id}/activity`)).json();
  assert.equal(act.offers[0].status, 'accepted');
  assert.deepEqual(act.messages.map((m: { kind: string }) => m.kind).sort(), ['custom', 'deposit', 'offer', 'offer_accepted']);
  // bez e-maila gościa
  const noMail = await (await call('POST', '/api/reservations', { unit_id: 3, check_in: inDays(40), check_out: inDays(42), guest_name: 'Bez Maila' })).json();
  assert.equal((await call('POST', `/api/reservations/${noMail.id}/messages`, { kind: 'confirmation' })).status, 400);
  const linkOnly = await call('POST', `/api/reservations/${noMail.id}/offers`, { price: 500, email: false });
  assert.equal(linkOnly.status, 201, 'link do wysłania SMS-em');
});

test('rachunki: szablon z ostatnich danych, numeracja, PDF A4, wysyłka e-mailem z załącznikiem', async () => {
  const { call, login, sent } = setupWithMail();
  await login();
  const r = await (await call('POST', '/api/reservations', { unit_id: 1, check_in: '2026-07-01', check_out: '2026-07-05', guest_name: 'Anna Kowal', guest_email: 'anna@example.com', price: 1600, paid: 1600 })).json();
  const draft = await (await call('GET', `/api/invoices/draft?reservation_id=${r.id}`)).json();
  assert.match(draft.number, /^1\/\d{4}$/);
  assert.equal(draft.buyer.name, 'Anna Kowal');
  assert.equal(draft.items[0].price, 1600);
  assert.match(draft.items[0].name, /4 noce/);
  // wszystkie pola wystawcy opcjonalne — PDF i tak powstaje
  const pdf = await call('POST', '/api/invoices/preview', draft);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = new Uint8Array(await pdf.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  assert.match(new TextDecoder('latin1').decode(bytes), /MediaBox \[0 0 595\.28 841\.89\]/, 'A4');
  const inv = await (await call('POST', '/api/invoices', {
    ...draft, reservation_id: r.id, place: 'Gdańsk', note: 'Zwolnienie z VAT', footer: 'Moja stopka',
    seller: { name: 'Jan Kowalski', address: 'ul. Morska 1', city: '80-001 Gdańsk', nip: '', account: '11 2222' },
  })).json();
  assert.equal(inv.total, 1600);
  // szablon zapamiętany na następny raz
  const next = await (await call('GET', `/api/invoices/draft?reservation_id=${r.id}`)).json();
  assert.equal(next.seller.name, 'Jan Kowalski');
  assert.equal(next.place, 'Gdańsk');
  assert.equal(next.footer, 'Moja stopka');
  assert.match(next.number, /^2\//);
  assert.equal((await call('POST', '/api/invoices', { ...next, number: inv.number, reservation_id: r.id })).status, 400, 'numer zajęty');
  const file = await call('GET', `/api/invoices/${inv.id}/pdf`);
  assert.match(file.headers.get('content-disposition') ?? '', /Rachunek-1-\d{4}\.pdf/);
  const send = await (await call('POST', `/api/invoices/${inv.id}/send`, {})).json();
  assert.equal(send.to, 'anna@example.com');
  const m = sent.at(-1)! as { attachments?: { filename: string; content: Buffer }[] };
  assert.equal(m.attachments?.[0].filename.endsWith('.pdf'), true);
  assert.equal((await (await call('GET', `/api/invoices?reservation_id=${r.id}`)).json()).length, 1);
  await call('PUT', `/api/invoices/${inv.id}`, { ...inv, items: [{ name: 'Nocleg', qty: 4, unit: 'noc', price: 450 }] });
  assert.equal((await (await call('GET', `/api/invoices/${inv.id}`)).json()).total, 1800);
  assert.equal((await call('DELETE', `/api/invoices/${inv.id}`)).status, 200);
});

test('typ domku z listy: dołączenie przejmuje ceny typu, zmiana nazwy dla wszystkich; ceny widoczne do konkretnej daty', async () => {
  const { call, login, db } = setupWithMail();
  await login();
  await call('PUT', '/api/rates/unit/1', { base_price: 400, min_nights: 2, weekday_prices: [null, null, null, null, null, 550, 550], type_name: 'Mały domek', type_name_en: 'Small cottage' });
  await call('PUT', '/api/rates', { unit_ids: [1], from: inDays(10), to: inDays(11), price: 700 });
  await call('PUT', '/api/rates/unit/2', { base_price: 999, min_nights: 1 });
  const joined = await (await call('PUT', '/api/rates/unit/2/type', { type_name: 'mały domek' })).json();
  assert.equal(joined.type_name, 'Mały domek');
  assert.equal(joined.type_name_en, 'Small cottage');
  assert.equal(joined.base_price, 400);
  assert.equal(joined.min_nights, 2);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM rates WHERE unit_id = 2 AND price = 700').get() as { n: number }).n, 2);
  await call('PUT', '/api/rates/unit/3/type', { type_name: 'Duży domek' });
  assert.equal((await call('PUT', '/api/rates/type', { unit_id: 1, type_name: 'Duży domek' })).status, 400, 'nazwa zajęta');
  await call('PUT', '/api/rates/type', { unit_id: 1, type_name: 'Domek mały', type_name_en: 'Small house' });
  assert.deepEqual((db.prepare('SELECT type_name, type_name_en FROM units WHERE id IN (1, 2)').all() as object[]).map((o) => ({ ...o })),
    [{ type_name: 'Domek mały', type_name_en: 'Small house' }, { type_name: 'Domek mały', type_name_en: 'Small house' }]);
  await call('PUT', '/api/rates/unit/2/type', { type_name: '' });
  assert.equal((db.prepare('SELECT type_name FROM units WHERE id = 2').get() as { type_name: string }).type_name, '');

  // ceny na stronie do konkretnej daty (włącznie)
  assert.equal((await call('PUT', '/api/settings/booking', { horizon_until: inDays(-1) })).status, 400);
  const set = await (await call('PUT', '/api/settings/booking', { horizon_until: inDays(20) })).json();
  assert.equal(set.horizon_until, inDays(20));
  assert.equal(set.horizon_last, inDays(20));
  const cal = await (await call('GET', `/public/calendar?unit=1&from=${inDays(0)}&to=${inDays(60)}`)).json();
  assert.equal(cal.days.at(-1)[0], inDays(20));
  // powrót do liczby dni
  const back = await (await call('PUT', '/api/settings/booking', { horizon_days: 90 })).json();
  assert.equal(back.horizon_until, null);
});

test('rachunek: pola na podpisy opcjonalne, podpisy palcem (PNG) w PDF, podpis wystawcy w szablonie', async () => {
  const { call, login } = setupWithMail();
  await login();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const r = await (await call('POST', '/api/reservations', { unit_id: 1, check_in: '2026-08-01', check_out: '2026-08-03', guest_name: 'Ola Nowak', guest_email: 'ola@example.com', price: 800 })).json();
  const draft = await (await call('GET', `/api/invoices/draft?reservation_id=${r.id}`)).json();
  assert.equal(draft.signatures, true, 'domyślnie z polami na podpisy');
  assert.equal(draft.seller_signature, '');
  const inv = await (await call('POST', '/api/invoices', { ...draft, reservation_id: r.id, seller_signature: png, buyer_signature: 'javascript:alert(1)' })).json();
  assert.equal(inv.seller_signature, png);
  assert.equal(inv.buyer_signature, '', 'tylko obraz PNG');
  // podpis gościa złożony później (np. przy wymeldowaniu)
  const signed = await (await call('PUT', `/api/invoices/${inv.id}`, { ...inv, buyer_signature: png, save_template: false })).json();
  assert.equal(signed.buyer_signature, png);
  const pdf = await call('GET', `/api/invoices/${inv.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.match(new TextDecoder('latin1').decode(new Uint8Array(await pdf.arrayBuffer())), /\/Subtype \/Image/, 'podpis jako obraz w PDF');
  // szablon pamięta podpis wystawcy; bez pól na podpisy
  const next = await (await call('GET', `/api/invoices/draft?reservation_id=${r.id}`)).json();
  assert.equal(next.seller_signature, png);
  const plain = await (await call('POST', '/api/invoices', { ...next, reservation_id: r.id, signatures: false, seller_signature: '' })).json();
  assert.equal(plain.signatures, false);
  assert.equal((await call('GET', `/api/invoices/${plain.id}/pdf`)).status, 200);
  assert.equal((await (await call('GET', `/api/invoices/draft?reservation_id=${r.id}`)).json()).signatures, false, 'zapamiętane jako szablon');
});
