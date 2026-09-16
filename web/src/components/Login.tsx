import { useState, type FormEvent } from 'react';
import { api, type Session } from '../api';

export default function Login({ onLoggedIn }: { onLoggedIn: (session: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLoggedIn(await api.login(username.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <img src="/icons/icon-192.png" alt="" width={64} height={64} />
        <h1>Od Morza Do Gór</h1>
        <p className="muted">Kalendarz rezerwacji</p>
        <label>
          Login
          <input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            required value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Hasło
          <input name="password" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="banner error">{error}</div>}
        <button type="submit" className="btn primary big" disabled={busy}>{busy ? 'Logowanie…' : 'Zaloguj się'}</button>
      </form>
    </div>
  );
}
