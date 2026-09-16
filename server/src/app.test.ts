import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.ts';
import { createApp } from './app.ts';
import { parseIcal } from './ical.ts';
import { syncFeed } from './sync.ts';

const KEY = 'test-key-1234567890';

function setup() {
  const db = openDb(':memory:');
  const app = createApp(db, KEY);
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { db, app, call };
}

test('wymaga klucza API', async () => {
  const { app } = setup();
  assert.equal((await app.request('/api/properties')).status, 401);
});

test('seed zawiera obiekty z odmorzadogor.pl', async () => {
  const { call } = setup();
  const props = await (await call('GET', '/api/properties')).json();
  assert.equal(props.length, 4);
  assert.equal(props.flatMap((p: { units: unknown[] }) => p.units).length, 10);
});

test('wykrywa nakładające się rezerwacje', async () => {
  const { call } = setup();
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
  const { db, call, app } = setup();
  const ev = (uid: string, s: string, e: string) => `BEGIN:VEVENT\nUID:${uid}\nDTSTART;VALUE=DATE:${s}\nDTEND;VALUE=DATE:${e}\nEND:VEVENT\n`;
  let feedBody = `BEGIN:VCALENDAR\n${ev('a', '20300801', '20300805')}${ev('b', '20300810', '20300812')}END:VCALENDAR`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(feedBody)) as typeof fetch;
  try {
    await call('POST', '/api/feeds', { unit_id: 2, url: 'https://example.com/x.ics' });
    const feed = { id: 1, unit_id: 2, source: 'booking', url: 'https://example.com/x.ics' };
    assert.equal((await syncFeed(db, feed)).added, 2);

    const [a] = await (await call('GET', '/api/reservations?from=2030-08-01&to=2030-08-02')).json();
    await call('PUT', `/api/reservations/${a.id}`, { ...a, guest_name: 'Anna Nowak', check_in: '2030-01-01' });

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
