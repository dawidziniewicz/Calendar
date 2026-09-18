import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export const newToken = () => randomBytes(24).toString('hex');

function migrate(db: DatabaseSync) {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (user_version < 1) migrateV1(db);
  if (user_version < 2) migrateV2(db);
  if (user_version < 3) migrateV3(db);
  if (user_version < 4) migrateV4(db);
  if (user_version < 5) migrateV5(db);
  if (user_version < 6) migrateV6(db);
  if (user_version < 7) migrateV7(db);
  if (user_version < 8) migrateV8(db);
  if (user_version < 9) migrateV9(db);
}

// Ograniczenie konta do wybranych obiektów: JSON z listą id obiektów, NULL = wszystkie.
function migrateV9(db: DatabaseSync) {
  db.exec(`
    BEGIN;
    ALTER TABLE users ADD COLUMN property_ids TEXT;
    PRAGMA user_version = 9;
    COMMIT;
  `);
}

// Powiadomienia o zmianach w rezerwacjach (włączone domyślnie, każdy może wyłączyć).
function migrateV8(db: DatabaseSync) {
  db.exec(`
    BEGIN;
    ALTER TABLE users ADD COLUMN notify_changes INTEGER NOT NULL DEFAULT 1;
    PRAGMA user_version = 8;
    COMMIT;
  `);
}

// Każdy użytkownik ustawia własną godzinę powiadomienia o przyjazdach.
function migrateV7(db: DatabaseSync) {
  db.exec(`
    BEGIN;
    ALTER TABLE users ADD COLUMN notify_time TEXT NOT NULL DEFAULT '09:00';
    ALTER TABLE users ADD COLUMN notified_on TEXT;
    PRAGMA user_version = 7;
    COMMIT;
  `);
}

// Powiadomienia push: subskrypcje telefonów i ustawienia (klucze VAPID, data ostatniego powiadomienia).
function migrateV6(db: DatabaseSync) {
  db.exec(`
    BEGIN;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE push_subscriptions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    PRAGMA user_version = 6;
    COMMIT;
  `);
}

// Daty rezerwacji z Bookingu zmienione ręcznie — synchronizacja ich nie nadpisuje.
function migrateV5(db: DatabaseSync) {
  db.exec(`
    BEGIN;
    ALTER TABLE reservations ADD COLUMN dates_locked INTEGER NOT NULL DEFAULT 0;
    PRAGMA user_version = 5;
    COMMIT;
  `);
}

// Role: admin (pełny dostęp) i viewer (tylko podgląd).
function migrateV4(db: DatabaseSync) {
  db.exec(`
    BEGIN;
    ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer'));
    PRAGMA user_version = 4;
    COMMIT;
  `);
}

// Odwołania z Bookingu: kiedy synchronizacja anulowała rezerwację i czy już ją przejrzano.
function migrateV3(db: DatabaseSync) {
  db.exec(`
    BEGIN;
    ALTER TABLE reservations ADD COLUMN cancelled_at TEXT;
    ALTER TABLE reservations ADD COLUMN cancel_reviewed INTEGER NOT NULL DEFAULT 0;
    PRAGMA user_version = 3;
    COMMIT;
  `);
}

function migrateV2(db: DatabaseSync) {
  db.exec(`
    BEGIN;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    PRAGMA user_version = 2;
    COMMIT;
  `);
}

function migrateV1(db: DatabaseSync) {
  db.exec(`
    BEGIN;
    CREATE TABLE properties (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE units (
      id INTEGER PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL DEFAULT '#2f7d6d',
      sort INTEGER NOT NULL DEFAULT 0,
      export_token TEXT NOT NULL UNIQUE
    );
    CREATE TABLE feeds (
      id INTEGER PRIMARY KEY,
      unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'booking',
      url TEXT NOT NULL,
      last_sync_at TEXT,
      last_error TEXT
    );
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY,
      unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      source TEXT NOT NULL DEFAULT 'direct',
      feed_id INTEGER REFERENCES feeds(id) ON DELETE SET NULL,
      external_uid TEXT,
      external_summary TEXT,
      guest_name TEXT NOT NULL DEFAULT '',
      guest_phone TEXT NOT NULL DEFAULT '',
      guest_email TEXT NOT NULL DEFAULT '',
      adults INTEGER NOT NULL DEFAULT 0,
      children INTEGER NOT NULL DEFAULT 0,
      price REAL,
      paid REAL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (check_out > check_in)
    );
    CREATE INDEX reservations_unit_dates ON reservations(unit_id, check_in, check_out);
    CREATE UNIQUE INDEX reservations_external ON reservations(feed_id, external_uid) WHERE feed_id IS NOT NULL;
    PRAGMA user_version = 1;
    COMMIT;
  `);
  seed(db);
}

// Obiekty z odmorzadogor.pl — można je potem edytować w Ustawieniach.
function seed(db: DatabaseSync) {
  const data: { name: string; location: string; address: string; units: [string, number, string][] }[] = [
    {
      name: 'Osada Jantar', location: 'Jantar – morze', address: '',
      units: [
        ['Mały domek 1', 8, '#2f7d6d'], ['Mały domek 2', 8, '#3a8f7e'], ['Mały domek 3', 8, '#46a08e'],
        ['Duży domek 1', 11, '#1f6f8b'], ['Duży domek 2', 11, '#2b82a0'],
      ],
    },
    { name: 'Apartament Sopot', location: 'Sopot – morze', address: 'ul. Łokietka 19a/43, Sopot', units: [['Sopot Holiday Sauna', 8, '#8a5a9e']] },
    {
      name: 'Apartamenty Karpatka', location: 'Karpacz – góry', address: 'ul. Myśliwska 34–36, Karpacz',
      units: [['Karpatka 1', 10, '#b5652b'], ['Karpatka 2', 12, '#c77b3f']],
    },
    { name: 'Agroturystyka Karszewo', location: 'Karszewo – Frombork', address: 'Karszewo', units: [['Domek 1', 8, '#5f7f2a'], ['Domek 2', 8, '#76953a']] },
  ];
  const insP = db.prepare('INSERT INTO properties (name, location, address, sort) VALUES (?, ?, ?, ?)');
  const insU = db.prepare('INSERT INTO units (property_id, name, capacity, color, sort, export_token) VALUES (?, ?, ?, ?, ?, ?)');
  data.forEach((p, i) => {
    const { lastInsertRowid } = insP.run(p.name, p.location, p.address, i);
    p.units.forEach(([name, capacity, color], j) => insU.run(lastInsertRowid, name, capacity, color, j, newToken()));
  });
}
