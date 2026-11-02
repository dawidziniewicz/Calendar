import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Property, SmsTemplate } from '../types';
import { SAMPLE, SMS_FIELDS, fillSms, smsParts } from '../sms';
import AutoTextarea from './AutoTextarea';

type Draft = { id: number | null; name: string; body: string; scope: string }; // scope: '' | 'p<id>' | 'u<id>'

const scopeOf = (t: SmsTemplate) => (t.unit_id != null ? `u${t.unit_id}` : t.property_id != null ? `p${t.property_id}` : '');

// Szablony SMS / WhatsApp: gotowe teksty z polami {imie}, {przyjazd}… — np. dane do przyjazdu z kodem do skrzynki
// dla jednego apartamentu albo prośba o zaliczkę z linkiem do płatności dla wszystkich.
export default function SmsTemplatesPage({ properties, onBack }: { properties: Property[]; onBack: () => void }) {
  const [list, setList] = useState<SmsTemplate[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const caret = useRef<number | null>(null);
  // po wstawieniu pola kursor stoi za nim (dopiero po odświeżeniu treści)
  useLayoutEffect(() => {
    const el = area.current;
    if (caret.current == null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [draft?.body]);

  const load = () => api.smsTemplates().then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const scopeLabel = (t: SmsTemplate) => {
    if (t.unit_id != null) {
      for (const p of properties) { const u = p.units.find((x) => x.id === t.unit_id); if (u) return `${p.name} · ${u.name}`; }
      return 'domek';
    }
    if (t.property_id != null) return properties.find((p) => p.id === t.property_id)?.name ?? 'obiekt';
    return 'Wszystkie obiekty';
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return setError('Podaj nazwę szablonu');
    setBusy(true);
    setError('');
    const body = {
      name: draft.name, body: draft.body,
      property_id: draft.scope.startsWith('p') ? Number(draft.scope.slice(1)) : null,
      unit_id: draft.scope.startsWith('u') ? Number(draft.scope.slice(1)) : null,
    };
    try {
      if (draft.id) await api.updateSmsTemplate(draft.id, body); else await api.createSmsTemplate(body);
      setDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: SmsTemplate) => {
    if (!confirm(`Usunąć szablon „${t.name}”?`)) return;
    try { await api.deleteSmsTemplate(t.id); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  // wstawia pole w miejscu kursora
  const insert = (field: string) => {
    if (!draft) return;
    const el = area.current;
    const tag = `{${field}}`;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? draft.body.length;
    caret.current = start + tag.length;
    setDraft({ ...draft, body: draft.body.slice(0, start) + tag + draft.body.slice(end) });
  };

  const example = draft ? fillSms(draft.body, SAMPLE) : '';
  const parts = smsParts(example);

  return (
    <section className="pricing-page sms-templates-page">
      <div className="page-head">
        <button type="button" className="link back" onClick={onBack}>‹ Ustawienia</button>
        <h1>Szablony SMS</h1>
      </div>
      <p className="muted page-lead">
        Gotowe wiadomości do gościa — wysyłasz je z rezerwacji przyciskiem „SMS / WhatsApp”. Szablon może być dla wszystkich obiektów,
        dla jednego obiektu albo dla jednego domku (np. adres, kod do skrzynki na klucze i hasło Wi-Fi). Pola w nawiasach klamrowych aplikacja uzupełni danymi rezerwacji.
      </p>
      {error && <div className="banner error">{error}</div>}

      {draft ? (
        <div className="panel sms-editor">
          <h2 className="panel-title">{draft.id ? 'Edycja szablonu' : 'Nowy szablon'}</h2>
          <fieldset className="plain">
            <label>Nazwa<input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="np. Przyjazd — Myśliwska 36/2" /></label>
            <label>Dla
              <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
                <option value="">Wszystkie obiekty</option>
                {properties.map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    <option value={`p${p.id}`}>{p.name} — cały obiekt</option>
                    {p.units.map((u) => <option key={u.id} value={`u${u.id}`}>{u.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="full">Treść
              <AutoTextarea rows={6} value={draft.body} maxLength={2000}
                onFocus={(e) => { area.current = e.currentTarget; }} onSelect={(e) => { area.current = e.currentTarget; }}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                placeholder={'np. Adres: Karpacz, ul. Myśliwska 36/2. Kod do skrzynki na klucze: … (skrzynka na kładce schodowej). Kod do szlabanu: … Hasło Wi-Fi: …'} />
            </label>
            <div className="full sms-fields">
              <small className="muted">Wstaw pole:</small>
              {SMS_FIELDS.map(([k, label]) => <button type="button" key={k} className="chip" title={label} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(k)}>{label}</button>)}
            </div>
            {draft.body && (
              <div className="full sms-example">
                <small className="muted">Przykład ({parts.len} znaków · {parts.parts} {parts.parts === 1 ? 'SMS' : 'SMS-y'}):</small>
                <p>{example}</p>
              </div>
            )}
          </fieldset>
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Zapisywanie…' : 'Zapisz'}</button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>Anuluj</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn primary" onClick={() => setDraft({ id: null, name: '', body: '', scope: '' })}>＋ Nowy szablon</button>
      )}

      {list && (
        <ul className="sms-template-list">
          {list.length === 0 && <li className="muted">Brak szablonów.</li>}
          {list.map((t) => (
            <li key={t.id} className="panel">
              <div className="sms-template-head">
                <b>{t.name}</b>
                <span className="tag-scope">{scopeLabel(t)}</span>
              </div>
              <p className="sms-template-body">{t.body}</p>
              {t.editable !== false && (
                <div className="row-actions">
                  <button type="button" className="link" onClick={() => { setError(''); setDraft({ id: t.id, name: t.name, body: t.body, scope: scopeOf(t) }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edytuj</button>
                  <button type="button" className="link danger-link" onClick={() => remove(t)}>Usuń</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
