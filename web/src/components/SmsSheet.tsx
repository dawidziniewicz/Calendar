import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { PayView, Reservation, SmsContext, SmsTemplate } from '../types';
import { dmy, today } from '../dates';
import { currencySymbol, fmt } from '../money';
import { whatsappHref } from '../phone';
import { DEPOSIT_FIELDS, fillSms, missingFields, smsHref, smsParts, smsValues, stripDiacritics } from '../sms';
import AutoTextarea from './AutoTextarea';
import DateInput from './DateInput';
import NumInput from './NumInput';

// SMS / WhatsApp do gościa z szablonu: aplikacja podstawia dane rezerwacji, a telefon wysyła wiadomość
// (otwiera Wiadomości albo WhatsApp z gotowym tekstem). Link do płatności można najpierw podejrzeć.
export default function SmsSheet({ reservation: r, onClose, onChanged, onOpenTemplates }: {
  reservation: Reservation; onClose: () => void; onChanged: (updated: Reservation) => void; onOpenTemplates?: () => void;
}) {
  const [ctx, setCtx] = useState<SmsContext | null>(null);
  const [tpl, setTpl] = useState<SmsTemplate | null>(null);
  const [text, setText] = useState('');
  const [edited, setEdited] = useState(false);
  const [deposit, setDeposit] = useState<{ amount: number | null; due: string }>({ amount: null, due: '' });
  const [preview, setPreview] = useState<{ deposit: PayView; balance: PayView } | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const loaded = useRef(false);

  useEffect(() => {
    api.smsContext(r.id).then((c) => {
      setCtx(c);
      setPreview(c.preview);
      setDeposit({ amount: c.data.deposit, due: c.data.deposit_due ?? '' });
      loaded.current = true;
    }).catch((e) => setError(e.message));
  }, [r.id]);

  // podgląd strony płatności z kwotą zaliczki z formularza (jeszcze niezapisaną)
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => api.smsContext(r.id, deposit).then((c) => setPreview(c.preview)).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [r.id, deposit]);

  const values = useMemo(() => (ctx ? smsValues(ctx.data, deposit) : {}), [ctx, deposit]);
  // treść z szablonu odświeża się po zmianie kwoty / terminu, dopóki nie zmienisz jej ręcznie
  useEffect(() => { if (tpl && !edited) setText(fillSms(tpl.body, values)); }, [tpl, values, edited]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (t: SmsTemplate | null) => {
    setTpl(t);
    setEdited(false);
    setNote('');
    if (!t) setText('');
  };

  const links = ctx?.data.links;
  const usesDeposit = !!links && ((tpl && DEPOSIT_FIELDS.test(tpl.body)) || text.includes(links.deposit));
  const usesBalance = !!links && text.includes(links.balance);
  const depositChanged = usesDeposit && (deposit.amount !== r.deposit || (deposit.due || null) !== (r.deposit_due || null));
  const missing = missingFields(text);
  const count = smsParts(text);
  const phone = r.guest_phone;
  const wa = phone ? whatsappHref(phone, text) : null;

  const logSent = (channel: 'sms' | 'whatsapp') => {
    if (!text.trim()) return;
    api.smsSent(r.id, { body: text, name: tpl?.name ?? '', channel, ...(usesDeposit ? { deposit } : {}) })
      .then((res) => { onChanged(res.reservation); setNote(`Otwarto ${channel === 'sms' ? 'Wiadomości' : 'WhatsApp'} z gotowym tekstem — zapisano w historii rezerwacji${usesDeposit ? ' (z kwotą zaliczki)' : ''}.`); })
      .catch((e) => setError(e.message));
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setNote('Skopiowano tekst — wklej go w dowolnym komunikatorze.'); } catch { prompt('Skopiuj tekst:', text); }
  };

  // strona gościa pokazuje to, co zapisane w rezerwacji — przed podglądem zapisujemy kwotę zaliczki
  const openPage = async (kind: 'deposit' | 'balance') => {
    if (!links) return;
    const url = links[kind];
    if (kind !== 'deposit' || !depositChanged) { window.open(url, '_blank'); return; }
    const w = window.open('', '_blank');
    try {
      const updated = await api.saveDeposit(r.id, deposit);
      onChanged(updated);
      if (w) w.location.href = url; else window.location.href = url;
    } catch (e) {
      w?.close();
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="SMS do gościa">
        <header className="sheet-head">
          <button type="button" className="link" onClick={onClose}>{note ? 'Gotowe' : 'Anuluj'}</button>
          <h2>SMS / WhatsApp</h2>
          <span className="head-spacer" />
        </header>
        <div className="sheet-body sms-sheet">
          {!ctx && !error && <p className="muted">Wczytywanie…</p>}
          {ctx && (
            <>
              <p className="sms-to">Do: <b>{r.guest_name || 'gość'}</b> {phone ? <span className="muted">· {phone}</span> : <span className="warn">· brak numeru telefonu — tekst możesz skopiować</span>}</p>
              <div className="chips kind-chips">
                {ctx.templates.map((t) => (
                  <button type="button" key={t.id} className={`chip ${tpl?.id === t.id ? 'active' : ''}`} onClick={() => pick(t)}>
                    {t.name}{t.unit_id != null && <small> · ten domek</small>}
                  </button>
                ))}
                <button type="button" className={`chip ${!tpl && text === '' ? 'active' : ''}`} onClick={() => pick(null)}>Własny tekst</button>
              </div>
              {onOpenTemplates && <button type="button" className="link small-link" onClick={onOpenTemplates}>Dodaj lub zmień szablony…</button>}

              {usesDeposit && (
                <fieldset>
                  <label>Zaliczka ({currencySymbol(ctx.data.currency)})<NumInput value={deposit.amount} onChange={(v) => setDeposit({ ...deposit, amount: v })} /></label>
                  <label>Termin wpłaty<DateInput value={deposit.due} min={today()} clearable onChange={(v) => setDeposit({ ...deposit, due: v })} /></label>
                  <p className="full muted small-note">{ctx.data.deposit_saved ? 'Zmiana kwoty lub terminu zapisze się w rezerwacji.' : 'Kwota i termin zapiszą się w rezerwacji po wysłaniu.'}</p>
                </fieldset>
              )}

              <label className="sms-text">Treść
                <AutoTextarea rows={5} value={text} onChange={(e) => { setText(e.target.value); setEdited(true); }}
                  placeholder="Wybierz szablon powyżej albo wpisz własny tekst" />
              </label>
              <div className="sms-meta">
                <span className="muted">{count.len} znaków · {count.parts} {count.parts === 1 ? 'SMS' : 'SMS-y'}{count.unicode && count.len > 0 ? ' (polskie znaki: 70 znaków na SMS)' : ''}</span>
                {count.unicode && text && <button type="button" className="link" onClick={() => { setText(stripDiacritics(text)); setEdited(true); }}>Usuń polskie znaki</button>}
                {edited && tpl && <button type="button" className="link" onClick={() => setEdited(false)}>Przywróć szablon</button>}
              </div>
              {missing.length > 0 && <p className="warn">Do uzupełnienia: {missing.map((m) => `{${m}}`).join(', ')} — {missing.some((m) => m.includes('zaliczk')) ? 'wpisz kwotę i termin zaliczki' : 'brak tych danych w rezerwacji'}.</p>}

              {preview && (usesDeposit || usesBalance) && (
                <div className="pay-preview">
                  <h3>Co gość zobaczy pod linkiem</h3>
                  {usesDeposit && <PayCard view={preview.deposit} onOpen={() => openPage('deposit')} saving={depositChanged} />}
                  {usesBalance && <PayCard view={preview.balance} onOpen={() => openPage('balance')} saving={false} />}
                </div>
              )}

              {error && <div className="banner error">{error}</div>}
              {note && <div className="banner info">✓ {note}</div>}
              <div className="sms-actions">
                {phone ? (
                  <a className={`btn primary big ${!text.trim() ? 'disabled' : ''}`} href={smsHref(phone, text)} onClick={(e) => (text.trim() ? logSent('sms') : e.preventDefault())}>Wyślij SMS</a>
                ) : null}
                {wa && (
                  <a className={`btn whatsapp-btn big ${!text.trim() ? 'disabled' : ''}`} href={wa} target="_blank" rel="noopener noreferrer" onClick={(e) => (text.trim() ? logSent('whatsapp') : e.preventDefault())}>WhatsApp</a>
                )}
                <button type="button" className="btn" disabled={!text.trim()} onClick={copy}>Kopiuj tekst</button>
              </div>
              <p className="muted small-note">Telefon otworzy Wiadomości (albo WhatsApp) z gotowym tekstem — sprawdź go i stuknij „Wyślij”.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Strona płatności w skrócie: kwota, termin, konto, tytuł przelewu i kody QR — tak jak zobaczy ją gość
function PayCard({ view: v, onOpen, saving }: { view: PayView; onOpen: () => void; saving: boolean }) {
  const money = (n: number) => fmt(n, v.currency);
  const p = v.payment;
  return (
    <div className="pay-card">
      <div className="pay-card-head">
        <b>{v.kind === 'deposit' ? 'Zaliczka' : 'Dopłata'}</b>
        {v.state === 'pay' && v.amount != null && <span className="pay-amount">{money(v.amount)}{v.due ? <small> do {dmy(v.due)}</small> : null}</span>}
      </div>
      {v.state === 'paid' && <p className="paid">Opłacone ✓ — gość zobaczy podziękowanie.</p>}
      {v.state === 'withdrawn' && <p className="warn">Rezerwacja anulowana — gość zobaczy informację o anulacji.</p>}
      {v.state === 'pay' && v.amount == null && <p className="warn">Brak kwoty — wpisz kwotę zaliczki.</p>}
      {v.state === 'pay' && !p && <p className="warn">Brak numeru konta i Revolutu — uzupełnij w Ustawienia → Płatności i rachunki.</p>}
      {v.state === 'pay' && p && (
        <dl className="pay-card-list">
          {p.account_name && <div><dt>Odbiorca</dt><dd>{p.account_name}</dd></div>}
          {p.account_number && <div><dt>Konto</dt><dd>{p.account_number}</dd></div>}
          {p.account_number && <div><dt>Tytuł</dt><dd>{p.title}</dd></div>}
          {p.revolut && <div><dt>Revolut</dt><dd>{p.revolut.replace(/^https?:\/\//, '')}</dd></div>}
        </dl>
      )}
      {v.state === 'pay' && p && p.qr.length > 0 && (
        <div className="pay-card-qr">{p.qr.map((q) => <figure key={q.kind}><img src={`/public${q.path}`} width={88} height={88} alt={`QR ${q.kind}`} /><figcaption>{q.kind === 'bank' ? 'przelew' : 'Revolut'}</figcaption></figure>)}</div>
      )}
      <button type="button" className="btn small" onClick={onOpen}>Otwórz stronę gościa ↗</button>
      {saving && <small className="muted"> zapisze nową kwotę zaliczki w rezerwacji</small>}
    </div>
  );
}
