import { useEffect, useRef, useState } from 'react';
import { api, type MailMessage, type MailSummary, type MailThread, type MailThreadDetail } from '../api';
import type { Reservation } from '../types';
import { formatShort } from '../dates';
import type { MailIntent } from './EmailLink';

// Poczta: wiadomości do rezerwacje@ / kontakt@ / contact@ (odbiór przez Cloudflare Email Worker), rozmowy,
// odpowiedzi i nowe wiadomości z wybranego adresu, e-maile wysłane gościom z kalendarza.

const sqlDate = (s: string) => new Date(`${s.replace(' ', 'T')}Z`);
const whenShort = (s: string) => {
  const d = sqlDate(s);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
};
const whenLong = (s: string) => sqlDate(s).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
const local = (addr: string) => `${addr.split('@')[0]}@`;
const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} kB`);

export default function Mail({ version, focusThread, intent, onOpenReservation, onUnreadChange }: {
  version: number; focusThread: number | null; intent?: (MailIntent & { n: number }) | null;
  onOpenReservation: (r: Reservation) => void; onUnreadChange: () => void;
}) {
  const [summary, setSummary] = useState<MailSummary | null>(null);
  const [box, setBox] = useState('');
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [threads, setThreads] = useState<MailThread[] | null>(null);
  const [open, setOpen] = useState<number | null>(focusThread);
  const [composing, setComposing] = useState<false | { to?: string; subject?: string }>(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => { api.mailSummary().then(setSummary).catch(() => {}); }, [version, reload]);
  useEffect(() => {
    const t = setTimeout(() => {
      api.mailThreads({ mailbox: box, q, archived }).then((l) => { setThreads(l); setError(''); }).catch((e) => setError(e.message));
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [box, q, archived, version, reload]);

  // Przyjście z adresu e-mail gościa (rezerwacja, zapytanie): od razu nowa wiadomość albo rozmowa
  useEffect(() => {
    if (!intent) return;
    if (intent.thread) { setComposing(false); setOpen(intent.thread); } else if (intent.compose) { setOpen(null); setComposing(intent.compose); }
  }, [intent]);

  const refresh = () => { setReload((v) => v + 1); onUnreadChange(); };

  return (
    <section className="mail">
      <div className="page-intro mail-head">
        <div>
          <h1>Poczta</h1>
          <p className="muted">{summary?.mailboxes.join(' · ')}</p>
        </div>
        <button className="btn primary" onClick={() => setComposing({})} disabled={!summary?.sending}>＋ Nowa wiadomość</button>
      </div>
      {summary && !summary.last_inbound && (
        <div className="banner info">
          Odbiór poczty nie jest jeszcze włączony — wiadomości pojawią się tu po ustawieniu przekierowania w Cloudflare (Ustawienia → Poczta).
          Wysłane z kalendarza e-maile do gości już się tu zapisują.
        </div>
      )}
      {summary && !summary.sending && <div className="banner error">Wysyłka e-maili nie jest skonfigurowana na serwerze (RESEND_API_KEY w .env).</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="mail-filters">
        <div className="chips">
          <button className={`chip ${!box ? 'active' : ''}`} onClick={() => setBox('')}>Wszystkie</button>
          {summary?.mailboxes.map((m) => <button key={m} className={`chip ${box === m ? 'active' : ''}`} onClick={() => setBox(m)}>{local(m)}</button>)}
          <button className={`chip ${archived ? 'active' : ''}`} onClick={() => setArchived(!archived)}>Archiwum</button>
        </div>
        <input className="search" type="search" placeholder="Szukaj: nadawca, temat, treść…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {threads === null && !error && <p className="muted">Wczytywanie…</p>}
      {threads?.length === 0 && (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18v12H3zM3 6l9 7 9-7" /></svg>
          <b>{archived ? 'Archiwum jest puste' : q ? 'Nic nie znaleziono' : 'Brak wiadomości'}</b>
        </div>
      )}
      <ul className="mail-list">
        {threads?.map((t) => (
          <li key={t.id}>
            <button className={`mail-item ${t.unread ? 'is-unread' : ''}`} onClick={() => setOpen(t.id)}>
              <span className="mail-dot" aria-label={t.unread ? 'nieprzeczytana' : undefined} />
              <span className="mail-main">
                <span className="mail-row1">
                  <b className="mail-who">{t.counterpart_name || t.counterpart || '—'}</b>
                  <span className="mail-when">{whenShort(t.last_at)}</span>
                </span>
                <span className="mail-subject">{t.subject || '(bez tematu)'}{t.message_count > 1 && <small className="muted"> · {t.message_count}</small>}{t.has_attachments ? ' 📎' : ''}</span>
                <span className="mail-snippet muted">{t.snippet}</span>
                <span className="mail-box">{local(t.mailbox)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {open != null && (
        <ThreadSheet id={open} summary={summary} onClose={() => { setOpen(null); refresh(); }} onChanged={refresh} onOpenReservation={onOpenReservation} />
      )}
      {composing && summary && (
        <Compose summary={summary} initial={composing} onClose={() => setComposing(false)} onSent={(threadId) => { setComposing(false); refresh(); if (threadId) setOpen(threadId); }} />
      )}
    </section>
  );
}

// HTML wiadomości w bezpiecznej ramce (bez skryptów), wysokość dopasowana do treści, linki w nowej karcie
function MailBody({ m }: { m: MailMessage }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [asText, setAsText] = useState(!m.html);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline'; font-src https: data:">
<style>body{margin:0;padding:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1f2a25;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${m.html}</body></html>`;
  const fit = () => {
    const d = frame.current?.contentDocument;
    if (d?.body && frame.current) frame.current.style.height = `${Math.min(4000, d.documentElement.scrollHeight + 4)}px`;
  };
  return (
    <div className="mail-body">
      {asText ? <div className="mail-text">{m.text || '(pusta wiadomość)'}</div>
        : <iframe ref={frame} className="mail-frame" title={m.subject} srcDoc={doc} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" onLoad={() => { fit(); setTimeout(fit, 400); }} />}
      {m.html && m.text && <button type="button" className="link mail-toggle" onClick={() => setAsText(!asText)}>{asText ? 'Pokaż oryginał' : 'Pokaż jako tekst'}</button>}
    </div>
  );
}

