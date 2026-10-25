import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Mail, Mailer } from './mail.ts';

// Poczta w aplikacji: skrzynki rezerwacje@ / kontakt@ / contact@ (odbiór przez Cloudflare Email Worker → /inbound/mail),
// rozmowy (wątki) łączone po nagłówkach In-Reply-To / References albo po adresie i temacie, wysyłka przez Resend/SMTP.

export const MAILBOXES_KEY = 'mail_mailboxes';
export const REPLY_TO_KEY = 'guest_reply_to'; // 'auto' | 'inbox' | 'admin' — dokąd trafiają odpowiedzi gości
export const BRAND = 'Od Morza do Gór';

export const addrOf = (s: string) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim().toLowerCase();
export const nameOf = (s: string) => (s.includes('<') ? s.slice(0, s.indexOf('<')).trim().replace(/^"|"$/g, '') : '');
export const mailDomain = () => addrOf(process.env.MAIL_FROM || 'rezerwacje@odmorzadogor.pl').split('@')[1] ?? 'odmorzadogor.pl';
export const fromHeader = (addr: string) => `${BRAND} <${addr}>`;

export function mailboxes(db: DatabaseSync): string[] {
  const raw = (db.prepare('SELECT value FROM settings WHERE key = ?').get(MAILBOXES_KEY) as { value: string } | undefined)?.value;
  try {
    const list = raw ? (JSON.parse(raw) as unknown[]).map((x) => addrOf(String(x))).filter((x) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(x)) : [];
    if (list.length) return [...new Set(list)];
  } catch { /* domyślne */ }
  const d = mailDomain();
  return [`rezerwacje@${d}`, `kontakt@${d}`, `contact@${d}`];
}

/** Ostatnia wiadomość przychodząca (czy odbiór poczty jest skonfigurowany) */
export const lastInbound = (db: DatabaseSync) =>
  (db.prepare(`SELECT MAX(created_at) AS at FROM mail_messages WHERE direction = 'in'`).get() as { at: string | null }).at;

const normSubject = (s: string) => s.replace(/^\s*((re|odp|fwd?|pd|aw|wg|sv|tr)\s*(\[\d+\])?\s*:\s*)+/i, '').trim().toLowerCase();
const toSqlDate = (v: unknown) => {
  const d = v ? new Date(String(v)) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().replace('T', ' ').slice(0, 19);
};
const snippetOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160);

export type StoredAttachment = { filename: string; content_type: string; content_id?: string; data: Buffer };
export type StoreInput = {
  mailbox: string; direction: 'in' | 'out';
  message_id?: string; in_reply_to?: string; refs?: string[];
  from_addr: string; from_name?: string; to: string[]; cc?: string[]; reply_to?: string;
  subject: string; text: string; html?: string; date?: unknown; is_read?: boolean; sent_by?: string;
  attachments?: StoredAttachment[];
};

