import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { BookingRequest, ChosenExtra, Reservation } from '../types';
import { SOURCES } from '../types';
import { diffDays, formatShort, nightsLabel } from '../dates';

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

  useEffect(() => {
    api.requests('pending').then((r) => { setPending(r); setError(''); }).catch((e) => setError(e.message));
    if (showDecided) api.requests('decided').then(setDecided).catch(() => {});
  }, [version, showDecided]);

  useEffect(() => {
    if (focusId && pending) document.getElementById(`request-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusId, pending]);

  return (
    <section className="requests">
      <div className="page-intro">
        <h1>Zapytania ze strony</h1>
        <p className="muted">Goście wysyłają je przyciskiem <b>Zarezerwuj</b> na odmorzadogor.pl. Po akceptacji rezerwacja trafia do kalendarza, a gość dostaje e-mail z potwierdzeniem.</p>
      </div>
      {error && <div className="banner error">{error}</div>}
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
        <h2>Rozpatrzone</h2><span className="chev">{showDecided ? '▴' : '▾'}</span>
      </button>
      {showDecided && (decided.length ? decided.map((r) => (
        <div key={r.id} className={`request-card decided st-${r.status}`}>
          <div className="request-top">
            <span className={`pill pill-${r.status}`}>{r.status === 'accepted' ? 'Zaakceptowane' : 'Odrzucone'}</span>
            <span className="muted small-meta">{r.decided_by} · {r.decided_at && when(r.decided_at)}</span>
          </div>
          <div className="request-guest">{r.guest_name}</div>
          <div className="muted">{r.unit_name} · {r.property_name} · {formatShort(r.check_in)} – {formatShort(r.check_out)}</div>
          {r.decision_note && <p className="request-note">„{r.decision_note}”</p>}
        </div>
      )) : <p className="empty">Brak rozpatrzonych zapytań.</p>)}
    </section>
  );
}

function RequestCard({ r, readOnly, focused, onDone, onOpenReservation }: { r: BookingRequest; readOnly: boolean; focused: boolean; onDone: () => void; onOpenReservation: (r: Reservation) => void }) {
  const [mode, setMode] = useState<'idle' | 'accept' | 'reject'>('idle');
  const [price, setPrice] = useState(r.quoted_price == null ? '' : String(r.quoted_price));
  const [note, setNote] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [force, setForce] = useState(false);
  const nights = diffDays(r.check_in, r.check_out);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      if (mode === 'accept') {
        const res = await api.acceptRequest(r.id, { price: price.trim() === '' ? null : Number(price.replace(',', '.')), note, email: sendEmail, force });
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
      <div className="request-unit">{r.unit_name} <span className="muted">· {r.property_name}</span></div>

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

      {!readOnly && mode === 'idle' && (
        <div className="request-actions">
          <button className="btn primary" onClick={() => setMode('accept')}>Akceptuj</button>
          <button className="btn danger-outline" onClick={() => setMode('reject')}>Odrzuć</button>
        </div>
      )}

      {mode !== 'idle' && (
        <div className="decision">
          <h3>{mode === 'accept' ? 'Akceptacja — rezerwacja trafi do kalendarza' : 'Odrzucenie zapytania'}</h3>
          {mode === 'accept' && (
            <label>Cena za cały pobyt (zł)
              <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="np. 1500" />
            </label>
          )}
          <label>{mode === 'accept' ? 'Informacja dla gościa (np. zaliczka, numer konta, godzina przyjazdu)' : 'Wiadomość dla gościa (opcjonalnie)'}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'accept' ? 'Prosimy o wpłatę zaliczki 30% w ciągu 3 dni na konto…' : 'Niestety ten termin jest już zajęty. Wolne mamy…'} />
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
