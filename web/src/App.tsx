import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Draft, Property, Reservation } from './types';
import { addDays, today } from './dates';
import Timeline from './components/Timeline';
import Agenda from './components/Agenda';
import Settings from './components/Settings';
import ReservationSheet from './components/ReservationSheet';
import Login from './components/Login';
import ReservationView from './components/ReservationView';

type Tab = 'calendar' | 'agenda' | 'settings';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'calendar', label: 'Kalendarz', icon: 'M4 6h16M4 6v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1M8 3v4m8-4v4M4 10h16' },
  { id: 'agenda', label: 'Przyjazdy', icon: 'M5 12h14m-6-6 6 6-6 6' },
  { id: 'settings', label: 'Obiekty', icon: 'M3 11 12 4l9 7M5 10v10h14V10M10 20v-6h4v6' },
];

export const emptyDraft = (unitId: number, checkIn: string): Draft => ({
  unit_id: unitId,
  check_in: checkIn,
  check_out: addDays(checkIn, 2),
  status: 'confirmed',
  source: 'direct',
  guest_name: '',
  guest_phone: '',
  guest_email: '',
  adults: 2,
  children: 0,
  price: null,
  paid: null,
  notes: '',
});

export default function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined); // undefined = sprawdzanie sesji

  useEffect(() => {
    api.me().then((u) => setUser(u.username)).catch(() => setUser(null));
    const onAuth = () => setUser(null);
    window.addEventListener('auth:required', onAuth);
    return () => window.removeEventListener('auth:required', onAuth);
  }, []);

  if (user === undefined) return <div className="splash"><img src="/icons/icon-192.png" alt="" width={56} height={56} /></div>;
  if (user === null) return <Login onLoggedIn={setUser} />;
  return <Main user={user} onLogout={() => setUser(null)} />;
}

function Main({ user, onLogout }: { user: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>(() => (sessionStorageGet('tab') as Tab) || 'calendar');
  const [properties, setProperties] = useState<Property[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<Reservation | null>(null);
  const [cancellations, setCancellations] = useState<Reservation[]>([]);
  const [version, setVersion] = useState(0); // podbijane po zapisie — widoki przeładowują rezerwacje

  const loadProperties = useCallback(() => {
    api.properties().then((p) => { setProperties(p); setError(''); }).catch((e) => setError(e.message));
  }, []);

  useEffect(loadProperties, [loadProperties]);

  // Rezerwacje odwołane na Bookingu, na które trzeba zareagować (plakietka na zakładce Przyjazdy)
  useEffect(() => {
    api.bookingCancellations().then(setCancellations).catch(() => {});
  }, [version]);

  // Po powrocie do aplikacji na telefonie odśwież dane.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') setVersion((v) => v + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const selectTab = (t: Tab) => {
    setTab(t);
    try { sessionStorage.setItem('tab', t); } catch { /* prywatny tryb */ }
  };

  const units = properties.flatMap((p) => p.units);
  const openNew = (unitId?: number, date?: string) => {
    if (!units.length) return;
    setEditing(emptyDraft(unitId ?? units[0].id, date ?? today()));
  };
  const openExisting = (r: Reservation) => setViewing(r);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/icons/icon-192.png" alt="" width={28} height={28} />
          <span>Od Morza Do Gór</span>
        </div>
        <nav className="tabs-desktop">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => selectTab(t.id)}>
              {t.label}
              {t.id === 'agenda' && cancellations.length > 0 && <span className="tab-badge">{cancellations.length}</span>}
            </button>
          ))}
        </nav>
        <button className="btn primary add-btn" onClick={() => openNew()} disabled={!units.length}>
          <span aria-hidden>＋</span> Rezerwacja
        </button>
      </header>

      {error && (
        <div className="banner error">
          {error} <button className="link" onClick={loadProperties}>Spróbuj ponownie</button>
        </div>
      )}

      <main className={`content content-${tab}`}>
        {tab === 'calendar' && <Timeline properties={properties} version={version} onSelect={openExisting} onCreate={openNew} />}
        {tab === 'agenda' && <Agenda properties={properties} version={version} cancellations={cancellations} onSelect={openExisting} />}
        {tab === 'settings' && <Settings user={user} onLogout={onLogout} properties={properties} reload={() => { loadProperties(); setVersion((v) => v + 1); }} />}
      </main>

      <nav className="tabs-mobile">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => selectTab(t.id)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
            {t.id === 'agenda' && cancellations.length > 0 && <span className="tab-badge">{cancellations.length}</span>}
            <span>{t.label}</span>
          </button>
        ))}
        <button className="fab" onClick={() => openNew()} disabled={!units.length} aria-label="Nowa rezerwacja">＋</button>
      </nav>

      {viewing && !editing && (
        <ReservationView
          reservation={viewing}
          properties={properties}
          onClose={() => setViewing(null)}
          onEdit={() => setEditing({ ...viewing })}
          onChanged={(updated) => { setViewing(updated); setVersion((v) => v + 1); }}
        />
      )}

      {editing && (
        <ReservationSheet
          draft={editing}
          properties={properties}
          // Anuluj w edycji istniejącej rezerwacji wraca do podglądu
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setViewing(saved && editing.id ? saved : null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}

function sessionStorageGet(key: string) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