/** Zapis wiadomości z przypisaniem do rozmowy. Zwraca null dla duplikatu (ten sam Message-ID w tej skrzynce). */
export function storeMessage(db: DatabaseSync, m: StoreInput): { id: number; thread_id: number } | null {
  const get = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).get(...p);
  const run = (sql: string, ...p: (string | number | null | Uint8Array)[]) => db.prepare(sql).run(...p);
  const mailbox = addrOf(m.mailbox);
  if (m.message_id && get('SELECT 1 FROM mail_messages WHERE message_id = ? AND mailbox = ? AND direction = ?', m.message_id, mailbox, m.direction)) return null;
  const counterpart = m.direction === 'in' ? addrOf(m.reply_to || m.from_addr) : addrOf(m.to[0] ?? '');
  const counterpartName = m.direction === 'in' ? (m.from_name ?? '') : '';

  // 1) odpowiedź na znaną wiadomość (nagłówki), 2) ta sama osoba i temat w ostatnich 60 dniach, 3) nowa rozmowa
  let threadId: number | null = null;
  for (const ref of [m.in_reply_to, ...(m.refs ?? [])].filter(Boolean).reverse() as string[]) {
    const row = get('SELECT thread_id FROM mail_messages WHERE message_id = ? LIMIT 1', ref) as { thread_id: number } | undefined;
    if (row) { threadId = row.thread_id; break; }
  }
  if (!threadId && counterpart) {
    const want = normSubject(m.subject);
    const candidates = db.prepare(`SELECT id, subject FROM mail_threads WHERE counterpart = ? AND mailbox = ? AND last_at >= datetime('now', '-60 days') ORDER BY last_at DESC LIMIT 20`)
      .all(counterpart, mailbox) as { id: number; subject: string }[];
    threadId = candidates.find((t) => normSubject(t.subject) === want)?.id ?? null;
  }
  const date = toSqlDate(m.date);
  if (!threadId) {
    threadId = Number(run(`INSERT INTO mail_threads (mailbox, subject, counterpart, counterpart_name, last_at) VALUES (?, ?, ?, ?, ?)`,
      mailbox, m.subject.slice(0, 300), counterpart, counterpartName.slice(0, 200), date).lastInsertRowid);
  }
  const id = Number(run(`INSERT INTO mail_messages (thread_id, mailbox, direction, message_id, in_reply_to, refs, from_addr, from_name, to_addrs, cc_addrs,
      reply_to, subject, text, html, date, is_read, sent_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    threadId, mailbox, m.direction, m.message_id ?? '', m.in_reply_to ?? '', (m.refs ?? []).join(' '), addrOf(m.from_addr), (m.from_name ?? '').slice(0, 200),
    JSON.stringify(m.to.map(addrOf)), JSON.stringify((m.cc ?? []).map(addrOf)), m.reply_to ?? '', m.subject.slice(0, 500), m.text.slice(0, 200_000),
    (m.html ?? '').slice(0, 1_000_000), date, m.is_read || m.direction === 'out' ? 1 : 0, m.sent_by ?? '').lastInsertRowid);
  for (const a of (m.attachments ?? []).slice(0, 30)) {
    run('INSERT INTO mail_attachments (message_id, filename, content_type, content_id, size, data) VALUES (?, ?, ?, ?, ?, ?)',
      id, (a.filename || 'zalacznik').slice(0, 200), (a.content_type || 'application/octet-stream').slice(0, 100), (a.content_id ?? '').slice(0, 200), a.data.length, new Uint8Array(a.data));
  }
  run(`UPDATE mail_threads SET last_at = MAX(last_at, ?), snippet = ?, message_count = message_count + 1,
      unread = unread + ?, has_attachments = MAX(has_attachments, ?), archived = 0,
      counterpart_name = CASE WHEN counterpart_name = '' THEN ? ELSE counterpart_name END WHERE id = ?`,
    date, snippetOf(m.text || m.subject), m.direction === 'in' && !m.is_read ? 1 : 0, m.attachments?.length ? 1 : 0, counterpartName.slice(0, 200), threadId);
  return { id, thread_id: threadId };
}

/**
 * Każdy e-mail wysłany do gościa (odpowiedzi z Poczty, potwierdzenia, oferty, rachunki…) zapisuje się w rozmowie
 * z tym gościem. Powiadomienia do obsługi (tylko adresy z ustawień) nie są zapisywane.
 */
export function withMailLog(db: DatabaseSync, inner: Mailer, isStaffOnly: (to: string[]) => boolean): Mailer {
  return {
    ...inner,
    send: async (m: Mail & { sentBy?: string }) => {
      const messageId = m.messageId ?? `<${randomUUID()}@${mailDomain()}>`;
      await inner.send({ ...m, messageId });
      if (isStaffOnly(m.to)) return;
      try {
        const from = m.from ?? inner.from;
        storeMessage(db, {
          mailbox: addrOf(from), direction: 'out', message_id: messageId,
          in_reply_to: m.headers?.['In-Reply-To'] ?? '', refs: (m.headers?.References ?? '').split(/\s+/).filter(Boolean),
          from_addr: addrOf(from), from_name: nameOf(from), to: m.to, cc: m.cc, reply_to: m.replyTo ?? '',
          subject: m.subject, text: m.text, html: m.html, sent_by: m.sentBy ?? '',
          attachments: m.attachments?.map((a) => ({ filename: a.filename, content_type: a.contentType ?? 'application/octet-stream', data: a.content })),
        });
      } catch (err) {
        console.error('Nie zapisano wysłanej wiadomości w Poczcie', err);
      }
    },
  };
}

/** Prosty HTML do odpowiedzi pisanych w aplikacji (bez szablonu powiadomień) */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function replyHtml(text: string, quote?: { header: string; text: string }) {
  const body = esc(text).replace(/\n/g, '<br>');
  const q = quote ? `<div style="margin-top:18px;color:#6b776f;font-size:13px">${esc(quote.header)}</div>
    <blockquote style="margin:6px 0 0;padding:0 0 0 12px;border-left:3px solid #c1b1a0;color:#55605a;font-size:13px">${esc(quote.text).replace(/\n/g, '<br>')}</blockquote>` : '';
  return `<!doctype html><html><body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2a25">
<div>${body}</div>
<div style="margin-top:18px;color:#577267;font-size:13px">${BRAND} · odmorzadogor.pl · tel. +48 510 248 693</div>${q}
</body></html>`;
}
