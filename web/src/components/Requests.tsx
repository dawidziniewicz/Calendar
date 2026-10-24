import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { BookingRequest, ChosenExtra, Reservation } from '../types';
import { SOURCES } from '../types';
import { addDays, diffDays, formatShort, nightsLabel, today } from '../dates';
import OfferSheet from './OfferSheet';
import NumInput from './NumInput';
import { fmt } from '../money';

type Props = {
  version: number;
  readOnly: boolean;
  focusId: number | null; // otwarte z powiadomienia
  onChanged: () => void;
  onOpenReservation: (r: Reservation) => void;
};

const zl = (n: number | null) => (n == null ? 'do ustalenia' : `${n.toLocaleString('pl-PL')} zł`);
const people = (r: BookingRequest) => `${r.adults} dor.${r.children ? ` + ${r.children} dz.` : ''}`;
const chosenExtras = (r: BookingRequest): ChosenExtra[] => { try { return r.extras ? JSON.parse(r.extras) : []; } catch { return []; } };
const when = (sqlUtc: string) => new Date(`${sqlUtc.replace(' ', 'T')}Z`).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function Requests({ version, readOnly, focusId, onChanged, onOpenReservation }: Props) {
  const [pending, setPending] = useState<BookingRequest[] | null>(null);
  const [decided, setDecided] = useState<BookingRequest[]>([]);
  const [showDecided, setShowDecided] = useState(false);
  const [error, setError] = useState('');
  const [cancels, setCancels] = useState<BookingRequest[]>([]);

  useEffect(() => {
    api.requests('pending').then((r) => { setPending(r); setError(''); }).catch((e) => setError(e.message));
    api.cancellations().then(setCancels).catch(() => {});
    if (showDecided) api.requests('decided').then(setDecided).catch(() => {});
  }, [version, showDecided]);

  useEffect(() => {
    if (focusId && pending) document.getElementById(`request-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusId, pending]);

  return (
    <section className="requests">
      <div className="page-intro">
        <h1>Zapytania ze strony</h1>
        <p className="muted">Goście wysyłają je przyciskiem <b>Zarezerwuj</b> na odmorzadogor.pl. Możesz je od razu zaakceptować albo <b>zaproponować cenę</b> — gość akceptuje ją linkiem z e-maila (z obowiązkiem zapłaty), a rezerwacja sama trafia do kalendarza.</p>
      </div>
      {error && <div className="banner error">{error}</div>}
      {cancels.length > 0 && (
        <div className="cancel-section">
          <h2 className="cancel-head">Prośby o anulację <span className="count danger">{cancels.length}</span></h2>
          {cancels.map((r) => <CancelCard key={r.id} r={r} readOnly={readOnly} focused={r.id === focusId} onDone={onChanged} />)}
        </div>
      )}
      {pending === null && !error && <p className="muted">Wczytywanie…</p>}
      {pending?.length === 0 && (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 13h4l2 3h4l2-3h4" /><path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z" /></svg>
          <b>Brak nowych zapytań</b>
          <span className="muted">Nowe pojawią się tutaj — dostaniesz też powiadomienie.</span>
        </div>
      )}
      {pending?.map((r) => (
        <RequestCard key={r.id} r={r} readOnly={readOnly} focused={r.id === focusId} onDone={onChanged} onOpenReservation={onOpenReservation} />
      ))}

      <button className="collapse-head decided-head" onClick={() => setShowDecided(!showDecided)} aria-expanded={showDecided}>
        <h2>Rozpatrzone i archiwum</h2><span className="chev">{showDecided ? '▴' : '▾'}</span>
      </button>
      <p className="muted small-note archive-note">Zapytania bez decyzji, których data przyjazdu minęła, trafiają tu automatycznie.</p>
      {showDecided && (decided.length ? decided.map((r) => (
        <div key={r.id} className={`request-card decided st-${r.status === 'pending' ? 'expired' : r.status}`}>
          <div className="request-top">
            {r.status === 'pending'
              ? <span className="pill">Wygasłe — termin minął</span>
              : <span className={`pill pill-${r.status}`}>{r.status === 'accepted' ? 'Zaakceptowane' : 'Odrzucone'}</span>}
            <span className="muted small-meta">{r.status === 'pending' ? `wysłane ${when(r.created_at)}` : <>{r.decided_by} · {r.decided_at && when(r.decided_at)}</>}</span>
          </div>
          <div className="request-guest">{r.guest_name}</div>
          <div className="muted">{r.unit_name} · {r.property_name} · {formatShort(r.check_in)} – {formatShort(r.check_out)}</div>
          {r.decision_note && <p className="request-note">„{r.decision_note}”</p>}
        </div>
      )) : <p className="empty">Brak rozpatrzonych zapytań.</p>)}
    </section>
  );
}

// Gość kliknął „Poproś o anulację” w e-mailu z potwierdzeniem
function CancelCard({ r, readOnly, focused, onDone }: { r: BookingRequest; readOnly: boolean; focused: boolean; onDone: () => void }) {
  const [mode, setMode] = useState<'idle' | 'confirm' | 'decline'>('idle');
  const [note, setNote] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await (mode === 'confirm' ? api.cancelConfirm : api.cancelDecline)(r.id, { note, email: sendEmail });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article id={`request-${r.id}`} className={`request-card cancel-card ${focused ? 'focused' : ''}`}>
      <div className="request-top">
        <span className="pill pill-rejected">Prośba o anulację</span>
        <span className="muted small-meta">{r.cancel_requested_at && when(r.cancel_requested_at)}</span>
      </div>
      <div className="request-guest">{r.guest_name}</div>
      <div className="request-unit">{r.unit_name} <span className="muted">· {r.property_name} · {formatShort(r.check_in)} – {formatShort(r.check_out)}</span></div>
      {r.cancel_reason ? <p className="request-message">„{r.cancel_reason}”</p> : <p className="muted small-note">Gość nie podał powodu.</p>}
      <div className="request-contact">
        {r.guest_phone && <a className="btn small" href={`tel:${r.guest_phone.replace(/\s/g, '')}`}>Zadzwoń · {r.guest_phone}</a>}
        <a className="btn small" href={`mailto:${r.guest_email}`}>{r.guest_email}</a>
      </div>
      {!readOnly && mode === 'idle' && (
        <div className="request-actions">
          <button className="btn danger" onClick={() => setMode('confirm')}>Potwierdź anulację</button>
          <button className="btn" onClick={() => setMode('decline')}>Odrzuć prośbę</button>
        </div>
      )}
      {mode !== 'idle' && (
        <div className="decision">
          <h3>{mode === 'confirm' ? 'Anulowanie — rezerwacja zniknie z kalendarza, termin się zwolni' : 'Odrzucenie prośby — rezerwacja zostaje'}</h3>
          <label>{mode === 'confirm' ? 'Informacja dla gościa (np. zwrot zaliczki)' : 'Wiadomość dla gościa (np. warunki zaliczki)'}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'confirm' ? 'Zaliczkę zwrócimy w ciągu 7 dni na konto, z którego przyszła.' : 'Zgodnie z warunkami rezerwacji zaliczka jest bezzwrotna, ale możemy przenieść pobyt na inny termin.'} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} /> Wyślij gościowi e-mail z odpowiedzią
          </label>
          {error && <div className="banner error">{error}</div>}
          <div className="request-actions">
            <button className={`btn ${mode === 'confirm' ? 'danger' : 'primary'}`} disabled={busy} onClick={submit}>
              {busy ? 'Zapisywanie…' : mode === 'confirm' ? 'Anuluj rezerwację' : 'Odrzuć prośbę'}
            </button>
            <button className="btn" disabled={busy} onClick={() => { setMode('idle'); setError(''); }}>Wróć</button>
          </div>
        </div>
      )}
    </article>
  );
}

function RequestCard({ r, readOnly, focused, onDone, onOpenReservation }: { r: BookingRequest; readOnly: boolean; focused: boolean; onDone: () => void; onOpenReservation: (r: Reservation) => void }) {
  const [mode, setMode] = useState<'idle' | 'accept' | 'reject'>('idle');
  const [offerOpen, setOfferOpen] = useState(false);
  const [deposit, setDeposit] = useState<number | null>(null);
  const [depositDue, setDepositDue] = useState(addDays(today(), 3) > r.check_in ? r.check_in : addDays(today(), 3));
  const offer = r.offer;
  const [price, setPrice] = useState(r.quoted_price == null ? '' : String(r.quoted_price));
  const [note, setNote] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [force, setForce] = useState(false);
  const nights = diffDays(r.check_in, r.check_out);
  // Typ domku: kilka takich samych domków — wybór, do którego przydzielić (auto = pierwszy wolny)
  const group = r.group_units ?? [];
  const isGroup = group.length > 1;
  const manual = r.assign_mode === 'manual';
  const [unitChoice, setUnitChoice] = useState<string>('');
  const autoUnit = group.find((g) => g.free) ?? group[0];

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      if (mode === 'accept') {
        if (isGroup && manual && !unitChoice) { setBusy(false); return setError('Wybierz domek, do którego przydzielić rezerwację'); }
        const res = await api.acceptRequest(r.id, {
          price: price.trim() === '' ? null : Number(price.replace(',', '.')), note, email: sendEmail, force,
          deposit, deposit_due: deposit ? depositDue : null,
          ...(unitChoice ? { unit_id: Number(unitChoice) } : {}),
        });
        onDone();
        onOpenReservation(res.reservation);
      } else {
        await api.rejectRequest(r.id, { note, email: sendEmail });
        onDone();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setForce(true);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article id={`request-${r.id}`} className={`request-card ${focused ? 'focused' : ''}`}>
      <div className="request-top">
        <span className="pill pill-pending">Nowe</span>
        {r.lang === 'en' && <span className="pill">EN</span>}
        <span className="muted small-meta">wysłane {when(r.created_at)}</span>
      </div>
      <div className="request-guest">{r.guest_name}</div>
      <div className="request-unit">
        {isGroup ? <>{group[0].type_name || r.unit_name} <span className="muted">· {r.property_name} · proponowany: {r.unit_name}</span></> : <>{r.unit_name} <span className="muted">· {r.property_name}</span></>}
      </div>

      <dl className="request-facts">
        <div><dt>Termin</dt><dd>{formatShort(r.check_in)} – {formatShort(r.check_out)}</dd></div>
        <div><dt>Noce</dt><dd>{nightsLabel(nights)}</dd></div>
        <div><dt>Goście</dt><dd>{people(r)}</dd></div>
        <div><dt>Wycena</dt><dd>{zl(r.quoted_price)}</dd></div>
      </dl>

      {r.conflicts.length > 0 && (
        <div className="banner error">
          Termin jest już zajęty: {r.conflicts.map((c) => `${c.guest_name || SOURCES[c.source] || c.source} (${formatShort(c.check_in)} – ${formatShort(c.check_out)})`).join(', ')}
        </div>
      )}
      {chosenExtras(r).length > 0 && (
        <ul className="request-extras">
          {chosenExtras(r).map((e) => (
            <li key={e.id}><span>{e.name}{e.qty > 1 && ` × ${e.qty}`} <small className="muted">({e.price} zł/{e.per === 'night' ? 'noc' : 'pobyt'})</small></span><b>{zl(e.total)}</b></li>
          ))}
        </ul>
      )}
      {r.message && <p className="request-message">{r.message}</p>}

      <div className="request-contact">
        {r.guest_phone && <a className="btn small" href={`tel:${r.guest_phone.replace(/\s/g, '')}`}>Zadzwoń · {r.guest_phone}</a>}
        <a className="btn small" href={`mailto:${r.guest_email}`}>{r.guest_email}</a>
      </div>

      {offer && (
        <div className={`offer-status offer-${offer.expired ? 'expired' : offer.status}`}>
          <b>Oferta {fmt(offer.price, offer.currency)}{offer.deposit ? ` · zaliczka ${fmt(offer.deposit, offer.currency)}` : ''}</b>
          <span>
            {offer.expired ? 'wygasła' : { sent: 'wysłana — czeka na akceptację gościa', accepted: 'zaakceptowana ✓', declined: 'gość odrzucił', withdrawn: 'wycofana' }[offer.status]}
            {offer.status === 'sent' && offer.valid_until && !offer.expired ? ` (ważna do ${formatShort(offer.valid_until)})` : ''}
          </span>
          {offer.decline_reason && <span className="muted">„{offer.decline_reason}”</span>}
          {offer.status === 'sent' && !offer.expired && !readOnly && (
            <span className="offer-links">
              <button type="button" className="link" onClick={() => navigator.clipboard?.writeText(offer.url).then(() => alert('Skopiowano link do oferty'), () => prompt('Link:', offer.url))}>Kopiuj link</button>
              <button type="button" className="link danger-link" onClick={() => api.withdrawOffer(offer.id).then(onDone).catch((e) => setError(e.message))}>Wycofaj</button>
            </span>
          )}
        </div>
      )}

      {!readOnly && mode === 'idle' && (
        <div className="request-actions">
          <button className="btn primary" onClick={() => setMode('accept')}>Akceptuj</button>
          <button className="btn" onClick={() => setOfferOpen(true)}>{offer && offer.status !== 'withdrawn' ? 'Nowa oferta' : 'Zaproponuj cenę'}</button>
          <button className="btn danger-outline" onClick={() => setMode('reject')}>Odrzuć</button>
        </div>
      )}
      {offerOpen && (
        <OfferSheet
          target={{ kind: 'request', currency: 'PLN', id: r.id, price: r.quoted_price, checkIn: r.check_in, email: r.guest_email, phone: r.guest_phone, lang: r.lang, guest: r.guest_name }}
          onClose={() => { setOfferOpen(false); onDone(); }}
          onSent={() => {}}
        />
      )}

      {mode !== 'idle' && (
        <div className="decision">
          <h3>{mode === 'accept' ? 'Akceptacja — rezerwacja trafi do kalendarza' : 'Odrzucenie zapytania'}</h3>
          {mode === 'accept' && isGroup && (
            <label>Przydziel do domku
              <select value={unitChoice} onChange={(e) => setUnitChoice(e.target.value)}>
                <option value="" disabled={manual}>{manual ? 'Wybierz domek…' : `Automatycznie — ${autoUnit?.name ?? ''}${autoUnit?.free ? ' (wolny)' : ''}`}</option>
                {group.map((g) => <option key={g.id} value={g.id}>{g.name} — {g.free ? 'wolny' : 'zajęty w tym terminie'}</option>)}
              </select>
            </label>
          )}
          {mode === 'accept' && (
            <label>Cena za cały pobyt (zł)
              <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="np. 1500" />
            </label>
          )}
          {mode === 'accept' && (
            <div className="row">
              <label>Zaliczka (zł, opcjonalnie)<NumInput value={deposit} onChange={setDeposit} placeholder="bez zaliczki" /></label>
              {deposit ? <label>Wpłata do<input type="date" value={depositDue} min={today()} onChange={(e) => setDepositDue(e.target.value)} /></label> : null}
            </div>
          )}
          {mode === 'accept' && deposit ? <p className="muted small-note">E-mail z potwierdzeniem zawiera kwotę zaliczki, termin i numer konta z ustawień.</p> : null}
          <label>{mode === 'accept' ? 'Informacja dla gościa (np. godzina przyjazdu, kod do skrzynki)' : 'Wiadomość dla gościa (opcjonalnie)'}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'accept' ? 'Zameldowanie od 15:00, wymeldowanie do 11:00.' : 'Niestety ten termin jest już zajęty. Wolne mamy…'} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
            {mode === 'accept' ? 'Wyślij gościowi e-mail z potwierdzeniem' : 'Wyślij gościowi e-mail z odmową (odznacz przy spamie)'}
          </label>
          {error && <div className="banner error">{error}{force && mode === 'accept' && ' — kliknij jeszcze raz, żeby mimo to zapisać.'}</div>}
          <div className="request-actions">
            <button className={`btn ${mode === 'accept' ? 'primary' : 'danger'}`} disabled={busy} onClick={submit}>
              {busy ? 'Zapisywanie…' : mode === 'accept' ? (force ? 'Zapisz mimo konfliktu' : 'Potwierdź rezerwację') : 'Odrzuć zapytanie'}
            </button>
            <button className="btn" disabled={busy} onClick={() => { setMode('idle'); setError(''); setForce(false); }}>Anuluj</button>
          </div>
        </div>
      )}
    </article>
  );
}
