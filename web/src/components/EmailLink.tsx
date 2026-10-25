import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type MailThread } from '../api';

// Kliknięcie w adres e-mail gościa: wybór — Poczta w kalendarzu (nowa wiadomość albo istniejąca rozmowa)
// czy zwykła aplikacja pocztowa (mailto:). Bez dostępu do Poczty zostaje zwykły link mailto:.

export type MailIntent = { compose?: { to: string; subject?: string }; thread?: number };
export const MailLinkContext = createContext<((i: MailIntent) => void) | null>(null);

const sqlDate = (s: string) => new Date(`${s.replace(' ', 'T')}Z`);

export default function EmailLink({ email, subject, className, children }: {
  email: string; subject?: string; className?: string; children: ReactNode;
}) {
  const openMail = useContext(MailLinkContext);
  const [choosing, setChoosing] = useState(false);
  const href = `mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
  if (!openMail) return <a className={className} href={href}>{children}</a>;
  return (
    <>
      <a className={className} href={href} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setChoosing(true); }}>{children}</a>
      {choosing && <Choice email={email} subject={subject} href={href} onMail={(i) => { setChoosing(false); openMail(i); }} onClose={() => setChoosing(false)} />}
    </>
  );
}

function Choice({ email, subject, href, onMail, onClose }: {
  email: string; subject?: string; href: string; onMail: (i: MailIntent) => void; onClose: () => void;
}) {
  const [threads, setThreads] = useState<MailThread[]>([]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const addr = email.trim().toLowerCase();
    api.mailThreads({ q: addr }).then((l) => setThreads(l.filter((t) => t.counterpart === addr).slice(0, 3))).catch(() => {});
  }, [email]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(email); setCopied(true); setTimeout(onClose, 700); } catch { /* brak uprawnień */ }
  };
  return createPortal(
    <div className="sheet-backdrop choice-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="sheet choice-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Napisz do ${email}`}>
        <header className="sheet-head">
          <span />
          <h2>Napisz do gościa</h2>
          <button type="button" className="link" onClick={onClose}>Anuluj</button>
        </header>
        <div className="sheet-body">
          <p className="choice-addr">{email}</p>
          <div className="choice-list">
            <button type="button" className="choice primary" onClick={() => onMail({ compose: { to: email, subject } })}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18v12H3zM3 6l9 7 9-7" /></svg>
              <span><b>Poczta w kalendarzu</b><small>Wyślij z rezerwacje@ lub kontakt@ — zapisze się w rozmowie z gościem</small></span>
            </button>
            {threads.map((t) => (
              <button key={t.id} type="button" className="choice" onClick={() => onMail({ thread: t.id })}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 5h16v11H9l-5 4z" /></svg>
                <span>
                  <b>Rozmowa: {t.subject || '(bez tematu)'}</b>
                  <small>{sqlDate(t.last_at).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })} · {t.message_count} {t.message_count === 1 ? 'wiadomość' : 'wiadomości'}{t.unread ? ' · nowe' : ''}</small>
                </span>
              </button>
            ))}
            <a className="choice" href={href} onClick={() => setTimeout(onClose, 300)}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5" /></svg>
              <span><b>Inna aplikacja pocztowa</b><small>Gmail, Poczta itp. na tym urządzeniu</small></span>
            </a>
            <button type="button" className="choice" onClick={copy}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 9h11v11H9zM5 15H4V4h11v1" /></svg>
              <span><b>{copied ? 'Skopiowano ✓' : 'Kopiuj adres'}</b></span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
