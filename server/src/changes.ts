import type { DatabaseSync } from 'node:sqlite';
import { sendToSubscriptions, type PushMessage, type Sender } from './push.ts';

// Powiadomienia o zmianach: dodanie / edycja / usunięcie rezerwacji przez użytkownika oraz zmiany z Bookingu.

type Row = Record<string, unknown>;
export type SyncChange = { kind: 'added' | 'moved' | 'cancelled' | 'restored'; id: number; oldIn?: string; oldOut?: string };

export type ChangeEvent =
  | { kind: 'created' | 'deleted' | 'converted'; row: Row; by: string }
  | { kind: 'updated'; before: Row; after: Row; by: string }
  | { kind: 'sync'; change: SyncChange; row: Row };

const SOURCE_LABELS: Record<string, string> = { direct: 'Prywatne', booking: 'Booking.com', airbnb: 'Airbnb', other: 'Inne' };
const STATUS_LABELS: Record<string, string> = { confirmed: 'potwierdzona', tentative: 'wstępna', cancelled: 'anulowana' };
const MAX_SEPARATE = 5; // więcej zmian naraz → jedno zbiorcze powiadomienie

const d = (iso: string) => new Date(`${iso}T12:00:00Z`);
const day = (iso: string) => d(iso).getUTCDate();
const month = (iso: string) => d(iso).toLocaleDateString('pl-PL', { month: 'short', timeZone: 'UTC' });

export function dateRange(from: string, to: string) {
  return from.slice(0, 7) === to.slice(0, 7) ? `${day(from)}–${day(to)} ${month(to)}` : `${day(from)} ${month(from)} – ${day(to)} ${month(to)}`;
}

function nights(from: string, to: string) {
  const n = Math.round((d(to).getTime() - d(from).getTime()) / 86_400_000);
  return n === 1 ? '1 noc' : `${n} ${n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'noce' : 'nocy'}`;
}

function unitLabel(db: DatabaseSync, unitId: unknown) {
  const u = db.prepare('SELECT u.name, p.name AS property FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ?').get(unitId as number) as
    { name: string; property: string } | undefined;
  return u ? `${u.name} · ${u.property}` : 'nieznany domek';
}

const who = (r: Row) => (r.guest_name as string) || (r.source === 'direct' ? 'Gość' : `Gość z ${SOURCE_LABELS[r.source as string] ?? r.source}`);
const range = (r: Row) => dateRange(r.check_in as string, r.check_out as string);
const link = (r: Row) => `/?reservation=${r.id}`;

/** Co zmieniło się w edytowanej rezerwacji — czytelna lista po polsku. */
export function describeUpdate(db: DatabaseSync, before: Row, after: Row): string[] {
  const out: string[] = [];
  if (before.unit_id !== after.unit_id) out.push(`domek (było: ${unitLabel(db, before.unit_id).split(' · ')[0]})`);
  if (before.check_in !== after.check_in || before.check_out !== after.check_out) out.push(`daty (było: ${range(before)})`);
  if (before.status !== after.status) out.push(`status: ${STATUS_LABELS[after.status as string] ?? after.status}`);
  if (before.guest_name !== after.guest_name || before.guest_phone !== after.guest_phone || before.guest_email !== after.guest_email) out.push('dane gościa');
  if (before.adults !== after.adults || before.children !== after.children) out.push('liczba osób');
  if (before.price !== after.price) out.push('cena');
  if (before.paid !== after.paid) out.push('wpłata');
  if (before.source !== after.source) out.push(`źródło: ${SOURCE_LABELS[after.source as string] ?? after.source}`);
  if (before.notes !== after.notes) out.push('notatki');
  return out;
}

