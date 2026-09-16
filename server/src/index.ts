import { serve } from '@hono/node-server';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from './db.ts';
import { createApp } from './app.ts';
import { syncAll } from './sync.ts';

const apiKey = process.env.API_KEY ?? '';
if (apiKey.length < 16) {
  console.error('Ustaw zmienną API_KEY (min. 16 znaków), np. wynik: openssl rand -hex 32');
  process.exit(1);
}
const dbPath = process.env.DB_PATH ?? './data/kalendarz.sqlite';
const port = Number(process.env.PORT ?? 8787);
const syncMinutes = Number(process.env.SYNC_INTERVAL_MINUTES ?? 15);

const db = openDb(dbPath);
const app = createApp(db, apiKey);

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => console.log(`API działa na porcie ${info.port}`));

async function runSync() {
  try {
    const results = await syncAll(db);
    const failed = results.filter((r) => !r.ok);
    if (results.length) console.log(`Synchronizacja: ${results.length} kalendarzy, błędy: ${failed.length}`);
    for (const f of failed) console.warn(`  kalendarz #${f.feedId}: ${f.error}`);
  } catch (err) {
    console.error('Synchronizacja nie powiodła się', err);
  }
}

// Codzienna kopia zapasowa bazy (trzymamy 30 ostatnich).
function backup() {
  const dir = join(dirname(dbPath), 'backups');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `kalendarz-${new Date().toISOString().slice(0, 10)}.sqlite`);
  try {
    rmSync(file, { force: true });
    db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    const old = readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort().slice(0, -30);
    for (const f of old) rmSync(join(dir, f));
  } catch (err) {
    console.error('Kopia zapasowa nie powiodła się', err);
  }
}

setTimeout(runSync, 5_000);
setInterval(runSync, Math.max(5, syncMinutes) * 60_000);
backup();
setInterval(backup, 24 * 3600_000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    db.close();
    process.exit(0);
  });
}
