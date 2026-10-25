// Odbiór poczty dla kalendarza: Cloudflare Email Routing → ten Worker → API kalendarza (/inbound/mail, przez tunel).
// Reguły w Cloudflare (Email → Email Routing → Routing rules): rezerwacje@, kontakt@, contact@ → „Send to a Worker: kalendarz-poczta”.
// Opcjonalnie kopia na zwykłą skrzynkę (FORWARD_TO, adres musi być zweryfikowany w Email Routing → Destination addresses).
import PostalMime from 'postal-mime';

export interface Env {
  API_ORIGIN: string; // np. https://kalendarz-api.odmorzadogor.pl — ten sam co w Cloudflare Pages kalendarza
  API_KEY: string; // ten sam co API_KEY na serwerze
  CF_ACCESS_CLIENT_ID?: string; // service token do aplikacji Access chroniącej API (jeśli jest)
  CF_ACCESS_CLIENT_SECRET?: string;
  FORWARD_TO?: string; // np. twoj.adres@gmail.com — kopia każdej wiadomości (opcjonalnie)
}

const MAX_ATTACHMENTS_BYTES = 15_000_000;

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // kopia na zwykłą skrzynkę — najpierw, żeby nic nie zginęło nawet przy awarii serwera w domu
    let forwarded = false;
    if (env.FORWARD_TO) {
      try { await message.forward(env.FORWARD_TO.trim()); forwarded = true; } catch (err) { console.error('Przekazanie kopii nie powiodło się', err); }
    }

    let delivered = false;
    try {
      const email = await PostalMime.parse(message.raw, { attachmentEncoding: 'base64' });
      let total = 0;
      const attachments = (email.attachments ?? []).filter((a) => {
        const size = Math.floor(String(a.content ?? '').length * 0.75);
        total += size;
        return total <= MAX_ATTACHMENTS_BYTES;
      }).map((a) => ({ filename: a.filename ?? 'zalacznik', mimeType: a.mimeType, contentId: a.contentId ?? '', content: a.content }));
      const res = await fetch(`${env.API_ORIGIN.replace(/\/$/, '')}/inbound/mail`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.API_KEY,
          ...(env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET
            ? { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET } : {}),
        },
        body: JSON.stringify({
          envelope_to: message.to, envelope_from: message.from,
          message_id: email.messageId ?? '', in_reply_to: email.inReplyTo ?? '', references: email.references ?? '',
          from: email.from, to: email.to ?? [], cc: email.cc ?? [], reply_to: email.replyTo ?? [],
          subject: email.subject ?? '', date: email.date ?? '', text: email.text ?? '', html: email.html ?? '',
          attachments,
        }),
      });
      delivered = res.ok;
      if (!res.ok) console.error('Kalendarz odrzucił wiadomość', res.status, await res.text());
    } catch (err) {
      console.error('Nie udało się przekazać wiadomości do kalendarza', err);
    }

    // bez kopii i bez kalendarza — odrzucamy, żeby nadawca dostał informację (a nie wiadomość przepadła po cichu)
    if (!delivered && !forwarded) message.setReject('Serwer pocztowy chwilowo niedostępny — spróbuj ponownie później.');
  },
} satisfies ExportedHandler<Env>;
