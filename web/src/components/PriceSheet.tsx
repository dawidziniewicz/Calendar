import { useState } from 'react';
import { api, type RatePatch } from '../api';
import type { Property } from '../types';
import { diffDays, formatShort, nightsLabel } from '../dates';
import { groupUnits } from '../pricing';
import DateInput from './DateInput';

type Props = {
  properties: Property[];
  unitId: number;
  from: string; // pierwsza noc
  to: string; // ostatnia noc (włącznie)
  onClose: () => void;
  onSaved: () => void;
};

const WEEKDAYS = [[1, 'Pn'], [2, 'Wt'], [3, 'Śr'], [4, 'Cz'], [5, 'Pt'], [6, 'So'], [0, 'Nd']] as const;

// Ustawienie ceny za noc, minimalnego pobytu i blokady rezerwacji online dla zakresu dni.
export default function PriceSheet({ properties, unitId, from: initialFrom, to: initialTo, onClose, onSaved }: Props) {
  const units = properties.flatMap((p) => p.units.map((u) => ({ ...u, property: p.name })));
  const unit = units.find((u) => u.id === unitId);
  // Domki tego samego typu mają wspólne ceny — wybiera się cały typ (pierwszy domek grupy reprezentuje typ)
  const groups = properties.map((p) => ({ property: p, groups: groupUnits(p.units) }));
  const groupOf = (id: number) => groups.flatMap((x) => x.groups).find((g) => g.units.some((u) => u.id === id));
  const [selected, setSelected] = useState<number[]>([groupOf(unitId)?.units[0].id ?? unitId]);
  const unitCount = selected.reduce((n, id) => n + (groupOf(id)?.units.length ?? 1), 0);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [weekdays, setWeekdays] = useState<number[]>([]); // puste = wszystkie dni
  const [price, setPrice] = useState('');
  const [resetPrice, setResetPrice] = useState(false);
  const [minNights, setMinNights] = useState('keep');
  const [closed, setClosed] = useState('keep');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const days = Math.max(0, diffDays(from, to) + 1);

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const nothing = !resetPrice && price.trim() === '' && minNights === 'keep' && closed === 'keep';

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const patch: RatePatch = { unit_ids: selected, from, to };
    if (weekdays.length && weekdays.length < 7) patch.weekdays = weekdays;
    if (resetPrice) patch.price = null;
    else if (price.trim() !== '') {
      const n = Number(price.replace(',', '.').replace(/\s/g, ''));
      if (!Number.isFinite(n) || n < 0) return setError('Podaj poprawną cenę');
      patch.price = n;
    }
    if (minNights === 'reset') patch.min_nights = null;
    else if (minNights !== 'keep') patch.min_nights = Number(minNights);
    if (closed !== 'keep') patch.closed = closed === 'closed';
    setBusy(true);
    setError('');
    try {
      await api.saveRates(patch);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet" onSubmit={save}>
        <div className="sheet-head">
          <button type="button" className="link" onClick={onClose}>Anuluj</button>
          <h2>Ceny · {formatShort(from)}{from !== to && ` – ${formatShort(to)}`}</h2>
          <button type="submit" className="link strong" disabled={busy || nothing || !selected.length || days < 1}>{busy ? '…' : 'Zapisz'}</button>
        </div>
        <div className="sheet-body">
          <fieldset>
            <legend>Zakres</legend>
            <label>Od nocy<DateInput value={from} onChange={(v) => v && setFrom(v)} /></label>
            <label>Do nocy (włącznie)<DateInput value={to} min={from} onChange={(v) => v && setTo(v)} /></label>
            <div className="field full">
              Tylko wybrane dni tygodnia {weekdays.length > 0 && <span className="muted">· pozostałe bez zmian</span>}
              <div className="chips weekday-chips">
                {WEEKDAYS.map(([d, l]) => (
                  <button type="button" key={d} className={`chip ${weekdays.includes(d) ? 'active' : ''}`} onClick={() => setWeekdays(toggle(weekdays, d))}>{l}</button>
                ))}
                <button type="button" className="chip" onClick={() => setWeekdays([5, 6])}>Weekendy</button>
              </div>
            </div>
            <p className="full muted">{nightsLabel(days)}{weekdays.length ? ' (w wybrane dni tygodnia)' : ''}. Cena dotyczy nocy zaczynającej się danego dnia.</p>
          </fieldset>

          <fieldset>
            <legend>Cena za noc</legend>
            <label className="full">Nowa cena (zł)
              <input inputMode="decimal" placeholder={unit?.base_price != null ? `podstawowa: ${unit.base_price} zł` : 'np. 450'} value={price}
                disabled={resetPrice} onChange={(e) => setPrice(e.target.value)} />
            </label>
            <label className="check-row full">
              <input type="checkbox" checked={resetPrice} onChange={(e) => setResetPrice(e.target.checked)} />
              Przywróć cenę podstawową domku
            </label>
          </fieldset>

          <fieldset>
            <legend>Zasady</legend>
            <label>Minimalny pobyt
              <select value={minNights} onChange={(e) => setMinNights(e.target.value)}>
                <option value="keep">bez zmian</option>
                <option value="reset">jak w ustawieniach domku</option>
                {[1, 2, 3, 4, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{nightsLabel(n)}</option>)}
              </select>
            </label>
            <label>Rezerwacje online
              <select value={closed} onChange={(e) => setClosed(e.target.value)}>
                <option value="keep">bez zmian</option>
                <option value="open">otwarte</option>
                <option value="closed">zamknięte (tylko telefonicznie)</option>
              </select>
            </label>
          </fieldset>

          <fieldset>
            <legend>Domki</legend>
            <div className="full unit-picks">
              {groups.map(({ property: p, groups: gs }) => (
                <div key={p.id}>
                  <div className="muted unit-picks-prop">{p.name}</div>
                  {gs.map((g) => (
                    <label key={g.key} className="check-row">
                      <input type="checkbox" checked={selected.includes(g.units[0].id)} onChange={() => setSelected(toggle(selected, g.units[0].id))} />
                      <i className="unit-dot" style={{ background: g.units[0].color }} /> {g.type ?? g.units[0].name}
                      {g.units.length > 1 && <small className="muted"> · {g.units.length} domki, wspólna cena</small>}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </fieldset>
          {error && <div className="banner error">{error}</div>}
          <button type="submit" className="btn primary big" disabled={busy || nothing || !selected.length || days < 1}>
            {busy ? 'Zapisywanie…' : `Zapisz dla ${unitCount === 1 ? '1 domku' : `${unitCount} domków`}`}
          </button>
        </div>
      </form>
    </div>
  );
}
