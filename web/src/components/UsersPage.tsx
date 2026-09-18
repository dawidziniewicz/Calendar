import { useEffect, useState, type FormEvent } from 'react';
import { api, type AppUser, type UserInput } from '../api';
import type { Property } from '../types';

type Props = { properties: Property[]; onBack: () => void };

const ROLE_LABELS = { admin: 'Admin — pełna edycja', viewer: 'Obsługa — tylko podgląd' } as const;

export default function UsersPage({ properties, onBack }: Props) {
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | 'new' | null>(null);

  const load = () => api.users().then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const scopeLabel = (u: AppUser) =>
    u.properties ? u.properties.map((id) => properties.find((p) => p.id === id)?.name ?? `#${id}`).join(', ') : 'Wszystkie obiekty';

  return (
    <section className="users-page">
      <div className="page-head">
        <button type="button" className="link back" onClick={onBack}>‹ Ustawienia</button>
        <h1>Użytkownicy i uprawnienia</h1>
      </div>

      {error && <div className="banner error">{error}</div>}

      {openId === 'new' ? (
        <div className="panel">
          <h2>Nowy użytkownik</h2>
          <UserForm
            properties={properties}
            initial={{ role: 'viewer', properties: null }}
            isNew
            onCancel={() => setOpenId(null)}
            onSaved={() => { setOpenId(null); load(); }}
          />
        </div>
      ) : (
        <button type="button" className="add-property" onClick={() => setOpenId('new')}>＋ Dodaj użytkownika</button>
      )}

      {!users && !error && <p className="muted">Wczytywanie…</p>}
      {users?.map((u) => (
        <div key={u.id} className="panel user-card">
          <button type="button" className="user-summary" onClick={() => setOpenId(openId === u.id ? null : u.id)} aria-expanded={openId === u.id}>
            <span className="user-avatar">{u.username.slice(0, 1).toUpperCase()}</span>
            <span className="user-main">
              <b>{u.username}{u.me && <span className="muted"> (Ty)</span>}</b>
              <span className="user-badges">
                <span className={`badge ${u.role === 'admin' ? 'ok' : ''}`}>{u.role === 'admin' ? 'Admin' : 'Tylko podgląd'}</span>
                <span className="badge">{scopeLabel(u)}</span>
              </span>
            </span>
            <span className="chev">{openId === u.id ? '▴' : '▾'}</span>
          </button>

          {openId === u.id && (
            <div className="user-details">
              {u.me ? (
                <p className="muted">Własnych uprawnień nie możesz zmienić — to chroni przed przypadkowym zablokowaniem się. Hasło zmienisz poniżej.</p>
              ) : (
                <UserForm
                  properties={properties}
                  initial={{ role: u.role, properties: u.properties }}
                  onCancel={() => setOpenId(null)}
                  onSaved={() => { setOpenId(null); load(); }}
                  save={(input) => api.updateUser(u.id, input)}
                />
              )}
              <PasswordReset user={u} />
              {!u.me && (
                <button
                  type="button"
                  className="btn small danger-outline delete-user"
                  onClick={async () => {
                    if (!confirm(`Usunąć użytkownika „${u.username}”? Straci dostęp do aplikacji.`)) return;
                    try { await api.deleteUser(u.id); setOpenId(null); load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
                  }}
                >
                  Usuń użytkownika
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function UserForm({ properties, initial, isNew, onCancel, onSaved, save }: {
  properties: Property[];
  initial: UserInput;
  isNew?: boolean;
  onCancel: () => void;
  onSaved: () => void;
  save?: (input: UserInput) => Promise<unknown>;
}) {
  const [role, setRole] = useState(initial.role);
  const [all, setAll] = useState(initial.properties === null);
  const [picked, setPicked] = useState<number[]>(initial.properties ?? []);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!all && !picked.length) { setError('Zaznacz co najmniej jeden obiekt albo „Wszystkie obiekty”'); return; }
    if (isNew && password !== repeat) { setError('Hasła się różnią'); return; }
    const input: UserInput = { role, properties: all ? null : picked };
    setBusy(true);
    setError('');
    try {
      if (isNew) await api.createUser({ ...input, username: username.trim(), password });
      else await save?.(input);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="user-form" onSubmit={submit}>
      {isNew && (
        <>
          <label>Login<input autoCapitalize="none" autoCorrect="off" autoComplete="off" required value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          <label>Hasło (min. 8 znaków)<input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label>Powtórz hasło<input type="password" autoComplete="new-password" required minLength={8} value={repeat} onChange={(e) => setRepeat(e.target.value)} /></label>
        </>
      )}

      <div className="field">
        Rola
        <div className="segmented">
          {(['admin', 'viewer'] as const).map((r) => (
            <button key={r} type="button" className={`chip ${role === r ? 'active' : ''}`} onClick={() => setRole(r)}>{ROLE_LABELS[r]}</button>
          ))}
        </div>
      </div>

      <div className="field">
        Dostęp do obiektów
        <label className="check-row">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          <span>Wszystkie obiekty</span>
        </label>
        {!all && properties.map((p) => (
          <label key={p.id} className="check-row">
            <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
            <span>{p.name}</span>
          </label>
        ))}
      </div>

      {error && <div className="banner error">{error}</div>}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Zapisywanie…' : isNew ? 'Utwórz użytkownika' : 'Zapisz uprawnienia'}</button>
        <button type="button" className="btn" onClick={onCancel}>Anuluj</button>
      </div>
    </form>
  );
}

function PasswordReset({ user }: { user: AppUser }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.setUserPassword(user.id, password);
      setMsg({ ok: true, text: user.me ? 'Hasło zmienione.' : `Hasło zmienione — „${user.username}” musi zalogować się ponownie.` });
      setPassword('');
      setOpen(false);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="password-reset">
      {open ? (
        <form className="row" onSubmit={submit}>
          <input type="password" autoComplete="new-password" placeholder="Nowe hasło (min. 8 znaków)" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit" className="btn small primary">Ustaw hasło</button>
          <button type="button" className="btn small" onClick={() => setOpen(false)}>Anuluj</button>
        </form>
      ) : (
        <button type="button" className="btn small" onClick={() => { setOpen(true); setMsg(null); }}>Zmień hasło</button>
      )}
      {msg && <div className={`banner ${msg.ok ? 'info' : 'error'}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}
