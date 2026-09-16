import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { hashPassword } from './auth.ts';
import { createApp } from './app.ts';
import { parseIcal } from './ical.ts';
import { syncFeed } from './sync.ts';
import { dailyArrivalsTick, saveSubscription, type Sender } from './push.ts';

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
  assert.deepEqual(await (await call('GET', '/api/auth/me')).json(), { username: 'dawid', role: 'admin' });
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

test('odwołana na Bookingu → zamiana na rezerwację bezpośrednią', async () => {
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
  assert.deepEqual(await login.json(), { username: 'jan', role: 'viewer' });

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

test('codzienne powiadomienie o przyjazdach: o godzinie każdego użytkownika, raz dziennie, tylko gdy są przyjazdy', async () => {
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
  assert.deepEqual(await (await call('GET', '/api/push/settings')).json(), { time: '09:00' });
  assert.equal((await call('PUT', '/api/push/settings', { time: '25:00' })).status, 400);
  assert.equal((await call('PUT', '/api/push/settings', { time: '10:15' })).status, 200);

  const at = (iso: string) => new Date(iso); // czas UTC; w lipcu Warszawa = UTC+2
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-01T08:00:00Z')), 0); // brak przyjazdów

  await call('POST', '/api/reservations', { unit_id: 1, check_in: '2030-07-02', check_out: '2030-07-05', guest_name: 'Ola', adults: 2, children: 1 });
  await call('POST', '/api/reservations', { unit_id: 7, check_in: '2030-07-02', check_out: '2030-07-04', source: 'booking' });

  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-02T05:00:00Z')), 0); // 7:00 — za wcześnie dla obu
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-02T05:31:00Z')), 1); // 7:31 — Józek
  assert.deepEqual(sent.map((s) => s.endpoint), ['https://push.example/jozek']);
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-02T07:30:00Z')), 0); // 9:30 — Dawid ma 10:15
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-02T08:16:00Z')), 1); // 10:16 — Dawid
  assert.equal(await dailyArrivalsTick(db, send, at('2030-07-02T08:17:00Z')), 0); // już wysłane obu

  const msg = JSON.parse(sent[1].payload);
  assert.equal(msg.title, 'Dziś przyjazdy: 2');
  assert.match(msg.body, /Mały domek 1: Ola \(3 os\.\)/);
  assert.match(msg.body, /Karpatka 1: Booking\.com/);
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
