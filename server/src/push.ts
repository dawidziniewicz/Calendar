import type { DatabaseSync } from 'node:sqlite';
import webpush from 'web-push';
import { allowedUnitIds, propertyIdsOf } from './auth.ts';

// Powiadomienia push (Web Push). Klucze VAPID generujemy przy pierwszym uruchomieniu i trzymamy w bazie.

export type PushSubscriptionJSON = { endpoint: string; keys: { p256dh: string; auth: string } };
export type Sender = (sub: PushSubscriptionJSON, payload: string) => Promise<unknown>;

const TZ = 'Europe/Warsaw';

function setting(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}
function setSetting(db: DatabaseSync, key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function vapidKeys(db: DatabaseSync) {
  let publicKey = setting(db, 'vapid_public');
  let privateKey = setting(db, 'vapid_private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    setSetting(db, 'vapid_public', publicKey);
    setSetting(db, 'vapid_private', privateKey);
  }
  return { publicKey, privateKey };
}

export function webPushSender(db: DatabaseSync): Sender {
  const { publicKey, privateKey } = vapidKeys(db);
  const subject = process.env.VAPID_SUBJECT || 'mailto:kontakt@odmorzadogor.pl';
  return (sub, payload) => webpush.sendNotification(sub, payload, { vapidDetails: { subject, publicKey, privateKey }, TTL: 6 * 3600 });
}

export function saveSubscription(db: DatabaseSync, userId: number, sub: PushSubscriptionJSON) {
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

/** Wysyła do wybranych subskrypcji; martwe (telefon odinstalował / wyłączył) usuwa z bazy. */
export async function sendToSubscriptions(db: DatabaseSync, send: Sender, userId: number | null, message: PushMessage) {
  const rows = (userId == null
    ? db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions').all()
    : db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId)) as
    { id: number; endpoint: string; p256dh: string; auth: string }[];
  const payload = JSON.stringify(message);
  let sent = 0;
  for (const r of rows) {
    try {
      await send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload);
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(r.id);
      else console.warn('Nie udało się wysłać powiadomienia:', status ?? err);
    }
  }
  return sent;
}

export const warsawDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
export const warsawTime = (d = new Date()) => d.toLocaleTimeString('pl-PL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

export type PushMessage = { title: string; body: string; url?: string; tag?: string };

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const nightsPl = (n: number) => (n === 1 ? '1 noc' : `${n} ${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'noce' : 'nocy'}`);

/** Osobne powiadomienie dla każdego dzisiejszego przyjazdu. */
export function arrivalMessages(db: DatabaseSync, date: string, units: Set<number> | null = null): PushMessage[] {
  const rows = db.prepare(`SELECT r.id, r.unit_id, r.guest_name, r.source, r.adults, r.children, r.check_out, u.name AS unit, p.name AS property
    FROM reservations r JOIN units u ON u.id = r.unit_id JOIN properties p ON p.id = u.property_id
    WHERE r.check_in = ? AND r.status != 'cancelled' ORDER BY p.sort, u.sort`).all(date) as
    { id: number; unit_id: number; guest_name: string; source: string; adults: number; children: number; check_out: string; unit: string; property: string }[];
  return rows.filter((r) => !units || units.has(r.unit_id)).map((r) => {
    const who = r.guest_name || (r.source === 'booking' ? 'Gość z Booking.com' : r.source === 'airbnb' ? 'Gość z Airbnb' : 'Gość');
    const nights = Math.round((Date.parse(r.check_out) - Date.parse(date)) / 86_400_000);
    const people = r.adults + r.children ? ` · ${r.adults + r.children} os.` : '';
    return {
      title: `Przyjazd dziś: ${r.unit} · ${r.property}`,
      body: `${who}${people} · ${nightsPl(nights)}, wyjazd ${shortDate(r.check_out)}`,
      url: `/?reservation=${r.id}`,
      tag: `arrival-${r.id}`, // różne tagi → iPhone nie zastępuje jednego powiadomienia drugim
    };
  });
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Wywoływane co minutę: każdemu użytkownikowi z włączonymi powiadomieniami raz dziennie, o jego godzinie,
 * wysyła po jednym powiadomieniu na każdy dzisiejszy przyjazd. Gdy serwer był wtedy wyłączony — nadrabia do 3 godzin później.
 */
export async function dailyArrivalsTick(db: DatabaseSync, send: Sender, now = new Date()) {
  const today = warsawDate(now);
  const nowMin = minutes(warsawTime(now));
  const users = db.prepare(`SELECT DISTINCT u.id, u.notify_time FROM users u JOIN push_subscriptions p ON p.user_id = u.id
    WHERE u.notified_on IS NULL OR u.notified_on != ?`).all(today) as { id: number; notify_time: string }[];
  const due = users.filter((u) => nowMin >= minutes(u.notify_time) && nowMin - minutes(u.notify_time) < 180);
  if (!due.length) return 0;
  let sent = 0;
  for (const u of due) {
    db.prepare('UPDATE users SET notified_on = ? WHERE id = ?').run(today, u.id);
    // każdy dostaje tylko przyjazdy w obiektach, do których ma dostęp
    const messages = arrivalMessages(db, today, allowedUnitIds(db, { properties: propertyIdsOf(db, u.id) }));
    for (const msg of messages) sent += await sendToSubscriptions(db, send, u.id, msg);
  }
  return sent;
}
