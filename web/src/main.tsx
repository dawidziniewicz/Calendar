import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './install'; // łapie zdarzenie instalacji (Android/Chrome) zanim otworzysz Ustawienia
import './viewport'; // okna dopasowane do widocznego ekranu (klawiatura na iPhonie)

// Po wdrożeniu nowej wersji otwarta wcześniej aplikacja szuka plików, których już nie ma (serwer oddaje wtedy stronę HTML:
// „'text/html' is not a valid JavaScript MIME type”) → przeładuj raz, żeby pobrać nową wersję.
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (Date.now() - Number(sessionStorage.getItem('reloaded-at') || 0) < 30_000) return; // bez pętli przeładowań
    sessionStorage.setItem('reloaded-at', String(Date.now()));
  } catch { /* prywatny tryb */ }
  e.preventDefault();
  location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
