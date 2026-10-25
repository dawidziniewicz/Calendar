import { useEffect, useMemo, useState } from 'react';
import Stepper from './Stepper';
import { api } from '../api';
import type { Property, Rate, Unit } from '../types';
import { type BookingSettings } from '../api';
import { addDays, dmy, formatShort, nightsLabel, today } from '../dates';
import { WEEKDAYS, groupUnits, weekdayPrices } from '../pricing';
import PriceSheet from './PriceSheet';
import ExtrasPanel from './ExtrasPanel';
import DateInput from './DateInput';

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

      <HorizonPanel canEdit={canEditHorizon} properties={properties} reload={reload} />
      <ExtrasPanel properties={properties} canEdit={canEditHorizon} />

      {properties.map((p) => (
        <div key={p.id} className="pricing-property">
          <h2 className="pricing-property-name">{p.name}</h2>
          <ClosurePanel property={p} onSaved={reload} />
          {p.units.length > 1 && <TypesPanel property={p} onSaved={() => { reload(); setRatesVersion((v) => v + 1); }} />}
          {groupUnits(p.units).map((g) => (
            <UnitPricingCard
              key={`${g.key}:${g.units.map((u) => u.id).join(',')}:${g.units[0].base_price}:${g.units[0].weekday_prices}:${g.units[0].min_nights}:${g.units[0].bookable}`}
              units={g.units}
              typeName={g.type}
              rates={rates.filter((r) => g.units.some((u) => u.id === r.unit_id))}
              onSaved={reload}
              onAddDays={() => setSheet({ unitId: g.units[0].id, from: today(), to: addDays(today(), 6) })}
              onEditRange={(from, to) => setSheet({ unitId: g.units[0].id, from, to })}
              onRatesChanged={() => setRatesVersion((v) => v + 1)}
              onUnified={() => { reload(); setRatesVersion((v) => v + 1); }}
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

const withYear = (iso: string) => dmy(iso);

function HorizonPanel({ canEdit, properties, reload }: { canEdit: boolean; properties: Property[]; reload: () => void }) {
  const [settings, setSettings] = useState<BookingSettings | null>(null);
  const [mode, setMode] = useState<'date' | 'days'>('date');
  const [until, setUntil] = useState('');
  const [days, setDays] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const apply = (s: BookingSettings) => {
    setSettings(s);
    setMode(s.horizon_until ? 'date' : 'days');
    setUntil(s.horizon_until ?? s.horizon_last);
    setDays(String(s.horizon_days));
  };
  useEffect(() => { api.bookingSettings().then(apply).catch(() => {}); }, []);
  if (settings == null) return null;
  const n = Number(days);
  const save = async (patch: { horizon_until?: string | null; horizon_days?: number }) => {
    setMsg(null);
    try {
      const s = await api.saveBookingSettings(patch);
      apply(s);
      setMsg({ ok: true, text: `Zapisano — strona pokazuje ceny i przyjmuje zapytania do ${withYear(s.horizon_last)} (ostatnia noc).` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  const setAssign = async (m: 'auto' | 'manual') => {
    try { setSettings(await api.saveBookingSettings({ assign_mode: m })); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };
  // szybkie daty: koniec wakacji, koniec roku, koniec przyszłego roku
  const y = Number(today().slice(0, 4));
  const quick: [string, string][] = [
    ...(() => { const v = today() <= `${y}-09-30` ? y : y + 1; return [[`${v}-09-30`, `Koniec wakacji ${v}`] as [string, string]]; })(),
    [`${y}-12-31`, `Koniec ${y}`],
    [`${y + 1}-12-31`, `Koniec ${y + 1}`],
  ];
  return (
    <div className="panel">
      <h2>Do kiedy pokazywać ceny na stronie</h2>
      <p className="muted notif-desc">
        Goście widzą ceny i mogą wysłać zapytanie do <b>{withYear(settings.horizon_last)}</b> (ostatnia noc)
        {settings.horizon_until ? '.' : ` — zawsze ${settings.horizon_days} dni do przodu, data przesuwa się każdego dnia.`} Późniejsze dni są na stronie niedostępne.
      </p>
      {canEdit ? (
        <>
          <div className="segmented">
            <button type="button" className={`chip ${mode === 'date' ? 'active' : ''}`} onClick={() => setMode('date')}>Do konkretnej daty</button>
            <button type="button" className={`chip ${mode === 'days' ? 'active' : ''}`} onClick={() => setMode('days')}>Stała liczba dni do przodu</button>
          </div>
          {mode === 'date' ? (
            <>
              <div className="row">
                <label>Ostatnia noc z ceną na stronie<DateInput min={today()} value={until} onChange={(v) => setUntil(v)} /></label>
                {until && (until !== settings.horizon_until) && <button className="btn primary small" disabled={until < today()} onClick={() => save({ horizon_until: until })}>Zapisz</button>}
              </div>
              <div className="chips horizon-chips">
                {quick.map(([d, label]) => (
                  <button key={d} type="button" className={`chip ${settings.horizon_until === d ? 'active' : ''}`} onClick={() => save({ horizon_until: d })}>{label} · {formatShort(d)}</button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="chips horizon-chips">
                {HORIZON_PRESETS.map((d) => (
                  <button key={d} type="button" className={`chip ${!settings.horizon_until && settings.horizon_days === d ? 'active' : ''}`} onClick={() => save({ horizon_days: d })}>
                    {d === 365 ? '1 rok' : d === 540 ? '1,5 roku' : `${d} dni`}
                  </button>
                ))}
              </div>
              <div className="row">
                <label className="narrow-time">Liczba dni (7–730)<input type="number" min={7} max={730} value={days} onChange={(e) => setDays(e.target.value)} /></label>
                {(n !== settings.horizon_days || settings.horizon_until) && <button className="btn primary small" disabled={!Number.isInteger(n) || n < 7 || n > 730} onClick={() => save({ horizon_days: n })}>Zapisz</button>}
              </div>
            </>
          )}
        </>
      ) : <p className="muted small-note">Zmienić to może administrator z dostępem do wszystkich obiektów.</p>}
      {msg && <div className={`banner ${msg.ok ? 'info' : 'error'}`} style={{ marginTop: 10 }}>{msg.text}</div>}

      <h3 className="assign-title">Inna data dla obiektu lub typu domku</h3>
      <p className="muted notif-desc">
        Np. Sopot do końca roku, a Jantar tylko do końca wakacji. Puste pole = jak wyżej ({withYear(settings.horizon_last)}).
        Data typu domku ma pierwszeństwo przed datą obiektu.
      </p>
      <HorizonOverrides properties={properties} fallback={settings.horizon_last} onSaved={reload} />

      <h3 className="assign-title">Przydział domku przy akceptacji</h3>
      <p className="muted notif-desc">Dotyczy domków tego samego typu (np. 3 × Mały domek) — gość wybiera typ, a Ty decydujesz, do którego domku trafi.</p>
      <div className="segmented">
        <button type="button" disabled={!canEdit} className={`chip ${settings.assign_mode === 'auto' ? 'active' : ''}`} onClick={() => setAssign('auto')}>Automatycznie — pierwszy wolny (można zmienić)</button>
        <button type="button" disabled={!canEdit} className={`chip ${settings.assign_mode === 'manual' ? 'active' : ''}`} onClick={() => setAssign('manual')}>Zawsze wybieram ręcznie</button>
      </div>
    </div>
  );
}

// „Ceny na stronie do” osobno dla obiektu i typu domku (cały typ naraz, jak cennik)
function HorizonOverrides({ properties, fallback, onSaved }: { properties: Property[]; fallback: string; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const save = async (key: string, body: { property_id?: number; unit_ids?: number[]; until: string | null }) => {
    setBusy(key);
    setError('');
    try { await api.setHorizon(body); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  return (
    <div className="horizon-overrides">
      {properties.map((p) => {
        const groups = groupUnits(p.units);
        const propLast = p.horizon_until ?? fallback;
        return (
          <div key={p.id} className="horizon-property">
            <div className="horizon-row">
              <span><b>{p.name}</b>{!p.horizon_until && <small className="muted"> · jak ogólnie</small>}</span>
              <div className="horizon-field">
                <DateInput value={p.horizon_until ?? ''} min={today()} placeholder={dmy(fallback)} aria-label={`${p.name}: ceny do`}
                  onChange={(v) => v && save(`p${p.id}`, { property_id: p.id, until: v })} />
                {p.horizon_until && <button type="button" className="link" disabled={busy === `p${p.id}`} onClick={() => save(`p${p.id}`, { property_id: p.id, until: null })}>Jak ogólnie</button>}
              </div>
            </div>
            {groups.length > 1 && groups.map((g) => {
              const own = g.units[0].horizon_until;
              const key = `t${g.units[0].id}`;
              return (
                <div key={g.key} className="horizon-row is-type">
                  <span>{g.type ?? g.units[0].name}{g.units.length > 1 && <small className="muted"> ({g.units.length} domki)</small>}{!own && <small className="muted"> · jak obiekt</small>}</span>
                  <div className="horizon-field">
                    <DateInput value={own ?? ''} min={today()} placeholder={dmy(propLast)} aria-label={`${g.type ?? g.units[0].name}: ceny do`}
                      onChange={(v) => v && save(key, { unit_ids: g.units.map((u) => u.id), until: v })} />
                    {own && <button type="button" className="link" disabled={busy === key} onClick={() => save(key, { unit_ids: g.units.map((u) => u.id), until: null })}>Jak obiekt</button>}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      {error && <div className="banner error">{error}</div>}
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
              <label>Od nocy<DateInput value={from} onChange={(v) => v && setFrom(v)} /></label>
              <label>Do nocy (włącznie)<DateInput value={to} min={from} onChange={(v) => v && setTo(v)} /></label>
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

// Typy domków: przynależność wybierana z listy (bez literówek), nazwa typu PL/EN zmieniana dla wszystkich domków naraz
function TypesPanel({ property: p, onSaved }: { property: Property; onSaved: () => void }) {
  const groups = groupUnits(p.units).filter((g) => g.type);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const assign = async (u: Unit, value: string) => {
    let name = value;
    if (value === '__new') {
      const typed = prompt('Nazwa nowego typu (np. Mały domek):')?.trim();
      if (!typed) return;
      name = groups.find((g) => g.type!.toLowerCase() === typed.toLowerCase())?.type ?? typed;
    }
    const target = groups.find((g) => g.type === name);
    if (target && !confirm(`${u.name} dołączy do typu „${name}” i przejmie jego ceny (cena podstawowa, dni tygodnia, ceny na wybrane dni). Kontynuować?`)) return;
    setBusy(true);
    setError('');
    try {
      await api.setUnitType(u.id, name);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel types-panel">
      <h3>Typy domków</h3>
      <p className="muted small-note">Takie same domki połącz w typ — strona pokaże je razem (np. „Mały domek · 3 domki”) i sama wybierze wolny, a ceny ustawiasz raz dla całego typu.</p>
      <ul className="type-assign">
        {p.units.map((u) => (
          <li key={u.id}>
            <span className="type-unit"><i className="unit-dot" style={{ background: u.color }} /> {u.name}</span>
            <select value={u.type_name.trim() ? groups.find((g) => g.type!.toLowerCase() === u.type_name.trim().toLowerCase())?.type ?? '' : ''} disabled={busy}
              onChange={(e) => assign(u, e.target.value)} aria-label={`Typ — ${u.name}`}>
              <option value="">osobno (bez typu)</option>
              {groups.map((g) => <option key={g.key} value={g.type!}>{g.type}</option>)}
              <option value="__new">＋ Nowy typ…</option>
            </select>
          </li>
        ))}
      </ul>
      {groups.map((g) => <TypeNames key={g.key} type={g.type!} units={g.units} onSaved={onSaved} />)}
      {error && <div className="banner error">{error}</div>}
    </div>
  );
}

function TypeNames({ type, units, onSaved }: { type: string; units: Unit[]; onSaved: () => void }) {
  const [name, setName] = useState(type);
  const [en, setEn] = useState(units[0].type_name_en);
  const [error, setError] = useState('');
  const dirty = name.trim() !== type || en.trim() !== units[0].type_name_en;
  const save = async () => {
    setError('');
    try { await api.renameType(units[0].id, name.trim(), en.trim()); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="type-names">
      <div className="row">
        <label>Nazwa typu ({units.length} {units.length === 1 ? 'domek' : units.length < 5 ? 'domki' : 'domków'})<input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Po angielsku<input maxLength={60} placeholder="np. Small cottage" value={en} onChange={(e) => setEn(e.target.value)} /></label>
        {dirty && <button className="btn primary small" disabled={!name.trim()} onClick={save}>Zapisz</button>}
      </div>
      {error && <div className="banner error">{error}</div>}
    </div>
  );
}

const sameRates = (a: Rate[], b: Rate[]) => {
  const key = (l: Rate[]) => l.map((r) => `${r.date}|${r.price}|${r.min_nights}|${r.closed}`).sort().join(';');
  return key(a) === key(b);
};

function UnitPricingCard({ units, typeName, rates: allRates, onSaved, onAddDays, onEditRange, onRatesChanged, onUnified }: {
  units: Unit[]; typeName: string | null; rates: Rate[]; onSaved: () => void; onAddDays: () => void; onEditRange: (from: string, to: string) => void; onRatesChanged: () => void; onUnified: () => void;
}) {
  const u = units[0];
  const rates = allRates.filter((r) => r.unit_id === u.id);
  // domki typu z różnymi cenami (np. ustawione osobno przed połączeniem w typ) → propozycja ujednolicenia
  const differs = units.slice(1).some((x) => x.base_price !== u.base_price || x.min_nights !== u.min_nights || (x.weekday_prices ?? '') !== (u.weekday_prices ?? '')
    || !sameRates(rates, allRates.filter((r) => r.unit_id === x.id).map((r) => ({ ...r, unit_id: u.id }))));
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
      // serwer zapisuje cennik dla wszystkich domków typu
      await api.saveUnitPricing(u.id, { base_price: basePrice, min_nights: minNights, bookable, weekday_prices: weekPrices });
      setMsg({ ok: true, text: units.length > 1 ? `Zapisano cennik dla ${units.length} domków typu „${typeName}”.` : 'Zapisano cennik.' });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const unify = async () => {
    if (!confirm(`Ustawić wszystkim domkom typu „${typeName}” ceny takie jak ${u.name}?`)) return;
    try {
      for (const x of units.slice(1)) await api.setUnitType(x.id, typeName!);
      onUnified();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
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
        <h3 className="pricing-unit-name">{typeName ?? u.name}</h3>
        <span className="muted">do {Math.min(...units.map((x) => x.capacity))} os.</span>
        {!u.bookable && <span className="badge">ukryty na stronie</span>}
      </div>
      {units.length > 1 && <p className="muted small-note type-note">Wspólny cennik dla {units.length} domków: {units.map((x) => x.name).join(', ')}</p>}
      {differs && (
        <div className="banner error">
          Domki tego typu mają teraz różne ceny. <button type="button" className="link strong" onClick={unify}>Ujednolić wg {u.name}</button>
        </div>
      )}
      <div className="row">
        <label>Cena podstawowa za noc (zł)<input inputMode="decimal" placeholder="np. 300" value={base} onChange={(e) => setBase(e.target.value)} /></label>
        <div className="field stepper-field">Min. nocy<Stepper label="Minimalna liczba nocy" min={1} max={60} value={minNights} onChange={setMinNights} /></div>
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
        <span><b>{units.length > 1 ? 'Widoczne na stronie' : 'Widoczny na stronie'}</b><small>Goście widzą ceny i wolne terminy i mogą wysłać zapytanie przyciskiem „Zarezerwuj”</small></span>
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
