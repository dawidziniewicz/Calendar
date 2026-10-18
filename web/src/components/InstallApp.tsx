import { useEffect, useState } from 'react';
import { canPromptInstall, detectPlatform, isIosSafari, isStandalone, onInstallChange, promptInstall, type Platform } from '../install';

const ShareIcon = () => (
  <svg className="inline-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-label="ikona Udostępnij">
    <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
  </svg>
);
const AddIcon = () => (
  <svg className="inline-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-label="ikona Dodaj">
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="M12 8v8M8 12h8" />
  </svg>
);
const MenuIcon = () => <b className="inline-key" aria-label="menu">⋮</b>;

export default function InstallApp() {
  const [installed, setInstalled] = useState(isStandalone);
  const [canPrompt, setCanPrompt] = useState(canPromptInstall);
  const [platform, setPlatform] = useState<Platform>(detectPlatform);
  const [msg, setMsg] = useState('');

  useEffect(() => onInstallChange(() => setCanPrompt(canPromptInstall())), []);
  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)');
    const onChange = () => setInstalled(isStandalone());
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // Otwarta z ikony na ekranie głównym — instrukcja niepotrzebna
  if (installed) return null;

  const install = async () => {
    const outcome = await promptInstall();
    if (outcome === 'accepted') setMsg('Gotowe — ikona „Kalendarz” pojawi się na ekranie głównym.');
    else if (outcome === 'dismissed') setMsg('Instalacja anulowana. Możesz spróbować ponownie po odświeżeniu strony.');
    else setMsg('Ta przeglądarka nie pozwala zainstalować przyciskiem — skorzystaj z instrukcji poniżej.');
  };

  return (
    <div className="panel install-panel">
      <h2>Aplikacja na telefonie</h2>
      <p className="muted notif-desc">Dodaj kalendarz do ekranu głównego — otwiera się jak zwykła aplikacja, na pełnym ekranie i z powiadomieniami.</p>

      {canPrompt && (
        <button type="button" className="btn primary big install-btn" onClick={install}>
          <AddIcon /> Zainstaluj aplikację
        </button>
      )}
      {msg && <div className="banner info" style={{ marginTop: 10 }}>{msg}</div>}

      <div className="segmented install-tabs">
        {([['ios', 'iPhone / iPad'], ['android', 'Android'], ['desktop', 'Komputer']] as const).map(([id, label]) => (
          <button key={id} type="button" className={`chip ${platform === id ? 'active' : ''}`} onClick={() => setPlatform(id)}>{label}</button>
        ))}
      </div>

      {platform === 'ios' && (
        <>
          {detectPlatform() === 'ios' && !isIosSafari() && (
            <p className="warn small-note">Najpewniej działa w <b>Safari</b> — otwórz tę stronę w Safari i wykonaj kroki poniżej.</p>
          )}
          <ol className="install-steps">
            <li>Otwórz tę stronę w <b>Safari</b>.</li>
            <li>Stuknij <b>Udostępnij</b> <ShareIcon /> — na dole ekranu (na iPadzie u góry). W nowszym iOS może być pod przyciskiem <b>⋯</b>.</li>
            <li>Przewiń listę w dół i wybierz <b>Do ekranu początkowego</b> <AddIcon />.</li>
            <li>Stuknij <b>Dodaj</b> w prawym górnym rogu.</li>
            <li>Otwórz aplikację <b>z nowej ikony</b> i zaloguj się — iPhone trzyma logowanie z ikony osobno od Safari.</li>
          </ol>
          <p className="muted small-note">Apple nie pozwala stronom instalować się jednym przyciskiem, dlatego na iPhonie trzeba to zrobić ręcznie (zajmuje 10 sekund). Powiadomienia wymagają iOS 16.4 lub nowszego.</p>
        </>
      )}

      {platform === 'android' && (
        <>
          {!canPrompt && detectPlatform() === 'android' && (
            <p className="muted small-note">Przycisk „Zainstaluj aplikację” pojawia się w Chrome. Jeśli go nie widzisz, zrób to ręcznie:</p>
          )}
          <ol className="install-steps">
            <li>Otwórz tę stronę w <b>Chrome</b>.</li>
            <li>Stuknij menu <MenuIcon /> w prawym górnym rogu.</li>
            <li>Wybierz <b>Zainstaluj aplikację</b> (albo <b>Dodaj do ekranu głównego</b>) i potwierdź.</li>
            <li>Otwórz aplikację z nowej ikony <b>Kalendarz</b>.</li>
          </ol>
          <p className="muted small-note">Samsung Internet: menu <b>≡</b> → <b>Dodaj stronę do</b> → <b>Ekran startowy</b>.</p>
        </>
      )}

      {platform === 'desktop' && (
        <ol className="install-steps">
          <li>W <b>Chrome</b> lub <b>Edge</b> kliknij ikonę instalacji po prawej stronie paska adresu (monitor ze strzałką) — albo przycisk „Zainstaluj aplikację” powyżej.</li>
          <li>W <b>Safari na Macu</b>: menu <b>Plik</b> → <b>Dodaj do Docka</b>.</li>
        </ol>
      )}
    </div>
  );
}
