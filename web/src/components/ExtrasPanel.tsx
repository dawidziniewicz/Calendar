import { useEffect, useState } from 'react';
import Stepper from './Stepper';
import { api, type ExtraInput } from '../api';
import type { Extra, Property } from '../types';

type Props = { properties: Property[]; canEdit: boolean };

const EMPTY: ExtraInput = { name: '', name_en: '', description: '', price: 0, per: 'stay', max_qty: 1, property_ids: null, active: true };
const toInput = (e: Extra): ExtraInput => ({
  name: e.name, name_en: e.name_en, description: e.description, price: e.price, per: e.per, max_qty: e.max_qty,
  property_ids: e.property_ids ? JSON.parse(e.property_ids) : null, active: !!e.active,
});

// Opcje płatne (parking, zwierzę, łóżeczko, późne wymeldowanie…) — gość zaznacza je w zapytaniu na stronie, cena dolicza się do wyceny.
export default function ExtrasPanel({ properties, canEdit }: Props) {
  const [extras, setExtras] = useState<Extra[] | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [error, setError] = useState('');
  const load = () => api.extras().then(setExtras).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const scopeLabel = (e: Extra) => {
    if (!e.property_ids) return 'wszystkie obiekty';
    const ids: number[] = JSON.parse(e.property_ids);
    return ids.map((id) => properties.find((p) => p.id === id)?.name ?? `#${id}`).join(', ');
  };

  return (
    <div className="panel">
      <h2>Opcje płatne</h2>
      <p className="muted notif-desc">
        Np. parking, zwierzę, łóżeczko dla dziecka, późne wymeldowanie. Gość zaznacza je w formularzu na stronie, a cena dolicza się do wyceny zapytania.
      </p>
      {error && <div className="banner error">{error}</div>}
      {extras?.length === 0 && editing !== 'new' && <p className="empty">Brak opcji płatnych.</p>}
      <ul className="extras-list">
        {extras?.map((e) => (
          <li key={e.id} className={e.active ? '' : 'is-off'}>
            {editing === e.id ? (
              <ExtraForm properties={properties} initial={toInput(e)} onCancel={() => setEditing(null)}
                onSave={async (v) => { await api.saveExtra(v, e.id); setEditing(null); load(); }}
                onDelete={async () => { if (confirm(`Usunąć opcję „${e.name}”?`)) { await api.deleteExtra(e.id); setEditing(null); load(); } }} />
            ) : (
              <button type="button" className="extra-row" disabled={!canEdit} onClick={() => setEditing(e.id)}>
                <span className="extra-main">
                  <b>{e.name}</b>
                  <small className="muted">{scopeLabel(e)}{e.max_qty > 1 && ` · do ${e.max_qty} szt.`}{!e.active && ' · wyłączona'}</small>
                </span>
                <span className="extra-price">{e.price.toLocaleString('pl-PL')} zł <small>/ {e.per === 'night' ? 'noc' : 'pobyt'}</small></span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (editing === 'new' ? (
        <ExtraForm properties={properties} initial={EMPTY} onCancel={() => setEditing(null)}
          onSave={async (v) => { await api.saveExtra(v); setEditing(null); load(); }} />
      ) : (
        <button type="button" className="btn small" onClick={() => setEditing('new')}>＋ Dodaj opcję płatną</button>
      ))}
      {!canEdit && <p className="muted small-note">Opcje płatne może zmieniać administrator z dostępem do wszystkich obiektów.</p>}
    </div>
  );
}

function ExtraForm({ properties, initial, onSave, onCancel, onDelete }: {
  properties: Property[]; initial: ExtraInput; onSave: (v: ExtraInput) => Promise<void>; onCancel: () => void; onDelete?: () => Promise<void>;
}) {
  const [v, setV] = useState<ExtraInput>(initial);
  const [price, setPrice] = useState(String(initial.price));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<ExtraInput>) => setV({ ...v, ...patch });
  const toggleProp = (id: number) => {
    const cur = v.property_ids ?? [];
    set({ property_ids: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(price.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return setError('Podaj poprawną cenę');
    if (v.property_ids && !v.property_ids.length) return setError('Wybierz co najmniej jeden obiekt');
    setBusy(true);
    setError('');
    try { await onSave({ ...v, price: n }); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  return (
    <form className="extra-form" onSubmit={submit}>
      <div className="row">
        <label>Nazwa<input required maxLength={80} placeholder="np. Parking" value={v.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label>Nazwa po angielsku<input maxLength={80} placeholder="np. Parking space" value={v.name_en} onChange={(e) => set({ name_en: e.target.value })} /></label>
      </div>
      <div className="row">
        <label className="narrow-time">Cena (zł)<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label className="narrow-time">Za
          <select value={v.per} onChange={(e) => set({ per: e.target.value as 'stay' | 'night' })}>
            <option value="stay">cały pobyt</option>
            <option value="night">każdą noc</option>
          </select>
        </label>
        <div className="field stepper-field">Maks. szt.<Stepper label="Maksymalna liczba sztuk" min={1} max={20} value={v.max_qty} onChange={(n) => set({ max_qty: n })} /></div>
      </div>
      <label>Opis dla gościa (opcjonalnie)<input maxLength={300} placeholder="np. miejsce pod zadaszeniem przy domku" value={v.description} onChange={(e) => set({ description: e.target.value })} /></label>
      <div className="field">
        Obiekty
        <div className="chips extra-scope">
          <button type="button" className={`chip ${v.property_ids === null ? 'active' : ''}`} onClick={() => set({ property_ids: null })}>Wszystkie</button>
          {properties.map((p) => (
            <button type="button" key={p.id} className={`chip ${v.property_ids?.includes(p.id) ? 'active' : ''}`} onClick={() => toggleProp(p.id)}>{p.name}</button>
          ))}
        </div>
      </div>
      <label className="check-row"><input type="checkbox" checked={v.active} onChange={(e) => set({ active: e.target.checked })} /> Widoczna na stronie</label>
      {error && <div className="banner error">{error}</div>}
      <div className="row">
        <button className="btn primary small" disabled={busy}>{busy ? 'Zapisywanie…' : 'Zapisz'}</button>
        <button type="button" className="btn small" onClick={onCancel}>Anuluj</button>
        {onDelete && <button type="button" className="btn small danger-outline" onClick={() => onDelete().catch((e) => setError(e.message))}>Usuń</button>}
      </div>
    </form>
  );
}
