// Zarządzanie kontami. Na serwerze:
//   docker compose exec api npm run -s user add <login>            (pełny dostęp)
//   docker compose exec api npm run -s user add <login> podglad    (tylko podgląd)
//   docker compose exec api npm run -s user role <login> admin|podglad
//   docker compose exec api npm run -s user passwd <login>
//   docker compose exec api npm run -s user remove <login>
//   docker compose exec api npm run -s user list
import { openDb } from './db.ts';
import { hashPassword, setPassword } from './auth.ts';

const db = openDb(process.env.DB_PATH ?? './data/kalendarz.sqlite');
const [cmd, username, roleArg] = process.argv.slice(2);

function parseRole(arg: string | undefined): 'admin' | 'viewer' {
  if (!arg || arg === 'admin') return 'admin';
  if (['podglad', 'podgląd', 'viewer'].includes(arg)) return 'viewer';
  fail(`Nieznana rola „${arg}”. Użyj: admin albo podglad.`);
}
const roleLabel = (r: string) => (r === 'viewer' ? 'tylko podgląd' : 'admin');

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    if (!stdin.isTTY) {
      // np. echo 'haslo' | ... — bez terminala czytamy jedną linię
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => (buf += d));
      stdin.on('end', () => resolve(buf.split('\n')[0]));
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '') process.exit(130); // Ctrl+C
        if (c === '' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function askNewPassword(): Promise<string> {
  const p1 = await readHidden('Hasło (min. 8 znaków): ');
  if (p1.length < 8) fail('Hasło musi mieć co najmniej 8 znaków.');
  if (process.stdin.isTTY) {
    const p2 = await readHidden('Powtórz hasło: ');
    if (p1 !== p2) fail('Hasła się różnią.');
  }
  return p1;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const findUser = (name: string) =>
  db.prepare('SELECT id, username FROM users WHERE username = ?').get(name) as { id: number; username: string } | undefined;

switch (cmd) {
  case 'add': {
    if (!username || !/^[\w.@-]{3,50}$/.test(username)) fail('Podaj login (3–50 znaków: litery, cyfry, . _ - @).');
    if (findUser(username)) fail(`Użytkownik „${username}” już istnieje. Zmiana hasła: user passwd ${username}`);
    const role = parseRole(roleArg);
    const password = await askNewPassword();
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hashPassword(password), role);
    console.log(`Utworzono użytkownika „${username}” (${roleLabel(role)}).`);
    break;
  }
  case 'passwd': {
    const user = findUser(username ?? '') ?? fail(`Nie ma użytkownika „${username}”.`);
    setPassword(db, user.id, await askNewPassword());
    console.log(`Zmieniono hasło „${user.username}” (wylogowano wszystkie jego sesje).`);
    break;
  }
  case 'role': {
    const user = findUser(username ?? '') ?? fail(`Nie ma użytkownika „${username}”.`);
    if (!roleArg) fail('Podaj rolę: admin albo podglad.');
    const role = parseRole(roleArg);
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
    console.log(`„${user.username}” ma teraz rolę: ${roleLabel(role)}.`);
    break;
  }
  case 'remove': {
    const user = findUser(username ?? '') ?? fail(`Nie ma użytkownika „${username}”.`);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    console.log(`Usunięto użytkownika „${user.username}”.`);
    break;
  }
  case 'list': {
    const rows = db.prepare('SELECT username, role, created_at FROM users ORDER BY username').all() as { username: string; role: string; created_at: string }[];
    if (!rows.length) console.log('Brak użytkowników. Dodaj: user add <login>');
    for (const r of rows) console.log(`${r.username}\t${roleLabel(r.role)}\t(utworzony ${r.created_at})`);
    break;
  }
  default:
    console.log('Użycie: user add <login> [podglad] | user role <login> admin|podglad | user passwd <login> | user remove <login> | user list');
}
db.close();
