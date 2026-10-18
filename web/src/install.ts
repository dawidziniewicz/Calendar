// Instalacja aplikacji na ekranie głównym.
// Android/Chrome wysyła zdarzenie „beforeinstallprompt” zaraz po wczytaniu strony — łapiemy je od razu,
// żeby przycisk w Ustawieniach mógł później otworzyć systemowe okno instalacji.

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // nie pokazuj paska Chrome — instalacja z przycisku w Ustawieniach
  deferred = e as InstallPromptEvent;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  notify();
});

export const canPromptInstall = () => deferred !== null;

export function onInstallChange(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  const e = deferred;
  deferred = null; // zdarzenia nie da się użyć drugi raz
  await e.prompt();
  const { outcome } = await e.userChoice;
  notify();
  return outcome;
}

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

export type Platform = 'ios' | 'android' | 'desktop';
export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS udaje Maca — rozpoznajemy po ekranie dotykowym
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** Na iPhonie dodać do ekranu można z Safari (od iOS 16.4 także z Chrome/Edge przez „Udostępnij”). */
export const isIosSafari = () => /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