function ThreadSheet({ id, summary, onClose, onChanged, onOpenReservation }: {
  id: number; summary: MailSummary | null; onClose: () => void; onChanged: () => void; onOpenReservation: (r: Reservation) => void;
}) {
  const [data, setData] = useState<MailThreadDetail | null>(null);
  const [error, setError] = useState('');
  const [from, setFrom] = useState('');
  const [text, setText] = useState('');
  const [quote, setQuote] = useState(true);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  const load = () => api.mailThread(id).then((d) => {
    setData(d);
    setFrom((f) => f || d.thread.mailbox);
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const t = data?.thread;
  const send = async () => {
    if (!t || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.sendMail({ from, to: t.counterpart, text, thread_id: t.id, quote });
      setText('');
      setInfo('Wysłano.');
      await load();
      onChanged();
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 100);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const state = async (s: { archived?: boolean; read?: boolean }) => {
    if (!t) return;
    try { await api.mailThreadState(t.id, s); onChanged(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const remove = async () => {
    if (!t || !confirm('Usunąć całą rozmowę z aplikacji? (Kopia na innej skrzynce zostaje.)')) return;
    try { await api.deleteMailThread(t.id); onChanged(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const openRes = async (rid: number) => {
    try { onOpenReservation(await api.reservation(rid)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet wide mail-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Rozmowa">
        <header className="sheet-head">
          <button type="button" className="link" onClick={onClose}>Zamknij</button>
          <h2 className="mail-sheet-title">{t?.subject || 'Wiadomość'}</h2>
          <span className="head-spacer" />
        </header>
        <div className="sheet-body">
          {!data && !error && <p className="muted">Wczytywanie…</p>}
          {error && <div className="banner error">{error}</div>}
          {data && t && (
            <>
              <div className="mail-thread-meta">
                <span><b>{t.counterpart_name || t.counterpart}</b>{t.counterpart_name && <span className="muted"> · {t.counterpart}</span>}</span>
                <span className="mail-box">{local(t.mailbox)}</span>
              </div>
              {(data.reservations.length > 0 || data.requests.length > 0) && (
                <div className="mail-links">
                  {data.reservations.map((r) => (
                    <button key={r.id} className="chip" onClick={() => openRes(r.id)}>
                      Rezerwacja · {r.unit_name} · {formatShort(r.check_in)}–{formatShort(r.check_out)}{r.status === 'cancelled' ? ' (anulowana)' : ''} ›
                    </button>
                  ))}
                  {data.reservations.length === 0 && data.requests.map((r) => (
                    <span key={r.id} className="chip">Zapytanie · {formatShort(r.check_in)}–{formatShort(r.check_out)}</span>
                  ))}
                </div>
              )}
              <ol className="mail-messages">
                {data.messages.map((m) => (
                  <li key={m.id} className={`mail-msg ${m.direction}`}>
                    <div className="mail-msg-head">
                      <span><b>{m.direction === 'out' ? `Ty${m.sent_by ? ` (${m.sent_by})` : ''}` : m.from_name || m.from_addr}</b>
                        <span className="muted"> · {m.direction === 'out' ? `z ${local(m.mailbox)} do ${m.to_addrs.join(', ')}` : m.from_addr}</span></span>
                      <span className="muted">{whenLong(m.date)}</span>
                    </div>
                    {m.subject !== t.subject && <div className="mail-msg-subject">{m.subject}</div>}
                    <MailBody m={m} />
                    {m.attachments.length > 0 && (
                      <div className="mail-atts">
                        {m.attachments.map((a) => (
                          <a key={a.id} className="mail-att" href={api.mailAttachmentUrl(a.id)} target="_blank" rel="noopener noreferrer">
                            📎 {a.filename} <small className="muted">{kb(a.size)}</small>
                          </a>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>

              <div className="mail-reply" ref={bottom}>
                <h3>Odpowiedz</h3>
                <div className="row">
                  <label>Od
                    <select value={from} onChange={(e) => setFrom(e.target.value)}>
                      {(summary?.mailboxes ?? [t.mailbox]).map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                  <label>Do<input value={t.counterpart} readOnly /></label>
                </div>
                <label>Treść<textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Napisz odpowiedź…" /></label>
                <label className="check-row"><input type="checkbox" checked={quote} onChange={(e) => setQuote(e.target.checked)} /> Dołącz cytat ostatniej wiadomości</label>
                {info && <div className="banner info">{info}</div>}
                <button className="btn primary big" disabled={busy || !text.trim() || !summary?.sending} onClick={send}>{busy ? 'Wysyłanie…' : 'Wyślij odpowiedź'}</button>
              </div>

              <div className="mail-actions">
                <button className="btn small" onClick={() => state({ archived: !t.archived })}>{t.archived ? 'Przywróć z archiwum' : 'Archiwizuj'}</button>
                <button className="btn small" onClick={() => state({ read: false })}>Oznacz jako nieprzeczytane</button>
                <button className="btn small danger-outline" onClick={remove}>Usuń</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Compose({ summary, initial, onClose, onSent }: {
  summary: MailSummary; initial: { to?: string; subject?: string }; onClose: () => void; onSent: (threadId: number | null) => void;
}) {
  const [from, setFrom] = useState(summary.mailboxes[0] ?? '');
  const [to, setTo] = useState(initial.to ?? '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.sendMail({ from, to, cc, subject, text });
      onSent(r.thread_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Nowa wiadomość">
        <header className="sheet-head">
          <button type="button" className="link" onClick={onClose}>Anuluj</button>
          <h2>Nowa wiadomość</h2>
          <button type="button" className="link strong" disabled={busy || !to || !text.trim() || !subject.trim()} onClick={send}>{busy ? '…' : 'Wyślij'}</button>
        </header>
        <div className="sheet-body">
          <fieldset>
            <label className="full">Od
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {summary.mailboxes.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="full">Do<input type="email" inputMode="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="adres@przyklad.pl" /></label>
            <label className="full">DW (opcjonalnie)<input inputMode="email" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="kolejne adresy, po przecinku" /></label>
            <label className="full">Temat<input value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
            <label className="full">Treść<textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} /></label>
          </fieldset>
          {error && <div className="banner error">{error}</div>}
          <button className="btn primary big" disabled={busy || !to || !text.trim() || !subject.trim()} onClick={send}>{busy ? 'Wysyłanie…' : `Wyślij z ${from}`}</button>
        </div>
      </div>
    </div>
  );
}
