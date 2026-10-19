import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Property, Rate, Unit } from '../types';
import { addDays, formatShort, nightsLabel, today } from '../dates';
import { WEEKDAYS, weekdayPrices } from '../pricing';
import PriceSheet from './PriceSheet';
import ExtrasPanel from './ExtrasPanel';

type Props = { properties: Property[]; canEditHorizon: boolean; onBack: () => void; reload: () => void };

const HORIZON_PRESETS = [90, 180, 365, 540];
const toNumber = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.').replace(/\s/g, '')));
const badNumber = (n: number | null) => n != null && (!Number.isFinite(n) || n < 0);

// Cennik: cena podstawowa, ceny wg dni tygodnia, ceny na konkretne dni i jak daleko do przodu widać ceny na stronie.
export default function PricingPage({ properties, canEditHorizon, onBack, reload }: Props) {
  const [rates, setRates] = useState<Rate[]>([]);
  const [ratesVersion, setRatesVersion] = useState(0);
  const [sheet, setSheet] = useState<{ unitId: number; from: string; to: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.rates(today(), addDays(today(), 731)).then(setRates).catch((e) => setError(e.message));
  }, [ratesVersion]);

  return (
    <section className="pricing-page">
      <div className="page-head">
        <button type="button" className="link back" onClick={onBack}>‹ Ustawienia</button>
        <h1>Cennik i rezerwacje online</h1>
      </div>
      <p className="muted page-lead">
        Cena nocy: najpierw <b>cena ustawiona na konkretny dzień</b>, potem <b>cena dnia tygodnia</b>, a jeśli jej nie ma — <b>cena podstawowa</b>.
        Goście widzą ceny na odmorzadogor.pl od razu po zapisaniu. Cena dotyczy nocy zaczynającej się danego dnia — weekend to noce z piątku i soboty.
      </p>
      {error && <div className="banner error">{error}</div>}

      <HorizonPanel canEdit={canEditHorizon} />
      <ExtrasPanel properties={properties} canEdit={canEditHorizon} />

      {properties.map((p) => (
        <div key={p.id} className="pricing-property">
          <h2 className="pricing-property-name">{p.name}</h2>
          {p.units.map((u) => (
            <UnitPricingCard
              key={u.id}
              unit={u}
              rates={rates.filter((r) => r.unit_id === u.id)}
              onSaved={reload}
              onAddDays={() => setSheet({ unitId: u.id, from: today(), to: addDays(today(), 6) })}
              onEditRange={(from, to) => setSheet({ unitId: u.id, from, to })}
              onRatesChanged={() => setRatesVersion((v) => v + 1)}
            />
          ))}
        </div>
      ))}

      {sheet && (
        <PriceSheet
          properties={properties}
          unitId={sheet.unitId}
          from={sheet.from}
          to={sheet.to}
          onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); setRatesVersion((v) => v + 1); }}
        />
      )}
    </section>
  );
}