export function changeMessage(db: DatabaseSync, ev: ChangeEvent): PushMessage | null {
  if (ev.kind === 'updated') {
    const changed = describeUpdate(db, ev.before, ev.after);
    if (!changed.length) return null;
    const cancelled = ev.after.status === 'cancelled' && ev.before.status !== 'cancelled';
    return {
      title: `${cancelled ? 'Anulowana rezerwacja' : 'Zmiana rezerwacji'} · ${unitLabel(db, ev.after.unit_id)}`,
      body: `${who(ev.after)} · ${range(ev.after)}\nZmieniono: ${changed.join(', ')} · ${ev.by}`,
      url: link(ev.after),
      tag: `res-${ev.after.id}`,
    };
  }
  if (ev.kind === 'created') {
    const r = ev.row;
    return {
      title: `Nowa rezerwacja · ${unitLabel(db, r.unit_id)}`,
      body: `${who(r)} · ${range(r)} (${nights(r.check_in as string, r.check_out as string)}) · dodane przez ${ev.by}`,
      url: link(r),
      tag: `res-${r.id}`,
    };
  }
  if (ev.kind === 'deleted') {
    const r = ev.row;
    return { title: `Usunięta rezerwacja · ${unitLabel(db, r.unit_id)}`, body: `${who(r)} · ${range(r)} · usunięte przez ${ev.by}`, url: '/', tag: `res-${r.id}` };
  }
  if (ev.kind === 'converted') {
    const r = ev.row;
    return {
      title: `Zamieniona na prywatną · ${unitLabel(db, r.unit_id)}`,
      body: `${who(r)} · ${range(r)} (była odwołana na Bookingu) · ${ev.by}`,
      url: link(r),
      tag: `res-${r.id}`,
    };
  }
  if (ev.kind !== 'sync') return null;
  const { change: ch, row: r } = ev;
  const src = SOURCE_LABELS[r.source as string] ?? r.source;
  const base = { url: link(r), tag: `res-${r.id}` };
  switch (ch.kind) {
    case 'added':
      return { ...base, title: `Nowa rezerwacja z ${src} · ${unitLabel(db, r.unit_id)}`, body: `${range(r)} (${nights(r.check_in as string, r.check_out as string)})` };
    case 'moved':
      return { ...base, title: `${src}: zmiana terminu · ${unitLabel(db, r.unit_id)}`, body: `${who(r)} · teraz ${range(r)} (było: ${dateRange(ch.oldIn!, ch.oldOut!)})` };
    case 'cancelled':
      return { ...base, title: `Odwołana na ${src} · ${unitLabel(db, r.unit_id)}`, body: `${who(r)} · ${range(r)}` };
    case 'restored':
      return { ...base, title: `Przywrócona na ${src} · ${unitLabel(db, r.unit_id)}`, body: `${who(r)} · ${range(r)}` };
  }
}

/** Zamienia wyniki synchronizacji na zdarzenia (z aktualnymi danymi rezerwacji). */
export function syncEvents(db: DatabaseSync, changes: SyncChange[]): ChangeEvent[] {
  const get = db.prepare('SELECT * FROM reservations WHERE id = ?');
  return changes.flatMap((change) => {
    const row = get.get(change.id) as Row | undefined;
    return row ? [{ kind: 'sync' as const, change, row }] : [];
  });
}

/** Wysyła powiadomienia o zmianach wszystkim chętnym użytkownikom poza autorem zmiany. */
export async function announce(db: DatabaseSync, send: Sender | undefined, events: ChangeEvent[], excludeUserId: number | null) {
  if (!send || !events.length) return 0;
  const messages = events.map((e) => changeMessage(db, e)).filter((m): m is PushMessage => m !== null);
  if (!messages.length) return 0;
  const final = messages.length > MAX_SEPARATE
    ? [{
        title: `Zmiany w rezerwacjach: ${messages.length}`,
        body: messages.slice(0, 3).map((m) => m.title).join('\n') + '\n…',
        url: '/?tab=agenda',
        tag: `changes-${Date.now()}`,
      }]
    : messages;
  const users = db.prepare(`SELECT DISTINCT u.id FROM users u JOIN push_subscriptions p ON p.user_id = u.id
    WHERE u.notify_changes = 1 AND u.id != ?`).all(excludeUserId ?? -1) as { id: number }[];
  let sent = 0;
  for (const u of users) for (const m of final) sent += await sendToSubscriptions(db, send, u.id, m);
  return sent;
}
