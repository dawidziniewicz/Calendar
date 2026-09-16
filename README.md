# Kalendarz Od Morza Do Gór

Prywatna aplikacja do zarządzania rezerwacjami domków i apartamentów z [odmorzadogor.pl](https://odmorzadogor.pl):
Osada Jantar (5 domków), Apartament Sopot, Apartamenty Karpatka (2), Agroturystyka Karszewo (2).

- **Kalendarz** – oś czasu wszystkich domków; stuknięcie w wolny dzień tworzy rezerwację, w pasek otwiera ją.
- **Przyjazdy** – kto dziś jest w obiektach, kto przyjeżdża i wyjeżdża przez 14 dni, wyszukiwarka, dzwonienie jednym dotknięciem.
- **Obiekty** – edycja domków, podłączenie kalendarzy Booking.com / Airbnb i adresy eksportu.
- Ostrzeżenie o nakładających się terminach, podpowiedzi stałych gości, cena i wpłaty, notatki.
- Instalowana na iPhonie jak zwykła aplikacja (PWA), działa też w przeglądarce na komputerze.

## Jak to działa

```
 iPhone / komputer
        │  https://kalendarz.odmorzadogor.pl   (logowanie: Cloudflare Access, kod PIN na e-mail)
        ▼
 Cloudflare Pages ── interfejs (React) + funkcja /api (proxy)
        │  https://kalendarz-api.odmorzadogor.pl   (dostęp tylko z tokenem serwisowym)
        ▼
 Cloudflare Tunnel  (bez otwierania portów na routerze)
        ▼
 Serwer w domu: Docker ── api (Node.js + SQLite) ── co 15 min pobiera iCal z Booking.com
```

| Katalog | Zawartość |
|---|---|
| `web/` | aplikacja (React + Vite), `functions/` – funkcje Cloudflare Pages (proxy do API) |
| `server/` | API (Node 24, Hono, SQLite), `docker-compose.yml`, `Dockerfile` |
| `.github/workflows/` | `web.yml` – deploy na Cloudflare Pages, `server.yml` – testy i obraz Docker |

Poniżej używam przykładowych adresów `kalendarz.odmorzadogor.pl` (aplikacja) i `kalendarz-api.odmorzadogor.pl` (API) – możesz wybrać inne.

---

## Krok 0. Czego potrzebujesz

1. **Konto Cloudflare** (darmowe) z dodaną domeną `odmorzadogor.pl`.
   Jeśli DNS domeny jest teraz u hostingodawcy: Cloudflare → *Add a domain* → skopiuje istniejące rekordy → zmieniasz serwery nazw (NS) u rejestratora domeny. Strona www działa dalej bez zmian. Bez domeny w Cloudflare nie da się zrobić tunelu z własnym adresem.
2. **Serwer w domu** z Linuksem (Ubuntu/Debian, Raspberry Pi OS też działa – obraz jest budowany na amd64 i arm64), włączony 24/7.
3. **Repozytorium na GitHubie** – ten kod wypchnięty do `github.com/dawidziniewicz/Calendar`.

---

## Krok 1. Tunel Cloudflare (połączenie domu z internetem)

1. Cloudflare → **Zero Trust** → *Networks* → **Tunnels** → *Create a tunnel* → typ **Cloudflared** → nazwa np. `dom`.
2. Na ekranie instalacji wybierz **Docker** i skopiuj sam token (długi ciąg po `--token`). Przyda się w kroku 2.
3. Zakładka **Public Hostname** → *Add a public hostname*:
   - Subdomain: `kalendarz-api`, Domain: `odmorzadogor.pl`
   - Service: **HTTP**, URL: `api:8787`
4. Zapisz.

## Krok 2. Serwer domowy

```bash
# 1) Docker (jeśli jeszcze nie ma)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # wyloguj się i zaloguj ponownie

# 2) Katalog aplikacji
mkdir -p ~/kalendarz/data && cd ~/kalendarz
sudo chown 1000:1000 data        # kontener działa jako użytkownik "node" (uid 1000)
```

Skopiuj na serwer pliki `server/docker-compose.yml` i `server/.env.example` (np. `scp` albo `git clone` repozytorium), a potem:

```bash
cd ~/kalendarz
cp .env.example .env
openssl rand -hex 32             # wynik wklej jako API_KEY w .env
nano .env                        # uzupełnij API_KEY i TUNNEL_TOKEN (z kroku 1)
```

**Dostęp do obrazu Docker.** Obraz budowany przez GitHub Actions trafia do `ghcr.io/dawidziniewicz/calendar-server`. Jeśli repozytorium jest prywatne:
GitHub → *Settings* → *Developer settings* → *Personal access tokens (classic)* → nowy token z uprawnieniem **read:packages**, a na serwerze:

```bash
docker login ghcr.io -u dawidziniewicz   # jako hasło wklej token
```

Obraz pojawi się po pierwszym pushu na `main` (krok 5). Uruchomienie:

```bash
docker compose up -d
docker compose logs -f api       # powinno być: "API działa na porcie 8787"
```

> Bez GHCR: sklonuj całe repo na serwer, w `docker-compose.yml` zakomentuj `image:`, odkomentuj `build: .` i uruchom `docker compose up -d --build` w katalogu `server/`.

**Automatyczne aktualizacje API** – dodaj do `crontab -e`:

```
*/10 * * * * cd ~/kalendarz && docker compose pull -q api && docker compose up -d api >/dev/null 2>&1
```

**Kopie zapasowe** – serwer codziennie zapisuje kopię bazy do `~/kalendarz/data/backups/` (30 ostatnich dni). Warto raz na jakiś czas skopiować ten katalog poza dom (dysk w chmurze, pendrive).

## Krok 3. Zabezpieczenia (Cloudflare Access)

Cała aplikacja jest tylko dla Ciebie. Logowanie robi Cloudflare Access – podajesz e-mail, dostajesz kod PIN (darmowe do 50 użytkowników).

### 3a. Token dla proxy → API

1. Zero Trust → *Access controls* → **Service credentials** → *Service Tokens* → *Create* → nazwa `pages-proxy`, czas: *Non-expiring*.
2. Zapisz **Client ID** i **Client Secret** (secret pokazuje się tylko raz).
3. *Access controls* → **Applications** → *Add an application* → **Self-hosted**:
   - nazwa `Kalendarz API`, domena: `kalendarz-api.odmorzadogor.pl`
   - Policy: nazwa `proxy`, **Action: Service Auth**, Include → *Service Token* → `pages-proxy`.

Od teraz API w domu jest osiągalne tylko przez funkcję w Cloudflare Pages (dodatkowo sprawdza jeszcze `API_KEY`).

### 3b. Logowanie do aplikacji

1. Zero Trust → *Settings* → *Authentication* → upewnij się, że jest **One-time PIN**.
2. *Applications* → *Add an application* → **Self-hosted**:
   - nazwa `Kalendarz`, **Session duration: 1 month** (żeby nie logować się co chwilę na telefonie)
   - domeny (dodaj trzy): `kalendarz.odmorzadogor.pl`, `kalendarz.pages.dev`, `*.kalendarz.pages.dev`
   - Policy: `admin`, **Action: Allow**, Include → *Emails* → `dawidziniewicz@gmail.com`
3. Po zapisaniu otwórz aplikację i skopiuj **Application Audience (AUD) Tag** → to będzie `ACCESS_AUD`.
   Adres zespołu (*Settings* → *Custom Pages* / *Team domain*), np. `mojzespol.cloudflareaccess.com` → `ACCESS_TEAM_DOMAIN`.
4. **Wyjątek dla Bookingu** – Booking musi pobierać eksport kalendarza bez logowania. Dodaj jeszcze jedną aplikację *Self-hosted*:
   - nazwa `Kalendarz iCal`, domena `kalendarz.odmorzadogor.pl`, **Path: `ical`**
   - Policy: **Action: Bypass**, Include → *Everyone*.
   Adresy eksportu zawierają 48-znakowy losowy token, więc nie da się ich zgadnąć.

## Krok 4. Cloudflare Pages

1. **Projekt**: Cloudflare → *Workers & Pages* → *Create* → *Pages* → **Upload assets** (nie „Connect to Git” – wdrażać będzie GitHub Actions) → nazwa projektu **`kalendarz`** → wgraj dowolny plik, żeby utworzyć projekt.
   (Albo z terminala: `npx wrangler pages project create kalendarz --production-branch=main`.)
2. **Własna domena**: projekt → *Custom domains* → `kalendarz.odmorzadogor.pl`.
3. **Zmienne**: projekt → *Settings* → *Variables and Secrets* → dodaj dla **Production** i **Preview** (typ *Secret* dla kluczy):

   | Nazwa | Wartość |
   |---|---|
   | `API_ORIGIN` | `https://kalendarz-api.odmorzadogor.pl` |
   | `API_KEY` | to samo co `API_KEY` w `.env` na serwerze |
   | `CF_ACCESS_CLIENT_ID` | Client ID z kroku 3a |
   | `CF_ACCESS_CLIENT_SECRET` | Client Secret z kroku 3a |
   | `ACCESS_TEAM_DOMAIN` | np. `mojzespol.cloudflareaccess.com` |
   | `ACCESS_AUD` | AUD Tag z kroku 3b |

   Zmienne działają od następnego wdrożenia.

## Krok 5. Automatyczne wdrażanie (GitHub Actions)

1. Cloudflare → ikona profilu → *My Profile* → **API Tokens** → *Create Token* → *Custom token*:
   uprawnienie **Account → Cloudflare Pages → Edit**. Skopiuj token.
2. **Account ID**: Cloudflare → *Workers & Pages* → prawa kolumna *Account ID*.
3. GitHub → repozytorium → *Settings* → *Secrets and variables* → *Actions*:
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - (opcjonalnie) Variables: `CF_PAGES_PROJECT` – jeśli projekt nie nazywa się `kalendarz`.

Co się dzieje po `git push`:

| Zmiana w | Gałąź `main` | Gałąź `dev` |
|---|---|---|
| `web/` | produkcja: `kalendarz.odmorzadogor.pl` | podgląd: `dev.kalendarz.pages.dev` |
| `server/` | testy → obraz `ghcr.io/…/calendar-server:latest` → serwer pobiera go w ≤10 min (cron) | tylko testy |

## Krok 6. Booking.com

Booking.com **nie udostępnia API** małym obiektom (API mają tylko certyfikowani partnerzy – channel managery). Jedyna oficjalna droga dla nas to **synchronizacja kalendarzy iCal**, która przekazuje **tylko zajęte terminy** – bez nazwiska i telefonu gościa. Dlatego:
rezerwacja z Bookingu pojawia się w aplikacji automatycznie jako niebieski pasek „Booking.com”, a Ty stukasz w nią i dopisujesz dane gościa z extranetu. Przy kolejnych synchronizacjach te dane zostają, a zmiana terminu lub anulowanie w Bookingu aktualizuje wpis.

### Import: Booking → aplikacja
1. Extranet Booking.com → **Stawki i dostępność** → **Synchronizacja kalendarzy** (Sync calendars).
2. Przy danym typie pokoju/domku → **Eksportuj kalendarz** → skopiuj link (`https://ical.booking.com/v1/export?t=…`).
3. Aplikacja → **Obiekty** → rozwiń domek → *Import z Booking.com* → wklej → **Dodaj** → **Synchronizuj teraz**.

### Eksport: aplikacja → Booking (żeby Booking nie sprzedał terminu zajętego bezpośrednio)
1. Aplikacja → **Obiekty** → domek → **Kopiuj dla Booking**.
2. Extranet → *Synchronizacja kalendarzy* → **Importuj kalendarz** → wklej, nazwij np. „Kalendarz własny”.

To samo możesz zrobić z Airbnb („Kopiuj dla Airbnb” oraz import linku iCal z Airbnb).

**Ważne:**
- Booking pobiera importowane kalendarze **co kilka godzin** (nie zależy to od nas). Rezerwacja telefoniczna wpisana do aplikacji zablokuje termin w Bookingu z opóźnieniem – przy rezerwacji „na już” zamknij też termin ręcznie w extranecie.
- Synchronizacja iCal w Bookingu działa na poziomie **typu pokoju**. Jeśli np. 3 „Małe domki” w Jantarze są na Bookingu jednym typem z liczbą sztuk 3, Booking może nie pozwolić na synchronizację lub pokazywać tylko dni, gdy wszystkie są zajęte. Wtedy najlepiej rozdzielić je na osobne typy/oferty.
- Pełne dane gości automatycznie (nazwisko, telefon, cena) wymagają **channel managera** z API (np. Hotres, Smoobu, Beds24). Aplikację można później pod taki system podłączyć.

## Krok 7. Instalacja na iPhonie

1. Otwórz **Safari** → `https://kalendarz.odmorzadogor.pl` → wpisz e-mail → wpisz kod PIN z maila.
2. Przycisk **Udostępnij** (kwadrat ze strzałką) → **Do ekranu początkowego** → *Dodaj*.
3. Ikona „Kalendarz” działa jak aplikacja – na pełnym ekranie, bez paska adresu.

Na Androidzie: Chrome → menu ⋮ → *Zainstaluj aplikację*. Na komputerze: Chrome/Edge → ikona instalacji w pasku adresu.

---

## Praca lokalna (programowanie)

Wymagany Node.js 24+.

```bash
# API
cd server && npm install
cp .env.example .env            # ustaw API_KEY (min. 16 znaków)
npm run dev                     # http://localhost:8787
npm test

# Aplikacja (drugi terminal)
cd web && npm install
cp .env.local.example .env.local  # DEV_API_KEY = API_KEY z server/.env
npm run dev                     # http://localhost:5173
```

Przy pierwszym uruchomieniu baza tworzy się sama z listą obiektów z odmorzadogor.pl (można je zmieniać w zakładce *Obiekty*).

## Rozwiązywanie problemów

| Objaw | Co sprawdzić |
|---|---|
| „Serwer domowy nie odpowiada” | `docker compose ps`, `docker compose logs api cloudflared`; w Zero Trust → Tunnels status *Healthy* |
| „Brak konfiguracji ACCESS_…” | zmienne w Pages (krok 4) + nowe wdrożenie (*Actions* → *Web* → *Run workflow*) |
| 401 / 403 w `/api` | `API_KEY` identyczny w Pages i `.env`; service token przypisany do aplikacji `Kalendarz API` |
| Booking nie widzi eksportu | aplikacja *Bypass* dla ścieżki `ical` (krok 3b.4); link otwiera się w oknie incognito? |
| Błąd synchronizacji przy domku | czerwona plakietka w *Obiekty* – rozwiń domek, zobacz komunikat; sprawdź, czy link Bookingu jest aktualny |