function HorizonPanel({ canEdit }: { canEdit: boolean }) {
  const [saved, setSaved] = useState<number | null>(null);
  const [days, setDays] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { api.bookingSettings().then((s) => { setSaved(s.horizon_days); setDays(String(s.horizon_days)); }).catch(() => {}); }, []);
  if (saved == null) return null;
  const n = Number(days);
  const save = async (value = n) => {
    setMsg(null);
    try {
      const s = await api.saveBookingSettings(value);
      setSaved(s.horizon_days);
      setDays(String(s.horizon_days));
      setMsg({ ok: true, text: `Zapisano — strona pokazuje ceny i przyjmuje zapytania do ${formatShort(addDays(today(), s.horizon_days))}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="panel">
      <h2>Na ile dni do przodu pokazywać ceny</h2>
      <p className="muted notif-desc">
        Goście widzą ceny i mogą wysłać zapytanie na najbliższe <b>{saved} dni</b> (do {formatShort(addDays(today(), saved))}). Późniejsze dni są na stronie niedostępne.
      </p>
      {canEdit ? (
        <>
          <div className="chips horizon-chips">
            {HORIZON_PRESETS.map((d) => (
              <button key={d} type="button" className={`chip ${saved === d ? 'active' : ''}`} onClick={() => save(d)}>
                {d === 365 ? '1 rok' : d === 540 ? '1,5 roku' : `${d} dni`}
              </button>
            ))}
          </div>
          <div className="row">
            <label className="narrow-time">Liczba dni (7–730)<input type="number" min={7} max={730} value={days} onChange={(e) => setDays(e.target.value)} /></label>
            {n !== saved && <button className="btn primary small" disabled={!Number.isInteger(n) || n < 7 || n > 730} onClick={() => save()}>Zapisz</button>}
          </div>
        </>
      ) : <p className="muted small-note">Zmienić to może administrator z dostępem do wszystkich obiektów.</p>}
      {msg && <div className={`banner ${msg.ok ? 'info' : 'error'}`} style={{ marginTop: 10 }}>{msg.text}</div>}
    </div>
  );
}

type Range = { from: string; to: string; price: number | null; min_nights: number | null; closed: number };

/** Kolejne dni z takimi samymi ustawieniami łączymy w jeden zakres (np. 20–26 lip · 700 zł). */
function groupRanges(rates: Rate[]): Range[] {
  const out: Range[] = [];
  for (const r of [...rates].sort((a, b) => a.date.localeCompare(b.date))) {
    const last = out.at(-1);
    if (last && addDays(last.to, 1) === r.date && last.price === r.price && last.min_nights === r.min_nights && last.closed === r.closed) last.to = r.date;
    else out.push({ from: r.date, to: r.date, price: r.price, min_nights: r.min_nights, closed: r.closed });
  }
  return out;
}

function UnitPricingCard({ unit: u, rates, onSaved, onAddDays, onEditRange, onRatesChanged }: {
  unit: Unit; rates: Rate[]; onSaved: () => void; onAddDays: () => void; onEditRange: (from: string, to: string) => void; onRatesChanged: () => void;
}) {
  const initialWeek = useMemo(() => weekdayPrices(u).map((v) => (v == null ? '' : String(v))), [u]);
  const [base, setBase] = useState(u.base_price == null ? '' : String(u.base_price));
  const [week, setWeek] = useState<string[]>(initialWeek);
  const [minNights, setMinNights] = useState(u.min_nights || 1);
  const [bookable, setBookable] = useState(!!u.bookable);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const ranges = groupRanges(rates);

  const dirty = base !== (u.base_price == null ? '' : String(u.base_price)) || week.some((v, i) => v !== initialWeek[i])
    || minNights !== (u.min_nights || 1) || bookable !== !!u.bookable;

  const setDay = (dow: number, value: string) => setWeek(week.map((v, i) => (i === dow ? value : v)));
  const weekendShortcut = () => {
    const price = prompt('Cena za noc w weekend (noce z piątku i soboty), zł:', week[5] || week[6] || '');
    if (price != null) setWeek(week.map((v, i) => (i === 5 || i === 6 ? price.trim() : v)));
  };

  const save = async () => {
    const basePrice = toNumber(base);
    const weekPrices = week.map(toNumber);
    if (badNumber(basePrice) || weekPrices.some(badNumber)) return setMsg({ ok: false, text: 'Podaj poprawne ceny (same liczby)' });
    setBusy(true);
    setMsg(null);
    try {
      await api.saveUnitPricing(u.id, { base_price: basePrice, min_nights: minNights, bookable, weekday_prices: weekPrices });
      setMsg({ ok: true, text: 'Zapisano cennik.' });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const removeRange = async (r: Range) => {
    if (!confirm(`Usunąć ustawienia na ${formatShort(r.from)}${r.from !== r.to ? ` – ${formatShort(r.to)}` : ''}? Wróci cena dnia tygodnia / podstawowa.`)) return;
    try {
      await api.saveRates({ unit_ids: [u.id], from: r.from, to: r.to, price: null, min_nights: null, closed: false });
      onRatesChanged();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  const visible = showAll ? ranges : ranges.slice(0, 6);
  return (
    <div className="panel pricing-card">
      <div className="pricing-card-head">
        <i className="unit-dot big" style={{ background: u.color }} />
        <h3 className="pricing-unit-name">{u.name}</h3>
        <span className="muted">do {u.capacity} os.</span>
        {!u.bookable && <span className="badge">ukryty na stronie</span>}
      </div>

      <div className="row">
        <label>Cena podstawowa za noc (zł)<input inputMode="decimal" placeholder="np. 300" value={base} onChange={(e) => setBase(e.target.value)} /></label>
        <label className="narrow">Min. nocy<input type="number" min={1} max={60} value={minNights} onChange={(e) => setMinNights(Math.max(1, Number(e.target.value) || 1))} /></label>
      </div>

      <div className="weekday-head">
        <span>Cena wg dnia tygodnia <small className="muted">— puste = cena podstawowa</small></span>
        <button type="button" className="link" onClick={weekendShortcut}>Ustaw weekend</button>
      </div>
      <div className="weekday-grid">
        {WEEKDAYS.map(([dow, label]) => (
          <label key={dow} className={dow === 5 || dow === 6 ? 'is-weekend' : ''}>
            {label}
            <input inputMode="decimal" placeholder={base || '—'} value={week[dow]} onChange={(e) => setDay(dow, e.target.value)} aria-label={`Cena — ${label}`} />
          </label>
        ))}
      </div>

      <label className="switch-row">
        <input type="checkbox" checked={bookable} onChange={(e) => setBookable(e.target.checked)} />
        <span><b>Widoczny na stronie</b><small>Goście widzą ceny i wolne terminy i mogą wysłać zapytanie przyciskiem „Zarezerwuj”</small></span>
      </label>
      {dirty && <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Zapisywanie…' : 'Zapisz cennik'}</button>}
      {msg && <div className={`banner ${msg.ok ? 'info' : 'error'}`} style={{ marginTop: 10 }}>{msg.text}</div>}

      <div className="special-head">
        <h4>Ceny na wybrane dni</h4>
        <button type="button" className="btn small" onClick={onAddDays}>＋ Ustaw cenę na dni</button>
      </div>
      {ranges.length === 0 ? (
        <p className="muted small-note">Brak — np. święta, długi weekend, sezon. Możesz je też ustawić w Kalendarzu przyciskiem „Ceny”.</p>
      ) : (
        <ul className="special-list">
          {visible.map((r) => (
            <li key={r.from}>
              <button type="button" className="special-range" onClick={() => onEditRange(r.from, r.to)}>
                <b>{formatShort(r.from)}{r.from !== r.to && ` – ${formatShort(r.to)}`}</b>
                <span className="muted">{r.from !== r.to ? nightsLabel(Math.round((new Date(r.to).getTime() - new Date(r.from).getTime()) / 86_400_000) + 1) : '1 noc'}</span>
                <span className="special-tags">
                  {r.price != null && <span className="tag-price">{r.price.toLocaleString('pl-PL')} zł</span>}
                  {r.min_nights != null && <span className="badge">min. {nightsLabel(r.min_nights)}</span>}
                  {!!r.closed && <span className="badge bad">online zamknięte</span>}
                </span>
              </button>
              <button type="button" className="link danger-link" onClick={() => removeRange(r)} aria-label="Usuń">Usuń</button>
            </li>
          ))}
          {ranges.length > 6 && <li><button type="button" className="link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Pokaż mniej' : `Pokaż wszystkie (${ranges.length})`}</button></li>}
        </ul>
      )}
    </div>
  );
}
