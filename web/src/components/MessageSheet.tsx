import { useEffect, useRef, useState } from 'react';
import { api, type MessageInput } from '../api';
import type { MessageKind, Reservation } from '../types';
import { today } from '../dates';
import NumInput from './NumInput';
import { currencySymbol } from '../money';

export const MESSAGE_LABELS: Record<MessageKind, string> = {
  deposit: 'Prośba o zaliczkę',
  balance: 'Prośba o dopłatę',
  received: 'Potwierdzenie wpłaty',
  confirmation: 'Potwierdzenie rezerwacji',
  custom: 'Własna wiadomość',
  invoice: 'Rachunek',
  offer: 'Oferta do akceptacji',
  offer_accepted: 'Potwierdzenie po akceptacji oferty',
};
const COMPOSE_KINDS: MessageKind[] = ['deposit', 'balance', 'received', 'confirmation', 'custom'];

// E-mail do gościa z aplikacji: gotowe szablony (z danymi do przelewu z ustawień) do edycji przed wysłaniem.
export default function MessageSheet({ reservation: r, initialKind, onClose, onSent }: {
  reservation: Reservation; initialKind: MessageKind; onClose: () => void; onSent: (updated: Reservation) => void;
}) {
  const [kind, setKind] = useState<MessageKind>(initialKind);
  const [lang, setLang] = useState<'pl' | 'en'>(r.lang === 'en' ? 'en' : 'pl');
  const [amount, setAmount] = useState<number | null>(null);
  const [due, setDue] = useState('');
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [hasAccount, setHasAccount] = useState(true);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  // własne zmiany treści nie są nadpisywane przy zmianie kwoty / terminu
  const edited = useRef({ subject: false, body: false, title: false });
  // po zmianie rodzaju wiadomości najpierw wczytujemy domyślną kwotę i termin (np. 30% ceny)
  const needsDefaults = useRef(true);

  const payment = kind === 'deposit' || kind === 'balance';

  // Domyślna treść z serwera (przy zmianie rodzaju, języka, kwoty lub terminu)
  useEffect(() => {
    const defaults = needsDefaults.current;
    let cancelled = false;
    const t = setTimeout(() => {
      api.messageDraft(r.id, kind, { lang, ...(defaults ? {} : { amount, due: due || null }) }).then((d) => {
        if (cancelled) return;
        if (defaults || !edited.current.subject) setSubject(d.subject);
        if (defaults || !edited.current.body) setBody(d.body);
        if (defaults || !edited.current.title) setTitle(d.title);
        if (defaults) { needsDefaults.current = false; setAmount(d.amount); setDue(d.due ?? ''); }
        setHasAccount(d.has_account);
      }).catch((e) => setError(e.message));
    }, defaults ? 0 : 300);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, lang, amount, due]);

  const changeKind = (k: MessageKind) => {
    edited.current = { subject: false, body: false, title: false };
    needsDefaults.current = true;
    setKind(k);
    setSent(false);
  };

  const input = (): MessageInput => ({ kind, lang, subject, body, amount, due: due || null, title });
  useEffect(() => {
    if (tab !== 'preview') return;
    api.messagePreview(r.id, input()).then((p) => setHtml(p.html)).catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async () => {
    if (kind === 'custom' && !body.trim()) return setError('Wpisz treść wiadomości');
    setBusy(true);
    setError('');
    try {
      const res = await api.sendMessage(r.id, input());
      setSent(true);
      onSent(res.reservation);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Wiadomość do gościa">
        <header className="sheet-head">
          <button type="button" className="link" onClick={onClose}>{sent ? 'Gotowe' : 'Anuluj'}</button>
          <h2>Wiadomość do gościa</h2>
          {sent ? <span className="head-spacer" /> : <button type="button" className="link strong" disabled={busy || !r.guest_email} onClick={send}>{busy ? '…' : 'Wyślij'}</button>}
        </header>
        <div className="sheet-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'edit'} className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>Treść</button>
          <button role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Podgląd e-maila</button>
        </div>
        <div className="sheet-body">
          {sent ? (
            <div className="offer-done">
              <div className="done-mark" aria-hidden>✓</div>
              <h3>Wysłano na {r.guest_email}</h3>
              <p className="muted">Wiadomość jest zapisana w historii rezerwacji.</p>
              <button type="button" className="btn" onClick={() => { setSent(false); changeKind('custom'); }}>Napisz kolejną</button>
            </div>
          ) : tab === 'preview' ? (
            <iframe className="mail-preview" title="Podgląd e-maila" srcDoc={html} sandbox="" />
          ) : (
            <>
              {!r.guest_email && <div className="banner error">Brak adresu e-mail gościa — uzupełnij go w rezerwacji (Edytuj).</div>}
              <div className="chips kind-chips">
                {COMPOSE_KINDS.map((k) => <button type="button" key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => changeKind(k)}>{MESSAGE_LABELS[k]}</button>)}
              </div>
              <fieldset>
                {(payment || kind === 'received') && (
                  <>
                    <label>{kind === 'received' ? 'Otrzymana kwota' : 'Kwota'} ({currencySymbol(r.currency)})<NumInput value={amount} onChange={setAmount} /></label>
                    {payment && <label>Termin wpłaty<input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} /></label>}
                  </>
                )}
                {payment && (
                  <label className="full">Tytuł przelewu<input value={title} onChange={(e) => { edited.current.title = true; setTitle(e.target.value); }} /></label>
                )}
                {payment && !hasAccount && <p className="full warn">Brak numeru konta i Revolutu — uzupełnij w Ustawienia → Płatności i rachunki, inaczej e-mail nie będzie miał danych do płatności.</p>}
                <label>Język
                  <select value={lang} onChange={(e) => { edited.current = { subject: false, body: false, title: false }; setLang(e.target.value as 'pl' | 'en'); }}>
                    <option value="pl">polski</option><option value="en">angielski</option>
                  </select>
                </label>
                <label className="full">Temat<input value={subject} onChange={(e) => { edited.current.subject = true; setSubject(e.target.value); }} /></label>
                <label className="full">Treść {kind !== 'custom' && <small className="muted">— pod spodem e-mail sam doda {payment ? 'termin pobytu i dane do przelewu' : 'szczegóły pobytu'}</small>}
                  <textarea rows={6} value={body} onChange={(e) => { edited.current.body = true; setBody(e.target.value); }} placeholder={kind === 'custom' ? 'np. Kod do skrzynki z kluczami: 1234. Zameldowanie od 15:00.' : ''} />
                </label>
                {kind === 'deposit' && <p className="full muted">Kwota i termin zaliczki zapiszą się w rezerwacji.</p>}
              </fieldset>
              {error && <div className="banner error">{error}</div>}
              <button type="button" className="btn primary big" disabled={busy || !r.guest_email} onClick={send}>{busy ? 'Wysyłanie…' : `Wyślij na ${r.guest_email || '—'}`}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
