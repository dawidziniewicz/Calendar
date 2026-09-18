import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Property, Reservation, Unit } from '../types';
import { SOURCES } from '../types';
import { addDays, diffDays, formatLong, formatMonth, formatShort, nightsLabel, today } from '../dates';

type Props = { properties: Property[]; version: number; cancellations: Reservation[]; onSelect: (r: Reservation) => void };

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function Agenda({ properties, version, cancellations, onSelect }: Props) {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [stayingOpen, setStayingOpen] = useState(false);
  const now = today();

  useEffect(() => {
    // Wszystko od dziś do ostatniego przyszłego gościa
    api.reservations(addDays(now, -1), '9999-12-31').then(setReservations).catch((e) => setError(e.message));
  }, [version, now]);

  const units = useMemo(() => {
    const map = new Map<number, { unit: Unit; property: Property }>();
    for (const p of properties) for (const u of p.units) map.set(u.id, { unit: u, property: p });
    return map;
  }, [properties]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? reservations.filter((r) => [r.guest_name, r.guest_phone, r.guest_email, r.notes, units.get(r.unit_id)?.unit.name]
        .some((v) => v?.toLowerCase().includes(q)))
    : reservations;

  const staying = filtered.filter((r) => r.check_in < now && r.check_out > now);
  // Dziś i jutro zawsze; dalej tylko dni, w których ktoś przyjeżdża lub wyjeżdża — aż do ostatniego gościa.
  const eventDates = new Set<string>([now, addDays(now, 1)]);
  for (const r of filtered) {
    if (r.check_in >= now) eventDates.add(r.check_in);
    if (r.check_out >= now) eventDates.add(r.check_out);
  }
  const days = [...eventDates].sort().map((d) => ({
    date: d,
    arrivals: filtered.filter((r) => r.check_in === d),
    departures: filtered.filter((r) => r.check_out === d),
  }));

  const card = (r: Reservation, kind: 'in' | 'out' | 'stay' | 'cancel') => {
    const info = units.get(r.unit_id);
    const nights = diffDays(r.check_in, r.check_out);
    const guests = r.adults + r.children;
    const due = r.price != null ? r.price - (r.paid ?? 0) : null;
    return (
      <article key={`${kind}-${r.id}`} className={`guest-card kind-${kind} ${r.status === 'tentative' ? 'tentative' : ''}`}>
        <button className="guest-main" onClick={() => onSelect(r)}>
          <span className="unit-dot" style={{ background: info?.unit.color }} />
          <div>
            <div className="guest-name">{r.guest_name || <em>{SOURCES[r.source] ?? r.source} – uzupełnij dane gościa</em>}</div>
            <div className="guest-meta">
              <strong className="guest-unit">{info?.unit.name}</strong> · {info?.property.name}
            </div>
            <div className="guest-meta">
              {formatShort(r.check_in)} – {formatShort(r.check_out)} · {nightsLabel(nights)}
              {guests > 0 && ` · ${r.adults} dor.${r.children ? ` + ${r.children} dz.` : ''}`}
              {r.source !== 'direct' && ` · ${SOURCES[r.source] ?? r.source}`}
            </div>
            {due != null && due > 0 && <div className="guest-due">Do zapłaty: {due.toLocaleString('pl-PL')} zł</div>}
            {r.notes && <div className="guest-notes">{r.notes}</div>}
          </div>
        </button>
        {r.guest_phone && (
          <a className="call" href={`tel:${r.guest_phone.replace(/\s/g, '')}`} aria-label={`Zadzwoń do ${r.guest_name}`}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
          </a>
        )}
      </article>
    );
  };

  return (
    <section className="agenda">
      <input className="search" type="search" placeholder="Szukaj gościa, telefonu, domku…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {error && <div className="banner error">{error}</div>}

      {cancellations.length > 0 && (
        <div className="agenda-day cancellations">
          <h2>Odwołane na Bookingu <span className="count danger">{cancellations.length}</span></h2>
          <p className="muted small">Stuknij, aby zamienić na rezerwację prywatną albo oznaczyć jako przejrzaną.</p>
          {cancellations.map((r) => card(r, 'cancel'))}
        </div>
      )}

      {staying.length > 0 && (
        <div className="agenda-day">
          <button type="button" className="collapse-head" aria-expanded={stayingOpen || Boolean(q)} onClick={() => setStayingOpen(!stayingOpen)}>
            <h2>Obecnie przebywają <span className="count">{staying.length}</span></h2>
            <span className="chev">{stayingOpen || q ? '▴' : '▾'}</span>
          </button>
          {/* przy wyszukiwaniu pokazujemy wyniki także z tej listy */}
          {(stayingOpen || q) && staying.map((r) => card(r, 'stay'))}
        </div>
      )}

      {days.map(({ date, arrivals, departures }, i) => (
        <Fragment key={date}>
          {/* nagłówek miesiąca przy dalszych dniach, gdy zmienia się miesiąc */}
          {i >= 2 && date.slice(0, 7) !== days[i - 1].date.slice(0, 7) && (
            <div className="agenda-month">{capitalize(formatMonth(date))}</div>
          )}
        <div className={`agenda-day ${date === now ? 'is-today' : ''}`}>
          <h2>
            {date === now ? 'Dziś ' : date === addDays(now, 1) ? 'Jutro ' : ''}
            <span className="muted">{date === now || date === addDays(now, 1) ? formatLong(date) : capitalize(formatLong(date))}</span>
          </h2>
          {!arrivals.length && !departures.length && <p className="empty">Brak przyjazdów i wyjazdów</p>}
          {arrivals.length > 0 && <h3>Przyjazdy</h3>}
          {arrivals.map((r) => card(r, 'in'))}
          {departures.length > 0 && <h3>Wyjazdy</h3>}
          {departures.map((r) => card(r, 'out'))}
        </div>
        </Fragment>
      ))}
    </section>
  );
}
