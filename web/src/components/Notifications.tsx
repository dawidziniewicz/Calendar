import { useEffect, useState } from 'react';
import { api } from '../api';

type State = 'loading' | 'unsupported' | 'install' | 'denied' | 'off' | 'on';

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

function base64UrlToBytes(b64: string) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) ?? navigator.serviceWorker.register('/sw.js');
}

export default function Notifications() {
  const [state, setState] = useState<State>('loading');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [time, setTime] = useState('09:00');
  const [savedTime, setSavedTime] = useState('09:00');
  const [changes, setChanges] = useState(true);

  useEffect(() => {
    api.pushSettings().then((s) => { setTime(s.time); setSavedTime(s.time); setChanges(s.changes); }).catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (!supported) return setState(isIos() && !isStandalone() ? 'install' : 'unsupported');
      if (Notification.permission === 'denied') return setState('denied');
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub ? 'on' : 'off');
    })().catch(() => setState('unsupported'));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const enable = () => run(async () => {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setState(permission === 'denied' ? 'denied' : 'off');
      return;
    }
    const reg = await registration();
    await navigator.serviceWorker.ready;
    const { publicKey } = await api.pushPublicKey();
    const sub = (await reg.pushManager.getSubscription())
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
    await api.pushSubscribe(sub.toJSON() as PushSubscriptionJSON);
    setState('on');
    setMsg({ ok: true, text: 'Powiadomienia włączone na tym urządzeniu.' });
  });

  const disable = () => run(async () => {
    const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
    if (sub) {
      await api.pushUnsubscribe(sub.endpoint);
      await sub.unsubscribe();
    }
    setState('off');
  });

  const saveTime = () => run(async () => {
    const res = await api.savePushSettings({ time });
    setSavedTime(res.time);
    setMsg({ ok: true, text: `Zapisano — powiadomienie będzie przychodzić codziennie o ${res.time}.` });
  });

  const toggleChanges = (value: boolean) => run(async () => {
    setChanges(value);
    const res = await api.savePushSettings({ changes: value });
    setChanges(res.changes);
  });

  const test = () => run(async () => {
    const { sent } = await api.pushTest();
    setMsg(sent ? { ok: true, text: 'Wysłano powiadomienie testowe.' } : { ok: false, text: 'Brak aktywnych urządzeń — wyłącz i włącz powiadomienia ponownie.' });
  });

  return (
    <div className="panel">
      <h2>Powiadomienia</h2>
      <p className="muted notif-desc">
        Codziennie o {savedTime} osobne powiadomienie o każdym dzisiejszym przyjeździe.
        {changes && ' Do tego powiadomienia o nowych, zmienionych i odwołanych rezerwacjach (z Bookingu i od innych osób).'}
      </p>

      {state !== 'unsupported' && (
        <div className="row notif-time">
          <label className="narrow-time">
            Godzina powiadomienia
            <input type="time" step={300} value={time} onChange={(e) => e.target.value && setTime(e.target.value)} />
          </label>
          {time !== savedTime && <button className="btn primary small" disabled={busy} onClick={saveTime}>Zapisz godzinę</button>}
        </div>
      )}

      {state !== 'unsupported' && (
        <label className="switch-row">
          <input type="checkbox" checked={changes} disabled={busy} onChange={(e) => toggleChanges(e.target.checked)} />
          <span>
            <b>Zmiany w rezerwacjach</b>
            <small>Nowe, zmienione, usunięte i odwołane — z Bookingu oraz gdy zmieni je inna osoba</small>
          </span>
        </label>
      )}

      {state === 'loading' && <p className="muted">Sprawdzanie…</p>}
      {state === 'install' && (
        <p className="warn">Na iPhonie powiadomienia działają tylko w aplikacji dodanej do ekranu początkowego (Safari → Udostępnij → Do ekranu początkowego). Otwórz ją z ikony i włącz tutaj.</p>
      )}
      {state === 'unsupported' && <p className="warn">Ta przeglądarka nie obsługuje powiadomień. Na iPhonie potrzebny jest iOS 16.4 lub nowszy.</p>}
      {state === 'denied' && (
        <p className="warn">Powiadomienia są zablokowane. Na iPhonie: Ustawienia → Powiadomienia → Kalendarz → Zezwalaj na powiadomienia.</p>
      )}
      {state === 'off' && <button className="btn primary" disabled={busy} onClick={enable}>Włącz powiadomienia</button>}
      {state === 'on' && (
        <div className="row">
          <span className="badge ok">Włączone na tym urządzeniu</span>
          <button className="btn small" disabled={busy} onClick={test}>Wyślij test</button>
          <button className="btn small danger-outline" disabled={busy} onClick={disable}>Wyłącz</button>
        </div>
      )}
      {msg && <div className={`banner ${msg.ok ? 'info' : 'error'}`} style={{ marginTop: 10 }}>{msg.text}</div>}
    </div>
  );
}
