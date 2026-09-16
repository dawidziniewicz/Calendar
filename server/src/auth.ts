import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'kal_session';
export const SESSION_DAYS = 90;

export type Role = 'admin' | 'viewer';
export type User = { id: number; username: string; role: Role };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Porównanie z fikcyjnym hashem, gdy użytkownik nie istnieje — odpowiedź trwa tyle samo.
const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function checkLogin(db: DatabaseSync, username: string, password: string): User | null {
  const row = db.prepare('SELECT id, username, role, password_hash FROM users WHERE username = ?').get(username) as
    { id: number; username: string; role: Role; password_hash: string } | undefined;
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return row && ok ? { id: row.id, username: row.username, role: row.role } : null;
}

export function createSession(db: DatabaseSync, userId: number): string {
  const token = randomBytes(32).toString('hex');
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .run(sha256(token), userId);
  return token;
}

export function sessionUser(db: DatabaseSync, token: string | undefined): User | null {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).get(sha256(token)) as User | undefined;
  return row ?? null;
}

export function deleteSession(db: DatabaseSync, token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function setPassword(db: DatabaseSync, userId: number, password: string) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // wyloguj wszędzie
}

// ---- Ochrona przed zgadywaniem haseł: 5 błędów = blokada na 15 minut (osobno IP i login) ----

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const fails = new Map<string, { count: number; first: number }>();

export function lockedFor(keys: string[]): number {
  const now = Date.now();
  let wait = 0;
  for (const k of keys) {
    const f = fails.get(k);
    if (!f) continue;
    if (now - f.first > LOCK_MS) fails.delete(k);
    else if (f.count >= MAX_FAILS) wait = Math.max(wait, f.first + LOCK_MS - now);
  }
  return wait;
}

export function registerFail(keys: string[]) {
  const now = Date.now();
  for (const k of keys) {
    const f = fails.get(k);
    if (!f || now - f.first > LOCK_MS) fails.set(k, { count: 1, first: now });
    else f.count++;
  }
}

export function clearFails(keys: string[]) {
  for (const k of keys) fails.delete(k);
}
