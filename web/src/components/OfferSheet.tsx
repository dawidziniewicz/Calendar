import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Offer, PaymentSettings } from '../types';
import { addDays, formatShort, today } from '../dates';
import NumInput from './NumInput';

export type OfferTarget = {
  kind: 'request' | 'reservation';
  id: number;
  price: number | null;
  checkIn: string;
  email: string;
  phone: string;
  lang: string;
  guest: string;
};

const zl = (n: number) => `${n.toLocaleString('pl-PL', { maximumFractionDigits: 2 })} zł`;
const phoneDigits = (p: string) => {
  let d = p.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2); else if (d.length === 9) d = `48${d}`;
  return d.replace(/\D/g, '');
};

// Oferta cenowa: cena (lub korekta ceny), zaliczka i termin, ważność. Gość dostaje e-mail z przyciskiem
// „Zobacz ofertę i zaakceptuj” — akceptuje cenę z obowiązkiem zapłaty; link można też wysłać SMS-em / WhatsAppem.
export default function OfferSheet({ target, onClose, onSent }: { target: OfferTarget; onClose: () => void; onSent: (o: Offer) => void }) {
  const [ps, setPs] = useState<PaymentSettings | null>(null);
  const [price, setPrice] = useState<number | null>(target.price);
  const [withDeposit, setWithDeposit] = useState(true);
  const [deposit, setDeposit] = useState<number | null>(null);
  const [depositDue, setDepositDue] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [message, setMessage] = useState('');
  const [lang, setLang] = useState<'pl' | 'en'>(target.lang === 'en' ? 'en' : 'pl');
  const [email, setEmail] = useState(!!target.email);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ offer: Offer; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.paymentSettings().then((s) => {
      setPs(s);
      setWithDeposit(!!s.deposit_percent);
      const cap = (d: string) => (d > target.checkIn ? target.checkIn : d);
      if (s.deposit_days != null) setDepositDue(cap(addDays(today(), s.deposit_days)));
      if (s.offer_days) setValidUntil(cap(addDays(today(), s.offer_days)));
    }).catch(() => {});
  }, [target.checkIn]);

  // zaliczka domyślnie jako % ceny (zaokrąglona do 10 zł), dopóki admin jej nie zmieni
  const [depositTouched, setDepositTouched] = useState(false);
  useEffect(() => {
    if (depositTouched || !ps?.deposit_percent || price == null) return;
    setDeposit(Math.round((price * ps.deposit_percent) / 100 / 10) * 10);
  }, [price, ps, depositTouched]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (price == null || price <= 0) return setError('Podaj cenę za cały pobyt');
    if (withDeposit && deposit != null && deposit > price) return setError('Zaliczka nie może być większa niż cena');
    setBusy(true);
    setError('');
    try {
      const body = {
        price, deposit: withDeposit ? deposit : null, deposit_due: withDeposit && depositDue ? depositDue : null,
        valid_until: validUntil || null, message, email, lang,
      };
      const res = target.kind === 'request' ? await api.requestOffer(target.id, body) : await api.reservationOffer(target.id, body);
      setDone(res);
      onSent(res.offer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shareText = done ? `${lang === 'en' ? 'Your stay offer' : 'Oferta pobytu'}: ${done.offer.url}` : '';
  const copy = async () => {
    if (!done) return;
    try { await navigator.clipboard.writeText(done.offer.url); setCopied(true); } catch { prompt('Skopiuj link:', done.offer.url); }
  };
  const wa = target.phone ? phoneDigits(target.phone) : '';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Oferta cenowa">
        <header className="sheet-head">
          <button type="button" className="link" onClick={onClose}>{done ? 'Gotowe' : 'Anuluj'}</button>
          <h2>Oferta dla gościa</h2>
          {done ? <span className="head-spacer" /> : <button type="button" className="link strong" disabled={busy} onClick={submit}>{busy ? '…' : 'Wyślij'}</button>}
        </header>
        <div className="sheet-body">
          {done ? (
            <div className="offer-done">
              <div className="done-mark" aria-hidden>✓</div>
              <h3>{done.emailed ? `Oferta wysłana na ${target.email}` : 'Oferta gotowa'}</h3>
              <p className="muted">
                {zl(done.offer.price)}{done.offer.deposit ? ` · zaliczka ${zl(done.offer.deposit)}` : ''}
                {done.offer.valid_until ? ` · ważna do ${formatShort(done.offer.valid_until)}` : ''}.
                Gdy gość kliknie „Akceptuję”, dostaniesz powiadomienie{target.kind === 'request' ? ', a rezerwacja sama trafi do kalendarza' : ''}.
              </p>
              <div className="offer-link"><code>{done.offer.url}</code></div>
              <div className="share-buttons">
                <button type="button" className="btn" onClick={copy}>{copied ? 'Skopiowano ✓' : 'Kopiuj link'}</button>
                {'share' in navigator && <button type="button" className="btn" onClick={() => navigator.share({ text: shareText }).catch(() => {})}>Udostępnij</button>}
                {target.phone && <a className="btn" href={`sms:${target.phone.replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(shareText)}`}>SMS</a>}
                {wa.length >= 10 && <a className="btn" href={`https://wa.me/${wa}?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a>}
              </div>
            </div>
          ) : (
            <>
              <p className="muted small-note">
                {target.guest} dostanie ofertę z przyciskiem <b>„Zobacz ofertę i zaakceptuj”</b>. Akceptując, potwierdza rezerwację i zobowiązuje się do zapłaty{withDeposit ? ' oraz wpłaty zaliczki w terminie' : ''}.
              </p>
              <fieldset>
                <legend>Cena</legend>
                <label className="full">Cena za cały pobyt (zł)
                  <NumInput value={price} onChange={setPrice} placeholder="np. 1500" />
                </label>
                {target.price != null && price != null && price !== target.price && (
                  <p className="full muted">Wycena wg cennika: {zl(target.price)} → {price < target.price ? 'rabat' : 'dopłata'} {zl(Math.abs(target.price - price))}</p>
                )}
              </fieldset>
              <fieldset>
                <label className="check-row full"><input type="checkbox" checked={withDeposit} onChange={(e) => setWithDeposit(e.target.checked)} /> Z zaliczką</label>
                {withDeposit && (
                  <>
                    <label>Zaliczka (zł)<NumInput value={deposit} onChange={(v) => { setDepositTouched(true); setDeposit(v); }} /></label>
                    <label>Wpłata do<input type="date" value={depositDue} min={today()} onChange={(e) => setDepositDue(e.target.value)} /></label>
                    {price != null && price > 0 && (
                      <div className="full chips">
                        {[20, 30, 50].map((p) => (
                          <button type="button" key={p} className="chip" onClick={() => { setDepositTouched(true); setDeposit(Math.round((price * p) / 100 / 10) * 10); }}>{p}%</button>
                        ))}
                      </div>
                    )}
                    {ps && !ps.account_number && <p className="full warn">Brak numeru konta — uzupełnij w Ustawienia → Płatności i rachunki (gość zobaczy go po akceptacji).</p>}
                  </>
                )}
              </fieldset>
              <fieldset>
                <legend>Szczegóły</legend>
                <label>Oferta ważna do<input type="date" value={validUntil} min={today()} max={target.checkIn} onChange={(e) => setValidUntil(e.target.value)} /></label>
                <label>Język
                  <select value={lang} onChange={(e) => setLang(e.target.value as 'pl' | 'en')}>
                    <option value="pl">polski</option><option value="en">angielski</option>
                  </select>
                </label>
                <label className="full">Wiadomość dla gościa (opcjonalnie)
                  <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="np. W tym terminie mamy promocję — cena obejmuje parking." />
                </label>
                <label className="check-row full">
                  <input type="checkbox" checked={email} disabled={!target.email} onChange={(e) => setEmail(e.target.checked)} />
                  {target.email ? `Wyślij e-mailem na ${target.email}` : 'Brak e-maila gościa — dostaniesz link do wysłania SMS-em'}
                </label>
              </fieldset>
              {error && <div className="banner error">{error}</div>}
              <button type="button" className="btn primary big" disabled={busy} onClick={submit}>{busy ? 'Wysyłanie…' : email ? 'Wyślij ofertę' : 'Utwórz link do oferty'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
