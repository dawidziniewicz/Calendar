import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { Property, Reservation } from '../types';
import { SOURCES, STATUS_LABELS } from '../types';
import { diffDays, formatLong, formatShort, nightsLabel } from '../dates';

type Props = {
  reservation: Reservation;
  properties: Property[];
  onClose: () => void;
  onEdit: () => void;
  onChanged: (updated: Reservation) => void;
};
type Conflict = { id: number; check_in: string; check_out: string; guest_name: string; source: string };

const money = (v: number) => `${v.toLocaleString('pl-PL', { maximumFractionDigits: 2 })} zł`;
const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

export default function ReservationView({ reservation: r, properties, onClose, onEdit, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const cancelledImport = r.status === 'cancelled' && Boolean(r.external_uid);

  const convert = async (force = false) => {
    setBusy(true);
    setError('');
    try {
      onChanged(await api.convertToDirect(r.id, force));
      setConflicts([]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflicts(err.data.conflicts as Conflict[]);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    setBusy(true);
    try {
      onChanged(await api.reviewCancellation(r.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const property = properties.find((p) => p.units.some((u) => u.id === r.unit_id));
  const unit = property?.units.find((u) => u.id === r.unit_id);
  const nights = diffDays(r.check_in, r.check_out);
  const due = r.price != null ? r.price - (r.paid ?? 0) : null;
  const missingGuest = !r.guest_name && !r.guest_phone;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Rezerwacja">
        <header className="sheet-head">
          <button type="button" className="link" onClick={onClose}>Zamknij</button>
          <h2>Rezerwacja</h2>
          <button type="button" className="link strong" onClick={onEdit}>Edytuj</button>
        </header>

        <div className="sheet-body view">
          <div className="view-hero">
            <span className="unit-dot big" style={{ background: unit?.color }} />
            <div>
              <h3 className="view-name">{r.guest_name || <em>{SOURCES[r.source] ?? r.source}</em>}</h3>
              <div className="muted">{unit?.name} · {property?.name}</div>
              <div className="view-tags">
                <span className={`tag src-tag-${r.source}`}>{SOURCES[r.source] ?? r.source}</span>
                {r.status !== 'confirmed' && <span className={`tag st-tag-${r.status}`}>{STATUS_LABELS[r.status]}</span>}
              </div>
            </div>
          </div>

          {cancelledImport && (
            <div className="banner error cancel-box">
              <strong>Odwołana na {SOURCES[r.source] ?? r.source}</strong>
              <p>
                Rezerwacja zniknęła z kalendarza Bookingu{r.cancelled_at ? ` (${formatShort(r.cancelled_at.slice(0, 10))})` : ''}.
                Jeśli gość przyjeżdża mimo to (np. rezerwuje u Ciebie bezpośrednio), zamień ją — dane gościa zostaną.
              </p>
              {conflicts.length > 0 && (
                <>
                  <p><strong>Termin jest już zajęty przez:</strong></p>
                  <ul>
                    {conflicts.map((c) => (
                      <li key={c.id}>{c.guest_name || SOURCES[c.source] || c.source}: {formatShort(c.check_in)} – {formatShort(c.check_out)}</li>
                    ))}
                  </ul>
                </>
              )}
              <div className="cancel-actions">
                {conflicts.length > 0
                  ? <button type="button" className="btn danger" disabled={busy} onClick={() => convert(true)}>Zamień mimo to</button>
                  : <button type="button" className="btn primary" disabled={busy} onClick={() => convert()}>Zamień na rezerwację bezpośrednią</button>}
                {!r.cancel_reviewed && (
                  <button type="button" className="btn" disabled={busy} onClick={review}>Gość nie przyjeżdża — ukryj</button>
                )}
              </div>
              {error && <p className="warn">{error}</p>}
            </div>
          )}

          {missingGuest && !cancelledImport && (
            <button type="button" className="banner info view-fill" onClick={onEdit}>
              Brak danych gościa — stuknij, aby uzupełnić
            </button>
          )}

          {(r.guest_phone || r.guest_email) && (
            <div className="contact-actions">
              {r.guest_phone && (
                <>
                  <a className="contact call-main" href={telHref(r.guest_phone)}>
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
                    <span><small>Zadzwoń</small>{r.guest_phone}</span>
                  </a>
                  <a className="contact" href={`sms:${r.guest_phone.replace(/[^\d+]/g, '')}`}>
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5h16v11H9l-5 4z" /></svg>
                    <span><small>SMS</small></span>
                  </a>
                </>
              )}
              {r.guest_email && (
                <a className="contact" href={`mailto:${r.guest_email}`}>
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18v12H3zM3 6l9 7 9-7" /></svg>
                  <span><small>E-mail</small>{r.guest_email}</span>
                </a>
              )}
            </div>
          )}

          <dl className="view-list">
            <div><dt>Przyjazd</dt><dd>{formatLong(r.check_in)}</dd></div>
            <div><dt>Wyjazd</dt><dd>{formatLong(r.check_out)}</dd></div>
            <div><dt>Długość pobytu</dt><dd>{nightsLabel(nights)}</dd></div>
            <div>
              <dt>Goście</dt>
              <dd>
                {r.adults + r.children === 0 ? '—' : `${r.adults} ${r.adults === 1 ? 'dorosły' : 'dorosłych'}${r.children ? `, ${r.children} ${r.children === 1 ? 'dziecko' : 'dzieci'}` : ''}`}
                {unit && r.adults + r.children > unit.capacity && <span className="warn"> (maks. {unit.capacity})</span>}
              </dd>
            </div>
            {r.price != null && <div><dt>Cena</dt><dd>{money(r.price)}</dd></div>}
            {r.paid != null && <div><dt>Wpłacono</dt><dd>{money(r.paid)}</dd></div>}
            {due != null && (
              <div><dt>Do zapłaty</dt><dd className={due > 0 ? 'due' : 'paid'}>{due > 0 ? money(due) : 'Opłacone ✓'}</dd></div>
            )}
          </dl>

          {r.notes && (
            <div className="view-notes">
              <h4>Notatki</h4>
              <p>{r.notes}</p>
            </div>
          )}

          <div className="sheet-actions">
            <button type="button" className="btn primary big" onClick={onEdit}>Edytuj rezerwację</button>
          </div>
        </div>
      </div>
    </div>
  );
}
