import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Property, Rate, Unit } from '../types';
import { type BookingSettings } from '../api';
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
          <ClosurePanel property={p} onSaved={reload} />
          <datalist id={`types-${p.id}`}>{[...new Set(p.units.map((u) => u.type_name).filter(Boolean))].map((t) => <option key={t} value={t} />)}</datalist>
          {p.units.map((u) => (
            <UnitPricingCard
              key={u.id}
              unit={u}
              siblings={p.units.filter((x) => x.id !== u.id)}
              typesListId={`types-${p.id}`}
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
  const [settings, setSettings] = useState<BookingSettings | null>(null);
  const [days, setDays] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { api.bookingSettings().then((s) => { setSettings(s); setDays(String(s.horizon_days)); }).catch(() => {}); }, []);
  if (settings == null) return null;
  const saved = settings.horizon_days;
  const n = Number(days);
  const save = async (value = n) => {
    setMsg(null);
    try {
      const s = await api.saveBookingSettings({ horizon_days: value });
      setSettings(s);
      setDays(String(s.horizon_days));
      setMsg({ ok: true, text: `Zapisano — strona pokazuje ceny i przyjmuje zapytania do ${formatShort(addDays(today(), s.horizon_days))}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  const setAssign = async (mode: 'auto' | 'manual') => {
    try { setSettings(await api.saveBookingSettings({ assign_mode: mode })); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
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

      <h3 className="assign-title">Przydział domku przy akceptacji</h3>
      <p className="muted notif-desc">Dotyczy domków tego samego typu (np. 3 × Mały domek) — gość wybiera typ, a Ty decydujesz, do którego domku trafi.</p>
      <div className="segmented">
        <button type="button" disabled={!canEdit} className={`chip ${settings.assign_mode === 'auto' ? 'active' : ''}`} onClick={() => setAssign('auto')}>Automatycznie — pierwszy wolny (można zmienić)</button>
        <button type="button" disabled={!canEdit} className={`chip ${settings.assign_mode === 'manual' ? 'active' : ''}`} onClick={() => setAssign('manual')}>Zawsze wybieram ręcznie</button>
      </div>
    </div>
  );
}

// Zamknięcie obiektu (remont, poza sezonem): do odwołania albo w terminie, z komunikatem dla gości
function ClosurePanel({ property: p, onSaved }: { property: Property; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'range' | 'indefinite'>(p.closed_from || p.closed_to ? 'range' : 'indefinite');
  const [from, setFrom] = useState(p.closed_from ?? today());
  const [to, setTo] = useState(p.closed_to ?? addDays(today(), 30));
  const [note, setNote] = useState(p.closed_note);
  const [noteEn, setNoteEn] = useState(p.closed_note_en);
  const [error, setError] = useState('');
  const isClosed = !!p.closed && (!p.closed_to || p.closed_to >= today());
  const save = async (closed: boolean) => {
    setError('');
    try {
      await api.saveClosure(p.id, { closed, from: closed && mode === 'range' ? from : null, to: closed && mode === 'range' ? to : null, note, note_en: noteEn });
      setOpen(false);
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className={`closure ${isClosed ? 'is-closed' : ''}`}>
      <div className="closure-line">
        <span className={`badge ${isClosed ? 'bad' : 'ok'}`}>{isClosed ? 'Obiekt zamknięty' : 'Otwarty'}</span>
        {isClosed && <span className="muted">{p.closed_from || p.closed_to ? `${p.closed_from ? formatShort(p.closed_from) : '…'} – ${p.closed_to ? formatShort(p.closed_to) : 'do odwołania'}` : 'do odwołania'}</span>}
        <button type="button" className="link" onClick={() => setOpen(!open)}>{open ? 'Anuluj' : isClosed ? 'Zmień' : 'Zamknij obiekt'}</button>
      </div>
      {open && (
        <div className="closure-form">
          <div className="segmented">
            <button type="button" className={`chip ${mode === 'range' ? 'active' : ''}`} onClick={() => setMode('range')}>W terminie</button>
            <button type="button" className={`chip ${mode === 'indefinite' ? 'active' : ''}`} onClick={() => setMode('indefinite')}>Do odwołania</button>
          </div>
          {mode === 'range' && (
            <div className="row">
              <label>Od nocy<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
              <label>Do nocy (włącznie)<input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
            </div>
          )}
          <label>Komunikat dla gości (opcjonalnie)<input maxLength={300} placeholder="np. Zapraszamy ponownie od 1 maja" value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <label>Komunikat po angielsku<input maxLength={300} placeholder="e.g. We reopen on 1 May" value={noteEn} onChange={(e) => setNoteEn(e.target.value)} /></label>
          <p className="muted small-note">Zamknięte dni są na stronie niedostępne (do odwołania — zamiast kalendarza wyświetla się komunikat). Istniejące rezerwacje zostają.</p>
          {error && <div className="banner error">{error}</div>}
          <div className="row">
            <button className="btn danger small" onClick={() => save(true)}>{isClosed ? 'Zapisz zamknięcie' : 'Zamknij obiekt'}</button>
            {isClosed && <button className="btn primary small" onClick={() => save(false)}>Otwórz obiekt</button>}
          </div>
        </div>
      )}
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

function UnitPricingCard({ unit: u, siblings, typesListId, rates, onSaved, onAddDays, onEditRange, onRatesChanged }: {
  unit: Unit; siblings: Unit[]; typesListId: string; rates: Rate[]; onSaved: () => void; onAddDays: () => void; onEditRange: (from: string, to: string) => void; onRatesChanged: () => void;
}) {
  const [typeName, setTypeName] = useState(u.type_name);
  const sameType = typeName.trim() ? siblings.filter((x) => x.type_name.trim().toLowerCase() === typeName.trim().toLowerCase()) : [];
  const [applyToType, setApplyToType] = useState(true);
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
    || minNights !== (u.min_nights || 1) || bookable !== !!u.bookable || typeName !== u.type_name;

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
      const pricing = { base_price: basePrice, min_nights: minNights, bookable, weekday_prices: weekPrices, type_name: typeName.trim() };
      await api.saveUnitPricing(u.id, pricing);
      // te same ceny dla pozostałych domków tego typu (każdy zachowuje swoją widoczność)
      if (applyToType) for (const x of sameType) await api.saveUnitPricing(x.id, { ...pricing, bookable: !!x.bookable });
      setMsg({ ok: true, text: applyToType && sameType.length ? `Zapisano cennik dla ${sameType.length + 1} domków typu „${typeName.trim()}”.` : 'Zapisano cennik.' });
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

      <label className="type-field">Typ na stronie <small className="muted">— takie same domki strona pokazuje jako jeden (np. „Mały domek · 3 domki”)</small>
        <input list={typesListId} maxLength={60} placeholder="np. Mały domek (puste = osobno)" value={typeName} onChange={(e) => setTypeName(e.target.value)} />
      </label>
      {sameType.length > 0 && <p className="muted small-note type-note">Ten sam typ: {sameType.map((x) => x.name).join(', ')}</p>}
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
      {dirty && sameType.length > 0 && (
        <label className="check-row"><input type="checkbox" checked={applyToType} onChange={(e) => setApplyToType(e.target.checked)} /> Te same ceny dla wszystkich domków typu „{typeName.trim()}” ({sameType.length + 1})</label>
      )}
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
