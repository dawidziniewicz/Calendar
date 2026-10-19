import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './install'; // łapie zdarzenie instalacji (Android/Chrome) zanim otworzysz Ustawienia
import './viewport'; // okna dopasowane do widocznego ekranu (klawiatura na iPhonie)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
