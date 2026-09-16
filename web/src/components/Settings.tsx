import { useState } from 'react';
import { api, type SyncResult } from '../api';
import type { Property, Unit } from '../types';
import { SOURCES } from '../types';

type Props = { user: string; readOnly: boolean; onLogout: () => void; properties: Property[]; reload: () => void };

export default function Settings({ user, readOnly, onLogout, properties, reload }: Props) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult[] | null>(null);
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sync = async () => {
    setSyncing(true);
    setError('');
    try {
      setSyncResult(await api.sync());
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const addProperty = () => {
    const name = prompt('Nazwa nowego obiektu:');
    if (name?.trim()) run(() => api.createProperty({ name }));
  };

  if (readOnly) {
    return (
      <section className="settings">
        <div className="panel"><p className="muted" style={{ margin: 0 }}>To konto ma dostęp tylko do podglądu rezerwacji.</p></div>
        <AccountPanel user={user} onLogout={onLogout} />
      </section>
    );
  }

  const feedCount = properties.reduce((n, p) => n + p.units.reduce((m, u) => m + u.feeds.length, 0), 0);
  const summary = syncResult && syncResult.reduce((a, r) => ({ added: a.added + r.added, updated: a.updated + r.updated, cancelled: a.cancelled + r.cancelled, failed: a.failed + (r.ok ? 0 : 1) }),
    { added: 0, updated: 0, cancelled: 0, failed: 0 });

  return (
    <section className="settings">
      <div className="panel sync-panel">
        <div>
          <h2>Synchronizacja z Booking.com</h2>
          <p className="muted">
            {feedCount ? `Połączonych kalendarzy: ${feedCount}. Serwer pobiera je automatycznie co 15 minut.` : 'Dodaj adresy kalendarzy iCal z Booking.com przy każdym domku poniżej.'}
          </p>
          {summary && (
            <p>
              Nowe: <b>{summary.added}</b> · zmienione: <b>{summary.updated}</b> · anulowane: <b>{summary.cancelled}</b>
              {summary.failed > 0 && <span className="warn"> · błędy: {summary.failed}</span>}
            </p>
          )}
        </div>
        <button className="btn primary" onClick={sync} disabled={syncing || !feedCount}>{syncing ? 'Synchronizuję…' : 'Synchronizuj teraz'}</button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {properties.map((p) => <PropertyPanel key={p.id} property={p} run={run} />)}

      <div className="settings-footer">
        <button className="btn" onClick={addProperty}>＋ Dodaj obiekt</button>
      </div>

      <AccountPanel user={user} onLogout={onLogout} />
    </section>
  );
}

function PropertyPanel({ property: p, run }: { property: Property; run: (fn: () => Promise<unknown>) => void }) {
  const [form, setForm] = useState({ name: p.name, location: p.location, address: p.address });
  const dirty = form.name !== p.name || form.location !== p.location || form.address !== p.address;

  return (
    <div className="panel">
      <div className="property-head">
        <input className="title-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Nazwa obiektu" />
        <div className="row">
          <input placeholder="Lokalizacja" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <input placeholder="Adres" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </div>
        {dirty && <button className="btn primary small" onClick={() => run(() => api.updateProperty(p.id, form))}>Zapisz obiekt</button>}
      </div>

      {p.units.map((u) => <UnitRow key={u.id} unit={u} run={run} />)}

      <div className="row end">
        <button className="btn small" onClick={() => {
          const name = prompt(`Nazwa nowego domku/apartamentu w „${p.name}”:`);
          if (name?.trim()) run(() => api.createUnit({ property_id: p.id, name, capacity: 4, color: '#2f7d6d' }));
        }}>＋ Dodaj domek / apartament</button>
        <button className="btn small danger-outline" onClick={() => {
          if (confirm(`Usunąć obiekt „${p.name}” razem z domkami i WSZYSTKIMI ich rezerwacjami?`)) run(() => api.deleteProperty(p.id));
        }}>Usuń obiekt</button>
      </div>
    </div>
  );
}

function UnitRow({ unit: u, run }: { unit: Unit; run: (fn: () => Promise<unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: u.name, capacity: u.capacity, color: u.color });
  const [feedUrl, setFeedUrl] = useState('');
  const [feedSource, setFeedSource] = useState('booking');
  const [copied, setCopied] = useState('');
  const dirty = form.name !== u.name || form.capacity !== u.capacity || form.color !== u.color;
  const exportUrl = (exclude: string) => `${location.origin}/ical/${u.export_token}.ics?exclude=${exclude}`;

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      prompt('Skopiuj adres:', text);
    }
  };

  return (
    <div className={`unit-row ${open ? 'open' : ''}`}>
      <button className="unit-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
        <i style={{ background: u.color }} />
        <span className="unit-title">{u.name}</span>
        <span className="muted">do {u.capacity} os.</span>
        {u.feeds.map((f) => (
          <span key={f.id} className={`badge ${f.last_error ? 'bad' : f.last_sync_at ? 'ok' : ''}`}>{SOURCES[f.source] ?? f.source}</span>
        ))}
        <span className="chev">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="unit-details">
          <div className="row">
            <label>Nazwa<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="narrow">Osób<input type="number" min={0} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })} /></label>
            <label className="narrow">Kolor<input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} /></label>
          </div>
          {dirty && <button className="btn primary small" onClick={() => run(() => api.updateUnit(u.id, form))}>Zapisz zmiany</button>}

          <h4>1. Import z Booking.com / Airbnb (zajęte terminy)</h4>
          <p className="muted">W Bookingu przy eksporcie wybierz <b>„zarezerwowane i zamknięte dni”</b>, żeby widzieć też zamknięte terminy.</p>
          {u.feeds.map((f) => (
            <div key={f.id} className="feed">
              <div>
                <b>{SOURCES[f.source] ?? f.source}</b> <span className="muted url">{f.url}</span>
                <div className={f.last_error ? 'warn' : 'muted'}>
                  {f.last_error ? `Błąd: ${f.last_error}` : f.last_sync_at ? `Ostatnia synchronizacja: ${new Date(f.last_sync_at.replace(' ', 'T') + 'Z').toLocaleString('pl-PL')}` : 'Jeszcze nie synchronizowano'}
                </div>
              </div>
              <div className="feed-actions">
                <button className="btn small" onClick={() => {
                  const url = prompt('Wklej nowy link do kalendarza (rezerwacje i dane gości zostaną):', f.url);
                  if (url?.trim() && url.trim() !== f.url) run(() => api.updateFeed(f.id, url.trim()));
                }}>Zmień link</button>
                <button className="btn small danger-outline" onClick={() => confirm('Odłączyć ten kalendarz? Rezerwacje zostaną w aplikacji. Jeśli chcesz tylko wkleić nowy link z Bookingu, użyj „Zmień link” — inaczej rezerwacje się zdublują.') && run(() => api.deleteFeed(f.id))}>Odłącz</button>
              </div>
            </div>
          ))}
          <div className="row">
            <select value={feedSource} onChange={(e) => setFeedSource(e.target.value)} aria-label="Źródło">
              <option value="booking">Booking.com</option>
              <option value="airbnb">Airbnb</option>
              <option value="other">Inne</option>
            </select>
            <input className="grow" placeholder="https://ical.booking.com/v1/export?t=…" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} />
            <button className="btn small" disabled={!feedUrl.trim()} onClick={() => { run(() => api.createFeed({ unit_id: u.id, source: feedSource, url: feedUrl.trim() })); setFeedUrl(''); }}>Dodaj</button>
          </div>

          <h4>2. Eksport do Booking.com (blokuje terminy zarezerwowane bezpośrednio)</h4>
          <p className="muted">Wklej ten adres w extranecie Booking.com → Kalendarz → Synchronizacja kalendarzy → Importuj kalendarz.</p>
          <div className="export">
            <code>{exportUrl('booking')}</code>
            <button className="btn small" onClick={() => copy(exportUrl('booking'), 'booking')}>{copied === 'booking' ? 'Skopiowano ✓' : 'Kopiuj dla Booking'}</button>
            <button className="btn small" onClick={() => copy(exportUrl('airbnb'), 'airbnb')}>{copied === 'airbnb' ? 'Skopiowano ✓' : 'Kopiuj dla Airbnb'}</button>
          </div>

          <div className="row end">
            <button className="btn small" onClick={() => confirm('Wygenerować nowy adres eksportu? Stary przestanie działać i trzeba będzie go podmienić w Bookingu.') && run(() => api.regenerateToken(u.id))}>Nowy adres eksportu</button>
            <button className="btn small danger-outline" onClick={() => confirm(`Usunąć „${u.name}” razem z WSZYSTKIMI rezerwacjami?`) && run(() => api.deleteUnit(u.id))}>Usuń</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountPanel({ user, onLogout }: { user: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const logout = async () => {
    try { await api.logout(); } catch { /* i tak wylogowujemy lokalnie */ }
    onLogout();
  };

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== repeat) { setMsg({ ok: false, text: 'Nowe hasła się różnią' }); return; }
    try {
      await api.changePassword(current, next);
      setMsg({ ok: true, text: 'Hasło zmienione. Inne urządzenia zostały wylogowane.' });
      setCurrent(''); setNext(''); setRepeat(''); setOpen(false);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="panel">
      <div className="user-line">
        <span>Zalogowano jako <b>{user}</b></span>
        <div className="row">
          <button className="btn small" onClick={() => { setOpen(!open); setMsg(null); }}>Zmień hasło</button>
          <button className="btn small danger-outline" onClick={logout}>Wyloguj</button>
        </div>
      </div>
      {open && (
        <form className="password-form" onSubmit={change}>
          <input type="password" autoComplete="current-password" placeholder="Obecne hasło" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          <input type="password" autoComplete="new-password" placeholder="Nowe hasło (min. 8 znaków)" minLength={8} required value={next} onChange={(e) => setNext(e.target.value)} />
          <input type="password" autoComplete="new-password" placeholder="Powtórz nowe hasło" minLength={8} required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          <button className="btn primary" type="submit">Zapisz nowe hasło</button>
        </form>
      )}
      {msg && <div className={`banner ${msg.ok ? 'info' : 'error'}`} style={{ marginTop: 10 }}>{msg.text}</div>}
    </div>
  );
}
