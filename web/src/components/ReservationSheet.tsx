import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Guest } from '../api';
import type { Draft, Property, Reservation, Status } from '../types';
import { SOURCES, STATUS_LABELS } from '../types';
import { addDays, diffDays, formatShort, nightsLabel } from '../dates';
import { CURRENCIES, GUEST_LANGS, currencySymbol, type GuestLang } from '../money';
import Stepper from './Stepper';
import ExtrasPicker, { extrasTotal, parseExtras } from './ExtrasPicker';
import type { ChosenExtra } from '../types';
import DateInput from './DateInput';

type Props = { draft: Draft; properties: Property[]; onClose: () => void; onSaved: (saved: Reservation | null) => void };
type Conflict = { id: number; check_in: string; check_out: string; guest_name: string; source: string };

export default function ReservationSheet({ draft, properties, onClose, onSaved }: Props) {
  const [r, setR] = useState<Draft>(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [guests, setGuests] = useState<Guest[]>([]);
  const alertRef = useRef<HTMLDivElement>(null);
  const imported = Boolean(draft.feed_id);
  const nights = diffDays(r.check_in, r.check_out);
  const unit = properties.flatMap((p) => p.units).find((u) => u.id === r.unit_id);
  // Opcje płatne (sprzątanie, parking…): ich suma jest częścią ceny — zmiana opcji lub liczby nocy poprawia cenę o różnicę
  const [extras, setExtras] = useState<ChosenExtra[]>(() => parseExtras(draft.extras));
  const total = Math.round(extrasTotal(extras, Math.max(1, nights)) * 100) / 100;
  const prevTotal = useRef(total);
  useEffect(() => {
    const delta = total - prevTotal.current;
    prevTotal.current = total;
    if (delta) setR((prev) => (prev.price == null ? prev : { ...prev, price: Math.round((prev.price + delta) * 100) / 100 }));
  }, [total]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setR((prev) => ({ ...prev, [key]: value }));
    setConflicts([]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (conflicts.length || error) alertRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [conflicts, error]);

  // Podpowiedzi stałych gości
  useEffect(() => {
    if (r.guest_name.trim().length < 2 || r.id) { setGuests([]); return; }
    const t = setTimeout(() => api.guests(r.guest_name).then(setGuests).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [r.guest_name, r.id]);

  const pickGuest = (name: string) => {
    const g = guests.find((x) => x.guest_name === name);
    if (g) setR((prev) => ({ ...prev, guest_phone: prev.guest_phone || g.guest_phone, guest_email: prev.guest_email || g.guest_email }));
  };

  const save = async (e?: FormEvent, force = false) => {
    e?.preventDefault();
    if (r.check_out <= r.check_in) { setError('Data wyjazdu musi być późniejsza niż przyjazdu'); return; }
    setSaving(true);
    setError('');
    try {
      // opcje jako lista (serwer liczy sumy i zapisuje kopię)
      onSaved(await api.saveReservation({ ...r, extras: extras as unknown as string }, force));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflicts(err.data.conflicts as Conflict[]);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!r.id) return;
    const msg = imported
      ? 'Ta rezerwacja pochodzi z Booking.com. Jeśli nadal jest w kalendarzu Bookingu, pojawi się ponownie przy synchronizacji. Usunąć?'
      : 'Usunąć tę rezerwację? Tej operacji nie można cofnąć.';
    if (!confirm(msg)) return;
    setSaving(true);
    try {
      await api.deleteReservation(r.id);
      onSaved(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const numberField = (key: 'price' | 'paid' | 'deposit', v: string) => set(key, v === '' ? null : Number(v.replace(',', '.')));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <header className="sheet-head">
          <button type="button" className="link" onClick={onClose}>Anuluj</button>
          <h2>{r.id ? 'Edycja rezerwacji' : 'Nowa rezerwacja'}</h2>
          <button type="submit" className="link strong" disabled={saving}>{saving ? 'Zapis…' : 'Zapisz'}</button>
        </header>

        <div className="sheet-body">
          {imported && (
            <div className="banner info">
              Zaimportowano z {SOURCES[r.source] ?? r.source}. Możesz zmienić wszystko — jeśli zmienisz daty, synchronizacja nie będzie ich już nadpisywać
              (odwołanie na Bookingu dalej zostanie wykryte).
              {draft.external_summary && <small> ({draft.external_summary})</small>}
            </div>
          )}

          <fieldset>
            <label className="full">
              Domek / apartament
              <select value={r.unit_id} onChange={(e) => set('unit_id', Number(e.target.value))}>
                {properties.map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    {p.units.map((u) => <option key={u.id} value={u.id}>{u.name} (do {u.capacity} os.)</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              Przyjazd
              <DateInput required value={r.check_in} onChange={(v) => {
                if (!v) return;
                // zachowaj liczbę nocy przy zmianie przyjazdu
                setR((prev) => ({ ...prev, check_in: v, check_out: addDays(v, Math.max(1, diffDays(prev.check_in, prev.check_out))) }));
                setConflicts([]);
              }} />
            </label>
            <label>
              Wyjazd
              <DateInput required value={r.check_out} min={addDays(r.check_in, 1)} onChange={(v) => v && set('check_out', v)} />
            </label>
            <div className="field nights-field">
              Liczba nocy
              <Stepper label="Liczba nocy" min={1} max={365} value={nights} onChange={(n) => set('check_out', addDays(r.check_in, n))} />
            </div>
            <div className="full chips">
              {[1, 2, 3, 4, 5, 6, 7, 14].map((n) => (
                <button type="button" key={n} className={`chip ${nights === n ? 'active' : ''}`} onClick={() => set('check_out', addDays(r.check_in, n))}>
                  {nightsLabel(n)}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Gość</legend>
            <label className="full">
              Imię i nazwisko
              <input list="guest-suggestions" autoComplete="off" value={r.guest_name}
                onChange={(e) => { set('guest_name', e.target.value); pickGuest(e.target.value); }} />
              <datalist id="guest-suggestions">
                {guests.map((g) => <option key={`${g.guest_name}${g.guest_phone}`} value={g.guest_name}>{g.guest_phone} · {g.stays}× pobyt</option>)}
              </datalist>
            </label>
            <label>
              Telefon
              <input type="tel" inputMode="tel" value={r.guest_phone} onChange={(e) => set('guest_phone', e.target.value)} />
            </label>
            <label>
              E-mail
              <input type="email" inputMode="email" value={r.guest_email} onChange={(e) => set('guest_email', e.target.value)} />
            </label>
            <div className="field">
              Dorośli
              <Stepper label="Dorośli" value={r.adults} onChange={(v) => set('adults', v)} />
            </div>
            <div className="field">
              Dzieci
              <Stepper label="Dzieci" value={r.children} onChange={(v) => set('children', v)} />
            </div>
            {unit && r.adults + r.children > unit.capacity && (
              <p className="full warn">Uwaga: {unit.name} mieści maksymalnie {unit.capacity} osób.</p>
            )}
          </fieldset>

          <fieldset>
            <legend>Opcje płatne</legend>
            <ExtrasPicker unitId={r.unit_id} nights={Math.max(1, nights)} currency={r.currency ?? 'PLN'} value={extras} onChange={setExtras} autoRequired={!r.id && !imported} />
          </fieldset>

          <fieldset>
            <legend>Szczegóły</legend>
            <label>
              Źródło
              <select value={r.source} onChange={(e) => set('source', e.target.value)}>
                {Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>
              Status
              <select value={r.status} onChange={(e) => set('status', e.target.value as Status)}>
                {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>
              {extras.length ? 'Cena z opcjami' : 'Cena'} ({currencySymbol(r.currency)})
              <input inputMode="decimal" value={r.price ?? ''} onChange={(e) => numberField('price', e.target.value)} />
            </label>
            <label>
              Wpłacono ({currencySymbol(r.currency)})
              <input inputMode="decimal" value={r.paid ?? ''} onChange={(e) => numberField('paid', e.target.value)} />
            </label>
            <label>
              Zaliczka ({currencySymbol(r.currency)})
              <input inputMode="decimal" value={r.deposit ?? ''} placeholder="brak" onChange={(e) => numberField('deposit', e.target.value)} />
            </label>
            <label>
              Zaliczka do
              <DateInput value={r.deposit_due ?? ''} disabled={!r.deposit} onChange={(v) => set('deposit_due', v || null)} />
            </label>
            <label>
              Waluta
              <select value={r.currency ?? 'PLN'} onChange={(e) => set('currency', e.target.value)}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>
              Język e-maili do gościa
              <select value={r.lang ?? 'pl'} onChange={(e) => set('lang', e.target.value as GuestLang)}>
                {GUEST_LANGS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </label>
            {r.price != null && r.price > 0 && (r.paid ?? 0) < r.price && (
              <button type="button" className="chip full paid-chip" onClick={() => set('paid', r.price)}>✓ Zapłacone w całości</button>
            )}
            <label className="full">
              Notatki
              <textarea rows={3} value={r.notes} placeholder="np. zwierzę, późny przyjazd, faktura, kod do sejfu…" onChange={(e) => set('notes', e.target.value)} />
            </label>
          </fieldset>

          <div ref={alertRef} />
          {conflicts.length > 0 && (
            <div className="banner error">
              <strong>Termin nakłada się z:</strong>
              <ul>
                {conflicts.map((c) => (
                  <li key={c.id}>{c.guest_name || SOURCES[c.source] || c.source}: {formatShort(c.check_in)} – {formatShort(c.check_out)}</li>
                ))}
              </ul>
              <button type="button" className="btn danger" onClick={() => save(undefined, true)}>Zapisz mimo to</button>
            </div>
          )}
          {error && <div className="banner error">{error}</div>}

          <div className="sheet-actions">
            <button type="submit" className="btn primary big" disabled={saving}>{saving ? 'Zapisywanie…' : 'Zapisz rezerwację'}</button>
            {r.id && <button type="button" className="btn danger-outline" onClick={remove} disabled={saving}>Usuń rezerwację</button>}
          </div>
        </div>
      </form>
    </div>
  );
}
