import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ChosenExtra, UnitExtra } from '../types';
import { fmt } from '../money';
import Stepper from './Stepper';

// Opcje płatne w rezerwacji: lista opcji z ceną dla wybranego domku (obowiązkowe zaznaczone od razu w nowej rezerwacji)
// + własne pozycje (np. drewno do kominka). Cena i ilość zapisują się w rezerwacji jako kopia.

export const extrasTotal = (list: ChosenExtra[], nights: number) =>
  list.reduce((s, e) => s + e.price * e.qty * (e.per === 'night' ? nights : 1), 0);

export const parseExtras = (raw: string | null | undefined): ChosenExtra[] => {
  try { const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch { return []; }
};

const fromUnit = (e: UnitExtra, qty = 1): ChosenExtra =>
  ({ id: e.id, name: e.name, name_en: e.name_en, price: e.price, per: e.per, qty, total: 0, ...(e.required ? { required: true } : {}) });

type Props = {
  unitId: number; nights: number; currency: string; value: ChosenExtra[]; onChange: (v: ChosenExtra[]) => void;
  autoRequired: boolean; // nowa rezerwacja: dodaj obowiązkowe opcje domku (także po zmianie domku)
};

export default function ExtrasPicker({ unitId, nights, currency, value, onChange, autoRequired }: Props) {
  const [available, setAvailable] = useState<UnitExtra[]>([]);
  const [custom, setCustom] = useState<{ name: string; price: string; per: 'stay' | 'night' } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.unitExtras(unitId).then((list) => {
      if (cancelled) return;
      setAvailable(list);
      if (autoRequired) {
        // obowiązkowe opcje nowego domku (z jego ceną); pozostałe wybory zostają
        const keep = value.filter((c) => !c.required);
        const req = list.filter((e) => e.required && !keep.some((c) => c.id === e.id)).map((e) => fromUnit(e));
        const next = [...req, ...keep];
        if (JSON.stringify(next) !== JSON.stringify(value)) onChange(next);
      }
    }).catch(() => setAvailable([]));
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitId]);

  const chosen = (id: number) => value.find((c) => c.id === id && id > 0);
  const toggle = (e: UnitExtra) => onChange(chosen(e.id) ? value.filter((c) => c.id !== e.id) : [...value, fromUnit(e)]);
  const setQty = (i: number, qty: number) => onChange(value.map((c, j) => (j === i ? { ...c, qty } : c)));
  const setPrice = (i: number, price: number) => onChange(value.map((c, j) => (j === i ? { ...c, price } : c)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const lineTotal = (c: ChosenExtra) => c.price * c.qty * (c.per === 'night' ? nights : 1);
  const total = extrasTotal(value, nights);
  const others = value.map((c, i) => [c, i] as const).filter(([c]) => !available.some((e) => e.id === c.id && c.id > 0));
  const maxOf = (id: number) => available.find((e) => e.id === id)?.max_qty ?? 99;

  const addCustom = () => {
    if (!custom) return;
    const price = Number(custom.price.replace(',', '.'));
    if (!custom.name.trim() || !Number.isFinite(price) || price < 0) return;
    onChange([...value, { id: 0, name: custom.name.trim(), price, per: custom.per, qty: 1, total: 0 }]);
    setCustom(null);
  };

  return (
    <div className="extras-picker full">
      {available.length === 0 && value.length === 0 && <p className="muted small-note">Brak opcji płatnych dla tego domku (dodasz je w Cenniku).</p>}
      <ul className="picker-list">
        {available.map((e) => {
          const c = chosen(e.id);
          const i = c ? value.indexOf(c) : -1;
          return (
            <li key={e.id} className={c ? 'is-on' : ''}>
              <label className="check-row picker-check">
                <input type="checkbox" checked={!!c} onChange={() => toggle(e)} />
                <span>
                  {e.name}{e.required && <span className="tag-required">obowiązkowa</span>}
                  <small className="muted"> {fmt(c?.price ?? e.price, currency)} / {e.per === 'night' ? 'noc' : 'pobyt'}{!e.active && ' · niewidoczna na stronie'}</small>
                </span>
              </label>
              {c && (
                <div className="picker-qty">
                  {e.max_qty > 1 && <Stepper label={`${e.name}: liczba`} min={1} max={e.max_qty} value={c.qty} onChange={(q) => setQty(i, q)} />}
                  <b>{fmt(lineTotal(c), currency)}</b>
                </div>
              )}
            </li>
          );
        })}
        {others.map(([c, i]) => (
          <li key={`x${i}`} className="is-on">
            <span className="picker-custom">
              {c.name}{c.required && <span className="tag-required">obowiązkowa</span>}
              <small className="muted"> {c.per === 'night' ? 'za noc' : 'za pobyt'}</small>
            </span>
            <div className="picker-qty">
              <input className="picker-price" inputMode="decimal" aria-label={`${c.name}: cena`} value={String(c.price)} onChange={(ev) => setPrice(i, Number(ev.target.value.replace(',', '.')) || 0)} />
              <Stepper label={`${c.name}: liczba`} min={1} max={maxOf(c.id)} value={c.qty} onChange={(q) => setQty(i, q)} />
              <b>{fmt(lineTotal(c), currency)}</b>
              <button type="button" className="link danger-link" onClick={() => remove(i)} aria-label={`Usuń ${c.name}`}>✕</button>
            </div>
          </li>
        ))}
      </ul>
      {custom ? (
        <div className="picker-add">
          <input placeholder="Nazwa, np. drewno do kominka" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
          <input inputMode="decimal" placeholder="Cena" value={custom.price} onChange={(e) => setCustom({ ...custom, price: e.target.value })} />
          <select value={custom.per} onChange={(e) => setCustom({ ...custom, per: e.target.value as 'stay' | 'night' })}>
            <option value="stay">za pobyt</option>
            <option value="night">za noc</option>
          </select>
          <button type="button" className="btn small primary" onClick={addCustom}>Dodaj</button>
          <button type="button" className="btn small" onClick={() => setCustom(null)}>Anuluj</button>
        </div>
      ) : (
        <button type="button" className="btn small" onClick={() => setCustom({ name: '', price: '', per: 'stay' })}>＋ Inna pozycja</button>
      )}
      {value.length > 0 && <p className="picker-total">Opcje razem: <b>{fmt(total, currency)}</b> <span className="muted">— wliczone w cenę rezerwacji</span></p>}
    </div>
  );
}
