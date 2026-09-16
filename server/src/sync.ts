import type { DatabaseSync } from 'node:sqlite';
import { parseIcal } from './ical.ts';

type Feed = { id: number; unit_id: number; source: string; url: string };
export type SyncResult = { feedId: number; unitId: number; ok: boolean; added: number; updated: number; cancelled: number; error?: string };

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });

export async function syncFeed(db: DatabaseSync, feed: Feed): Promise<SyncResult> {
  const result: SyncResult = { feedId: feed.id, unitId: feed.unit_id, ok: false, added: 0, updated: 0, cancelled: 0 };
  try {
    const res = await fetch(feed.url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'kalendarz-odmorzadogor/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (!body.includes('BEGIN:VCALENDAR')) throw new Error('Odpowiedź nie jest plikiem iCal');
    const events = parseIcal(body);

    const find = db.prepare('SELECT id, check_in, check_out, status, cancelled_at, dates_locked FROM reservations WHERE feed_id = ? AND external_uid = ?');
    const insert = db.prepare(`INSERT INTO reservations (unit_id, check_in, check_out, source, feed_id, external_uid, external_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    // Rezerwacja wróciła do kalendarza Bookingu → przywracamy tylko, jeśli to synchronizacja ją anulowała.
    const update = db.prepare(`UPDATE reservations SET
      check_in = CASE WHEN dates_locked = 1 THEN check_in ELSE ? END,
      check_out = CASE WHEN dates_locked = 1 THEN check_out ELSE ? END, external_summary = ?,
      status = CASE WHEN cancelled_at IS NOT NULL THEN 'confirmed' ELSE status END,
      cancelled_at = NULL, cancel_reviewed = 0, updated_at = datetime('now') WHERE id = ?`);

    // Po podmianie linku Booking może nadać inne UID — dopasuj wtedy po datach, zamiast dublować rezerwację.
    const byDates = db.prepare(`SELECT id, external_uid FROM reservations WHERE feed_id = ? AND check_in = ? AND check_out = ?`);
    const rebind = db.prepare('UPDATE reservations SET external_uid = ? WHERE id = ?');

    db.exec('BEGIN');
    try {
      const seen = new Set(events.map((e) => e.uid));
      for (const e of events) {
        let row = find.get(feed.id, e.uid) as { id: number; check_in: string; check_out: string; status: string; cancelled_at: string | null; dates_locked: number } | undefined;
        if (!row) {
          const orphan = (byDates.all(feed.id, e.start, e.end) as { id: number; external_uid: string }[]).find((r) => !seen.has(r.external_uid));
          if (orphan) {
            rebind.run(e.uid, orphan.id);
            row = find.get(feed.id, e.uid) as typeof row;
          }
        }
        if (!row) {
          insert.run(feed.unit_id, e.start, e.end, feed.source, feed.id, e.uid, e.summary);
          result.added++;
        } else if ((!row.dates_locked && (row.check_in !== e.start || row.check_out !== e.end)) || row.cancelled_at) {
          update.run(e.start, e.end, e.summary, row.id);
          result.updated++;
        }
      }
      // Przyszłe rezerwacje, które zniknęły z kalendarza = anulowane. Nie kasujemy — zostają dane gościa.
      const active = db.prepare(`SELECT id, external_uid FROM reservations
        WHERE feed_id = ? AND status != 'cancelled' AND check_in >= ?`).all(feed.id, today()) as { id: number; external_uid: string }[];
      const cancel = db.prepare(`UPDATE reservations SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reviewed = 0,
        updated_at = datetime('now') WHERE id = ?`);
      for (const r of active) {
        if (!seen.has(r.external_uid)) { cancel.run(r.id); result.cancelled++; }
      }
      db.prepare(`UPDATE feeds SET last_sync_at = datetime('now'), last_error = NULL WHERE id = ?`).run(feed.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE feeds SET last_sync_at = datetime('now'), last_error = ? WHERE id = ?`).run(result.error, feed.id);
  }
  return result;
}

export async function syncAll(db: DatabaseSync): Promise<SyncResult[]> {
  const feeds = db.prepare('SELECT id, unit_id, source, url FROM feeds').all() as Feed[];
  const results: SyncResult[] = [];
  for (const f of feeds) results.push(await syncFeed(db, f));
  return results;
}
