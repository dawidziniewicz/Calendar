import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { api, type Session } from './api';
import type { Draft, Property, Reservation } from './types';
import { addDays, today } from './dates';
import Timeline from './components/Timeline';
import Agenda from './components/Agenda';
import Settings from './components/Settings';
import ReservationSheet from './components/ReservationSheet';
import Login from './components/Login';
import ReservationView from './components/ReservationView';
import UsersPage from './components/UsersPage';
import PricingPage from './components/PricingPage';
import PaymentsPage from './components/PaymentsPage';
import Mail from './components/Mail';
import { MailLinkContext, type MailIntent } from './components/EmailLink';
import ConflictMark from './components/ConflictMark';
import Requests from './components/Requests';
import { conflictIds } from './conflicts';

const ListingsPage = lazy(() => import('./components/ListingsPage')); // zdjęcia, plakat i ZIP — wczytywane tylko na tej stronie

type Tab = 'calendar' | 'agenda' | 'requests' | 'mail' | 'settings';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'calendar', label: 'Kalendarz', icon: 'M4 6h16M4 6v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1M8 3v4m8-4v4M4 10h16' },
  { id: 'agenda', label: 'Aktualności', icon: 'M5 12h14m-6-6 6 6-6 6' },
  { id: 'requests', label: 'Zapytania', icon: 'M4 13h4l2 3h4l2-3h4M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z' },
  { id: 'settings', label: 'Ustawienia i obiekty', icon: 'M3 11 12 4l9 7M5 10v10h14V10M10 20v-6h4v6' },
];
// Konto „tylko podgląd” zamiast Obiektów widzi tylko ustawienia konta.
// Poczta tylko dla administratora z dostępem do wszystkich obiektów (przed „Ustawieniami”)
const MAIL_TAB = { id: 'mail' as Tab, label: 'Poczta', icon: 'M3 6h18v12H3zM3 6l9 7 9-7' };
const ADMIN_TABS = [...TABS.slice(0, 3), MAIL_TAB, TABS[3]];
const VIEWER_TABS = TABS.map((t) => (t.id === 'settings' ? { ...t, label: 'Konto', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8m-7 8a7 7 0 0 1 14 0' } : t));
// Konto ograniczone do wybranych obiektów nie zarządza obiektami — zakładka to same ustawienia.
const LIMITED_TABS = TABS.map((t) => (t.id === 'settings' ? { ...t, label: 'Ustawienia' } : t));

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
  lang: 'pl',
  deposit: null,
  deposit_due: null,
  currency: 'PLN',
});

export default function App() {
  const [user, setUser] = useState<Session | null | undefined>(undefined); // undefined = sprawdzanie sesji

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null));
    const onAuth = () => setUser(null);
    window.addEventListener('auth:required', onAuth);
    return () => window.removeEventListener('auth:required', onAuth);
  }, []);

  if (user === undefined) return <div className="splash"><img src="/icons/icon-192.png" alt="" width={56} height={56} /></div>;
  if (user === null) return <Login onLoggedIn={setUser} />;
  return <Main user={user} onLogout={() => setUser(null)} />;
}

