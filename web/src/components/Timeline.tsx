import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Property, Reservation } from '../types';
import { SOURCES } from '../types';
import { getPrefs } from '../prefs';
import { addDays, addMonths, diffDays, formatMonth, formatShort, formatWeekday, fromIso, isWeekend, today } from '../dates';

type Props = {
  properties: Property[];
  version: number;
  onSelect: (r: Reservation) => void;
  onCreate?: (unitId: number, date: string) => void; // brak = tylko podgląd
};

export function reservationLabel(r: Reservation) {
  if (r.guest_name) return r.guest_name;
  return SOURCES[r.source] ?? r.source;
}

export default function Timeline({ properties, version, onSelect, onCreate }: Props) {
  const [{ months: rangeMonths, daySize }] = useState(getPrefs);
  const [start, setStart] = useState(() => addDays(today(), -2));
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const end = addMonths(start, rangeMonths);
  const DAYS = diffDays(start, end);
  const step = rangeMonths === 1 ? 7 : rangeMonths <= 3 ? 14 : 30; // o ile dni przesuwają strzałki
  const now = today();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.reservations(start, end)
      .then((r) => { if (alive) { setReservations(r); setError(''); } })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [start, end, version]);

  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(start, i)), [start, DAYS]);
  const months = useMemo(() => {
    const out: { label: string; span: number }[] = [];
    for (const d of days) {
      const label = formatMonth(d);
      if (out.at(-1)?.label === label) out.at(-1)!.span++;
      else out.push({ label, span: 1 });
    }
    return out;
  }, [days]);

  const byUnit = useMemo(() => {
    const map = new Map<number, Reservation[]>();
    for (const r of reservations) map.set(r.unit_id, [...(map.get(r.unit_id) ?? []), r]);
    return map;
  }, [reservations]);

  // Rezerwacje nakładające się w tym samym obiekcie (np. Booking + wpis ręczny) oznaczamy na czerwono.
  const overlapping = useMemo(() => {
    const ids = new Set<number>();
    for (const list of byUnit.values()) {
      for (const a of list) for (const b of list) {
        if (a.id < b.id && a.check_in < b.check_out && b.check_in < a.check_out) { ids.add(a.id); ids.add(b.id); }
      }
    }
    return ids;
  }, [byUnit]);

  const occupiedToday = reservations.filter((r) => r.check_in <= now && r.check_out > now).length;
  const totalUnits = properties.reduce((n, p) => n + p.units.length, 0);

  return (
    <section className="timeline-wrap">
      <div className="toolbar">
        <div className="toolbar-nav">
          <button className="btn" onClick={() => setStart(addDays(start, -step))} aria-label="Wcześniej">‹</button>
          <button className="btn" onClick={() => setStart(addDays(now, -2))}>Dziś</button>
          <button className="btn" onClick={() => setStart(addDays(start, step))} aria-label="Później">›</button>
          <input
            type="date"
            className="date-jump"
            value={start}
            onChange={(e) => e.target.value && setStart(e.target.value)}
            aria-label="Przejdź do daty"
          />
        </div>
        <div className="toolbar-stats">
          {loading ? <span className="muted">Wczytywanie…</span> : (
            <span>Dziś zajęte: <strong>{occupiedToday}</strong> / {totalUnits}</span>
          )}
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}

      <div className={`timeline size-${daySize}`} style={{ ['--days' as string]: DAYS }}>
        <div className="tl-grid">
          <div className="tl-corner" />
          <div className="tl-months">
            {months.map((m, i) => <div key={i} style={{ gridColumn: `span ${m.span}` }}><span>{m.label}</span></div>)}
          </div>
          <div className="tl-corner tl-corner-2" />
          <div className="tl-days">
            {days.map((d) => (
              <div key={d} className={`tl-day ${isWeekend(d) ? 'weekend' : ''} ${d === now ? 'today' : ''}`}>
                <small>{formatWeekday(d)}</small>
                <b>{fromIso(d).getDate()}</b>
              </div>
            ))}
          </div>

          {properties.map((p) => (
            <Fragment key={p.id}>
              <div className="tl-property"><span>{p.name}</span></div>
              <div className="tl-property-fill" />
              {p.units.map((u) => (
                <Fragment key={u.id}>
                  <div className="tl-unit" title={`${u.name} · do ${u.capacity} os.`}>
                    <i style={{ background: u.color }} />
                    <span>{u.name}</span>
                  </div>
                  <div className="tl-row">
                    {days.map((d) => {
                      const cls = `tl-cell ${isWeekend(d) ? 'weekend' : ''} ${d === now ? 'today' : ''}`;
                      return onCreate
                        ? <button key={d} className={cls} onClick={() => onCreate(u.id, d)} aria-label={`Nowa rezerwacja: ${u.name}, ${formatShort(d)}`} />
                        : <div key={d} className={`${cls} readonly`} />;
                    })}
                    {(byUnit.get(u.id) ?? []).map((r) => {
                      const from = diffDays(start, r.check_in);
                      const to = diffDays(start, r.check_out);
                      // Pasek zaczyna się w połowie dnia przyjazdu i kończy w połowie dnia wyjazdu.
                      const left = Math.max(from + 0.5, 0);
                      const right = Math.min(to + 0.5, DAYS);
                      if (right <= 0 || left >= DAYS) return null;
                      const classes = ['tl-bar', `src-${r.source}`, `st-${r.status}`, overlapping.has(r.id) ? 'conflict' : '',
                        from + 0.5 < 0 ? 'cut-left' : '', to + 0.5 > DAYS ? 'cut-right' : ''].join(' ');
                      return (
                        <button
                          key={r.id}
                          className={classes}
                          style={{ left: `calc(${left} * var(--day-w) + 1px)`, width: `calc(${right - left} * var(--day-w) - 2px)` }}
                          onClick={() => onSelect(r)}
                          title={`${reservationLabel(r)} · ${formatShort(r.check_in)} – ${formatShort(r.check_out)}`}
                        >
                          <span>{reservationLabel(r)}</span>
                        </button>
                      );
                    })}
                  </div>
                </Fragment>
              ))}
            </Fragment>
          ))}
        </div>
      </div>

      <div className="legend">
        <span><i className="src-direct" /> Bezpośrednio</span>
        <span><i className="src-booking" /> Booking.com</span>
        <span><i className="src-airbnb" /> Airbnb</span>
        <span><i className="st-tentative" /> Wstępna</span>
        <span><i className="conflict" /> Konflikt</span>
      </div>
    </section>
  );
}
