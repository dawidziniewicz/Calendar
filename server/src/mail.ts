import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Wysyłka e-maili: Resend (RESEND_API_KEY) albo dowolny serwer SMTP (SMTP_HOST, np. skrzynka u hostingodawcy).
// Bez konfiguracji e-maile są wyłączone — zapytania i tak trafiają do aplikacji (powiadomienia push).

export type Attachment = { filename: string; content: Buffer; contentType?: string };
export type Mail = { to: string[]; subject: string; html: string; text: string; replyTo?: string; attachments?: Attachment[] };
export type Mailer = { send: (m: Mail) => Promise<void>; from: string; kind: 'resend' | 'smtp' | 'log' };

export function createMailer(env: NodeJS.ProcessEnv = process.env): Mailer | undefined {
  const from = env.MAIL_FROM || 'Od Morza do Gór <rezerwacje@odmorzadogor.pl>';
  if (env.RESEND_API_KEY) {
    const key = env.RESEND_API_KEY;
    return {
      from,
      kind: 'resend',
      send: async (m) => {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from, to: m.to, subject: m.subject, html: m.html, text: m.text, reply_to: m.replyTo,
            attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })),
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      },
    };
  }
  if (env.SMTP_HOST) {
    const port = Number(env.SMTP_PORT || 465);
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
    });
    return {
      from,
      kind: 'smtp',
      send: async (m) => {
        await transport.sendMail({ from, to: m.to, subject: m.subject, html: m.html, text: m.text, replyTo: m.replyTo, attachments: m.attachments });
      },
    };
  }
  // Tylko do testów lokalnych: e-maile (HTML i załączniki) zapisywane do katalogu mail-outbox obok bazy zamiast wysyłki
  if (env.MAIL_LOG === '1') {
    const dir = join(dirname(env.DB_PATH || './data/x'), 'mail-outbox');
    return {
      from,
      kind: 'log',
      send: async (m) => {
        mkdirSync(dir, { recursive: true });
        const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${m.subject.replace(/[^\w]+/g, '-').slice(0, 50)}`;
        writeFileSync(join(dir, `${base}.html`), m.html);
        for (const a of m.attachments ?? []) writeFileSync(join(dir, `${base}-${a.filename}`), a.content);
        console.log(`[MAIL_LOG] ${m.to.join(', ')} · ${m.subject}`);
      },
    };
  }
  return undefined;
}

export const isEmail = (s: string) => /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(s);

/** „a@b.pl, c@d.pl” → lista poprawnych adresów */
export function parseEmails(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).map((s) => s.trim()).filter(isEmail))];
}

// ---------------------------------------------------------------------------
// Szablon wiadomości w kolorach strony (#577267 · #8CA196 · #C1B1A0)
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export type MailRow = [label: string, value: string];
export type MailContent = {
  preheader: string;
  title: string;
  intro: string[]; // akapity (zwykły tekst)
  rows?: MailRow[];
  note?: { label: string; text: string };
  button?: { label: string; url: string };
  outro?: string[];
  /** Obrazki pod danymi (kody QR do płatności), opcjonalnie z linkiem */
  images?: { src: string; caption: string; href?: string }[];
  /** Dyskretny link pod treścią (np. „Poproś o anulację”) */
  link?: { text: string; label: string; url: string };
};

export function renderMail(c: MailContent, lang: 'pl' | 'en' = 'pl'): { html: string; text: string } {
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#2b3631">${esc(t).replace(/\n/g, '<br>')}</p>`;
  const rows = c.rows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 20px;background:#f6f3ee;border-radius:12px">
        ${c.rows.map(([k, v], i) => `<tr><td style="padding:11px 16px;font-size:13px;color:#6b776f;${i ? 'border-top:1px solid #e6dfd5;' : ''}white-space:nowrap;vertical-align:top">${esc(k)}</td>
          <td style="padding:11px 16px;font-size:14px;color:#1f2a25;font-weight:600;text-align:right;${i ? 'border-top:1px solid #e6dfd5;' : ''}">${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}
      </table>` : '';
  const note = c.note
    ? `<div style="margin:0 0 20px;padding:14px 16px;border-left:3px solid #8CA196;background:#f1f4f2;border-radius:0 10px 10px 0">
        <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#577267;font-weight:700;margin-bottom:4px">${esc(c.note.label)}</div>
        <div style="font-size:15px;line-height:1.55;color:#1f2a25">${esc(c.note.text).replace(/\n/g, '<br>')}</div></div>` : '';
  const images = c.images?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>${c.images.map((im) => {
        const img = `<img src="${esc(im.src)}" width="150" height="150" alt="${esc(im.caption)}" style="display:block;width:150px;height:150px;border:1px solid #e6dfd5;border-radius:10px">`;
        return `<td align="center" valign="top" style="padding:0 14px 0 0">${im.href ? `<a href="${esc(im.href)}">${img}</a>` : img}
          <div style="margin-top:6px;font-size:12px;color:#6b776f;max-width:150px">${im.href ? `<a href="${esc(im.href)}" style="color:#577267;font-weight:600">${esc(im.caption)}</a>` : esc(im.caption)}</div></td>`;
      }).join('')}</tr></table>` : '';
  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 22px"><tr><td style="border-radius:999px;background:#577267">
        <a href="${esc(c.button.url)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${esc(c.button.label)}</a></td></tr></table>` : '';
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.title)}</title></head>
<body style="margin:0;padding:0;background:#efebe4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efebe4"><tr><td align="center" style="padding:28px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td style="padding:0 6px 16px;font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#577267;letter-spacing:.01em">Od Morza do Gór</td></tr>
    <tr><td style="background:#ffffff;border-radius:18px;padding:30px 28px 12px;border-top:5px solid #577267">
      <h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:25px;line-height:1.25;color:#1f2a25">${esc(c.title)}</h1>
      ${c.intro.map(p).join('')}${rows}${images}${note}${button}${(c.outro ?? []).map(p).join('')}
      ${c.link ? `<p style="margin:4px 0 18px;padding-top:14px;border-top:1px solid #ece6dd;font-size:13px;line-height:1.6;color:#6b776f">${esc(c.link.text)} <a href="${esc(c.link.url)}" style="color:#577267;font-weight:600">${esc(c.link.label)}</a></p>` : ''}
    </td></tr>
    <tr><td style="padding:18px 6px;font-size:12px;line-height:1.6;color:#7d877f">
      Od Morza do Gór · <a href="https://odmorzadogor.pl${lang === 'en' ? '/en/' : ''}" style="color:#577267">odmorzadogor.pl</a> · tel. +48 510 248 693<br>
      ${lang === 'en' ? 'This message was sent automatically — you can simply reply to it.' : 'Wiadomość wysłana automatycznie — możesz na nią po prostu odpowiedzieć.'}
    </td></tr>
  </table>
</td></tr></table></body></html>`;

  const text = [
    c.title, '',
    ...c.intro.flatMap((t) => [t, '']),
    ...(c.rows ?? []).map(([k, v]) => `${k}: ${v.replace(/\n/g, ', ')}`),
    ...(c.rows?.length ? [''] : []),
    ...(c.note ? [`${c.note.label}:`, c.note.text, ''] : []),
    ...(c.button ? [`${c.button.label}: ${c.button.url}`, ''] : []),
    ...(c.outro ?? []).flatMap((t) => [t, '']),
    ...(c.link ? [`${c.link.text} ${c.link.label}: ${c.link.url}`, ''] : []),
    '--', 'Od Morza do Gór · https://odmorzadogor.pl · tel. +48 510 248 693',
  ].join('\n');
  return { html, text };
}