function Main({ user, onLogout }: { user: Session; onLogout: () => void }) {
  const readOnly = user.role === 'viewer';
  const limited = user.properties !== null;
  // Podstrona „Użytkownicy i uprawnienia” (z obsługą przycisku Wstecz / gestu cofania na iPhonie)
  type Page = 'main' | 'users' | 'pricing' | 'payments' | 'listings';
  const [page, setPage] = useState<Page>('main');
  useEffect(() => {
    const onPop = () => setPage(['users', 'pricing', 'payments', 'listings'].includes(history.state?.page) ? history.state.page : 'main');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const openPage = (p: Page) => { history.pushState({ page: p }, ''); setPage(p); window.scrollTo(0, 0); };
  const openUsers = () => openPage('users');
  const closeUsers = () => { if (history.state?.page && history.state.page !== 'main') history.back(); else setPage('main'); };
  const tabs = readOnly ? VIEWER_TABS : limited ? LIMITED_TABS : user.canManageUsers ? ADMIN_TABS : TABS;
  const [tab, setTab] = useState<Tab>(() => {
    // Kliknięcie w powiadomienie otwiera /?tab=agenda
    const fromUrl = new URLSearchParams(location.search).get('tab') as Tab | null;
    if (fromUrl && ['calendar', 'agenda', 'requests', 'mail', 'settings'].includes(fromUrl)) {
      return fromUrl;
    }
    return (sessionStorageGet('tab') as Tab) || 'calendar';
  });
  const [properties, setProperties] = useState<Property[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<Reservation | null>(null);
  const [cancellations, setCancellations] = useState<Reservation[]>([]);
  const [conflictCount, setConflictCount] = useState(0);
  const [version, setVersion] = useState(0); // podbijane po zapisie — widoki przeładowują rezerwacje
  const [pendingRequests, setPendingRequests] = useState(0);
  const [mailUnread, setMailUnread] = useState(0);
  const [mailVersion, setMailVersion] = useState(0);
  // Kliknięcie w e-mail gościa → „Poczta w kalendarzu”: zakładka Poczta z nową wiadomością albo rozmową
  const [mailIntent, setMailIntent] = useState<(MailIntent & { n: number }) | null>(null);
  // Powiadomienie o wiadomości otwiera /?tab=mail&thread=12
  const [focusThread] = useState(() => Number(new URLSearchParams(location.search).get('thread')) || null);
  useEffect(() => {
    if (!user.canManageUsers) return;
    const load = () => api.mailSummary().then((s) => setMailUnread(s.unread)).catch(() => {});
    load();
    const t = setInterval(load, 60_000); // nowe wiadomości także bez odświeżania
    return () => clearInterval(t);
  }, [version, mailVersion, user.canManageUsers]);
  // Powiadomienie o zapytaniu otwiera /?tab=requests&request=12
  const [focusRequest] = useState(() => Number(new URLSearchParams(location.search).get('request')) || null);
  useEffect(() => {
    if (new URLSearchParams(location.search).has('tab')) history.replaceState(null, '', '/');
  }, []);

  useEffect(() => {
    // licznik na zakładce: nowe zapytania + prośby o anulację
    Promise.all([api.requests('pending'), api.cancellations().catch(() => [])])
      .then(([r, c]) => setPendingRequests(r.length + c.length)).catch(() => {});
  }, [version]);

  const loadProperties = useCallback(() => {
    api.properties().then((p) => { setProperties(p); setError(''); }).catch((e) => setError(e.message));
  }, []);

  useEffect(loadProperties, [loadProperties]);

  // Stuknięcie w powiadomienie o przyjeździe otwiera /?reservation=123
  useEffect(() => {
    const id = Number(new URLSearchParams(location.search).get('reservation'));
    if (!id) return;
    history.replaceState(null, '', '/');
    api.reservation(id).then(setViewing).catch((e) => setError(e.message));
  }, []);

  // Rezerwacje odwołane na Bookingu, na które trzeba zareagować (plakietka na zakładce Aktualności)
  useEffect(() => {
    if (!readOnly) api.bookingCancellations().then(setCancellations).catch(() => {});
  }, [version, readOnly]);

  // Czy w bieżących i przyszłych rezerwacjach jest konflikt → czerwony „!” na zakładce Aktualności
  useEffect(() => {
    api.reservations(addDays(today(), -1), '9999-12-31').then((r) => setConflictCount(conflictIds(r).size)).catch(() => {});
  }, [version]);

  // Po powrocie do aplikacji na telefonie odśwież dane.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') setVersion((v) => v + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const selectTab = (t: Tab) => {
    if (page !== 'main') closeUsers();
    setTab(t);
    setMailIntent(null);
    try { sessionStorage.setItem('tab', t); } catch { /* prywatny tryb */ }
  };

  const openMail = (i: MailIntent) => {
    setViewing(null);
    selectTab('mail');
    setMailIntent({ ...i, n: Date.now() });
  };
  const mailLinks = user.canManageUsers && !readOnly ? openMail : null;

  const units = properties.flatMap((p) => p.units);
  const openNew = (unitId?: number, date?: string) => {
    if (!units.length) return;
    setEditing(emptyDraft(unitId ?? units[0].id, date ?? today()));
  };
  const openExisting = (r: Reservation) => setViewing(r);

  return (
    <MailLinkContext.Provider value={mailLinks}>
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>Od Morza <i>do</i> Gór</span>
        </div>
        <nav className="tabs-desktop">
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => selectTab(t.id)}>
              {t.label}
              {t.id === 'agenda' && <TabBadges cancellations={cancellations.length} conflicts={conflictCount} />}
              {t.id === 'requests' && pendingRequests > 0 && <span className="tab-badges"><span className="tab-badge new">{pendingRequests}</span></span>}
              {t.id === 'mail' && mailUnread > 0 && <span className="tab-badges"><span className="tab-badge new">{mailUnread}</span></span>}
            </button>
          ))}
        </nav>
        {readOnly ? (
          <span className="readonly-badge add-btn">Tylko podgląd</span>
        ) : (
          <button className="btn primary add-btn" onClick={() => openNew()} disabled={!units.length}>
            <span aria-hidden>＋</span> Rezerwacja
          </button>
        )}
      </header>

      {error && (
        <div className="banner error">
          {error} <button className="link" onClick={loadProperties}>Spróbuj ponownie</button>
        </div>
      )}

      <main className={`content content-${page !== 'main' ? 'settings' : tab}`}>
        {page === 'main' && tab === 'calendar' && <Timeline properties={properties} version={version} onSelect={openExisting} onCreate={readOnly ? undefined : openNew} />}
        {page === 'main' && tab === 'requests' && (
          <Requests version={version} readOnly={readOnly} focusId={focusRequest} onChanged={() => setVersion((v) => v + 1)} onOpenReservation={setViewing} />
        )}
        {page === 'main' && tab === 'mail' && (
          <Mail version={version} focusThread={focusThread} intent={mailIntent} onOpenReservation={setViewing} onUnreadChange={() => setMailVersion((v) => v + 1)} />
        )}
        {page === 'main' && tab === 'agenda' && <Agenda properties={properties} version={version} cancellations={cancellations} onSelect={openExisting} />}
        {page === 'users' && <UsersPage properties={properties} onBack={closeUsers} />}
        {page === 'payments' && <PaymentsPage canEdit={user.canManageUsers} onBack={closeUsers} />}
        {page === 'listings' && <Suspense fallback={<p className="muted">Wczytywanie…</p>}><ListingsPage properties={properties} onBack={closeUsers} /></Suspense>}
        {page === 'pricing' && <PricingPage properties={properties} canEditHorizon={user.canManageUsers} onBack={closeUsers} reload={() => { loadProperties(); setVersion((v) => v + 1); }} />}
        {page === 'main' && tab === 'settings' && <Settings user={user.username} readOnly={readOnly} scope={user.properties} canManageUsers={user.canManageUsers} onOpenUsers={openUsers} onOpenPricing={() => openPage('pricing')} onOpenPayments={() => openPage('payments')} onOpenListings={() => openPage('listings')} onLogout={onLogout} properties={properties} reload={() => { loadProperties(); setVersion((v) => v + 1); }} />}
      </main>

      <nav className="tabs-mobile">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => selectTab(t.id)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
            {t.id === 'agenda' && <TabBadges cancellations={cancellations.length} conflicts={conflictCount} />}
            {t.id === 'requests' && pendingRequests > 0 && <span className="tab-badges"><span className="tab-badge new">{pendingRequests}</span></span>}
            {t.id === 'mail' && mailUnread > 0 && <span className="tab-badges"><span className="tab-badge new">{mailUnread}</span></span>}
            <span>{t.label}</span>
          </button>
        ))}
        {!readOnly && <button className="fab" onClick={() => openNew()} disabled={!units.length} aria-label="Nowa rezerwacja">＋</button>}
      </nav>

      {viewing && !editing && (
        <ReservationView
          reservation={viewing}
          properties={properties}
          onClose={() => setViewing(null)}
          readOnly={readOnly}
          onEdit={() => setEditing({ ...viewing })}
          onChanged={(updated) => { setViewing(updated); setVersion((v) => v + 1); }}
        />
      )}

      {editing && !readOnly && (
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
    </MailLinkContext.Provider>
  );
}

// Znaczki na zakładce Aktualności: „!” = konflikt terminów, liczba = odwołania z Bookingu do przejrzenia
function TabBadges({ cancellations, conflicts }: { cancellations: number; conflicts: number }) {
  if (!cancellations && !conflicts) return null;
  return (
    <span className="tab-badges">
      {conflicts > 0 && <ConflictMark />}
      {cancellations > 0 && <span className="tab-badge">{cancellations}</span>}
    </span>
  );
}

function sessionStorageGet(key: string) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

// Znak: fala morza pod linią gór — ta sama co na odmorzadogor.pl
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="16" fill="#577267" />
      <path d="M12 38 25 19l7 9 5-6 15 16" fill="none" stroke="#F5F1EA" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 46c3.3 0 3.3-3 6.6-3s3.3 3 6.6 3 3.3-3 6.6-3 3.3 3 6.6 3 3.3-3 6.6-3 3.3 3 6.6 3" fill="none" stroke="#C1B1A0" strokeWidth="3.6" strokeLinecap="round" />
    </svg>
  );
}
