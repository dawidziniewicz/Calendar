# Kalendarz Od Morza Do Gór

Prywatna aplikacja do zarządzania rezerwacjami domków i apartamentów z [odmorzadogor.pl](https://odmorzadogor.pl):
Osada Jantar (5 domków), Apartament Sopot, Apartamenty Karpatka (2), Agroturystyka Karszewo (2).

- **Kalendarz** – oś czasu wszystkich domków; stuknięcie w wolny dzień tworzy rezerwację, w pasek otwiera ją.
- **Aktualności** – kto dziś jest w obiektach, kto przyjeżdża i wyjeżdża (po 14 dni, przycisk „Załaduj więcej”), wyszukiwarka, dzwonienie jednym dotknięciem.
- **Obiekty** – edycja domków, podłączenie kalendarzy Booking.com / Airbnb i adresy eksportu.
- Ostrzeżenie o nakładających się terminach, podpowiedzi stałych gości, cena i wpłaty, notatki.
- Instalowana na iPhonie jak zwykła aplikacja (PWA), działa też w przeglądarce na komputerze.

## Jak to działa

```
 iPhone / komputer
        │  https://kalendarz.odmorzadogor.pl   (logowanie: login + hasło)
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

## Krok 3. Konta użytkowników

Logowanie jest w samej aplikacji: **login + hasło**. Konta zakładasz na serwerze (nie ma rejestracji z internetu):

```bash
cd ~/kalendarz
docker compose exec api npm run -s user add dawid        # zapyta o hasło (min. 8 znaków)
docker compose exec api npm run -s user add jozek
docker compose exec api npm run -s user add jan podglad  # konto TYLKO DO PODGLĄDU
docker compose exec api npm run -s user role jan admin    # zmiana roli: admin / podglad
docker compose exec api npm run -s user list             # lista kont
docker compose exec api npm run -s user passwd jozek     # nowe hasło (wylogowuje z urządzeń)
docker compose exec api npm run -s user remove jozek     # usunięcie konta
```

- Konto **podglad** widzi kalendarz, przyjazdy i szczegóły rezerwacji (może dzwonić do gości), ale nie może niczego dodać, zmienić ani usunąć – blokuje to serwer. Nie widzi też prywatnych linków do kalendarzy Bookingu.
- Sesja trwa 90 dni – na telefonie logujesz się raz.
- Po 5 błędnych hasłach logowanie z danego adresu IP / na dany login jest blokowane na 15 minut.
- Hasło możesz też zmienić w aplikacji: *Obiekty* → na dole *Zmień hasło*.

### Ochrona API w domu (token serwisowy Cloudflare Access)

Adres `kalendarz-api.odmorzadogor.pl` ma odpowiadać tylko funkcji z Cloudflare Pages:

1. Zero Trust → *Access* → **Service auth** → *Service Tokens* → *Create* → nazwa `pages-proxy`, czas: *Non-expiring*.
2. Zapisz **Client ID** i **Client Secret** (secret pokazuje się tylko raz).
3. *Access* → **Applications** → *Add an application* → **Self-hosted**:
   - nazwa `Kalendarz API`, domena: `kalendarz-api.odmorzadogor.pl`
   - Policy: nazwa `proxy`, **Action: Service Auth**, Include → *Service Token* → `pages-proxy`.

Dla samej aplikacji (`kalendarz.odmorzadogor.pl`) **nie twórz** aplikacji Access – logowanie robi aplikacja.

## Krok 4. Cloudflare Pages

1. **Projekt**: z Maca `npx wrangler login`, potem `npx wrangler pages project create kalendarz --production-branch=main`.
   Zapisz adres, który zwróci (np. `kalendarz-abc.pages.dev`).
2. **Własna domena**: *Workers & Pages* → `kalendarz` → *Custom domains* → `kalendarz.odmorzadogor.pl`.
3. **Zmienne**: projekt → *Settings* → *Variables and Secrets* (dla **Production**):

   | Nazwa | Wartość | Typ |
   |---|---|---|
   | `API_ORIGIN` | `https://kalendarz-api.odmorzadogor.pl` | Text |
   | `API_KEY` | to samo co `API_KEY` w `.env` na serwerze | Secret |
   | `CF_ACCESS_CLIENT_ID` | Client ID z kroku 3 | Secret |
   | `CF_ACCESS_CLIENT_SECRET` | Client Secret z kroku 3 | Secret |

   Zmienne działają od następnego wdrożenia.

## Krok 5. Automatyczne wdrażanie (GitHub Actions)

1. Cloudflare → *My Profile* → **API Tokens** → *Create Token* → *Custom token*: **Account → Cloudflare Pages → Edit**.
2. **Account ID**: ciąg w adresie `dash.cloudflare.com/<account-id>/...`.
3. GitHub → repozytorium → *Settings* → *Secrets and variables* → *Actions*:
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - (opcjonalnie) Variables: `CF_PAGES_PROJECT` – jeśli projekt nie nazywa się `kalendarz`.

| Zmiana w | Gałąź `main` | Gałąź `dev` |
|---|---|---|
| `web/` | produkcja: `kalendarz.odmorzadogor.pl` | podgląd: `dev.<projekt>.pages.dev` |
| `server/` | testy → obraz `ghcr.io/…/calendar-server:latest` → serwer pobiera go w ≤10 min (cron) | tylko testy |

Ręczne uruchomienie: *Actions* → wybierz workflow → **Run workflow** → `main`.

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

1. Otwórz **Safari** → `https://kalendarz.odmorzadogor.pl` → zaloguj się loginem i hasłem.
2. Przycisk **Udostępnij** (kwadrat ze strzałką) → **Do ekranu początkowego** → *Dodaj*.
3. Ikona „Kalendarz” działa jak aplikacja – na pełnym ekranie, bez paska adresu.

Na Androidzie: Chrome → menu ⋮ → *Zainstaluj aplikację*. Na komputerze: Chrome/Edge → ikona instalacji w pasku adresu.

---

## Powiadomienia o przyjazdach

Codziennie o wybranej godzinie (domyślnie **9:00**, czas polski) serwer wysyła osobne powiadomienie o każdym dzisiejszym przyjeździe (domek, gość, liczba osób, długość pobytu). Stuknięcie otwiera tę rezerwację.

1. iPhone (iOS 16.4+): aplikacja musi być dodana do ekranu początkowego i otwarta z ikony.
2. *Ustawienia i obiekty* (lub *Konto*) → **Powiadomienia** → **Włącz powiadomienia** → *Zezwól*.
3. **Wyślij test** – sprawdza, czy powiadomienie dochodzi.

**Zmiany w rezerwacjach** (przełącznik w tym samym panelu, domyślnie włączony):
- gdy ktoś doda, zmieni lub usunie rezerwację — powiadomienie dostają **pozostali** użytkownicy (z opisem, co zmieniono i kto),
- nowa rezerwacja, zmiana terminu, odwołanie lub przywrócenie na Booking.com — dostają wszyscy,
- pierwsze pobranie nowo podłączonego kalendarza nie wysyła powiadomień; więcej niż 5 zmian naraz → jedno zbiorcze.

Każda osoba włącza je na swoim telefonie i sama ustawia godzinę w tym samym panelu (**Godzina powiadomienia** → *Zapisz godzinę*).
Klucze do powiadomień serwer generuje sam przy pierwszym uruchomieniu (zapisane w bazie).

---

## Praca lokalna (programowanie)

Wymagany Node.js 24+.

```bash
# API
cd server && npm install
cp .env.example .env            # ustaw API_KEY (min. 16 znaków)
npm run dev                     # http://localhost:8787
npm run user add dawid          # konto do logowania lokalnie
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
| „Brak autoryzacji serwera” | `API_KEY` identyczny w Pages i `.env` + nowe wdrożenie |
| „Serwer zwrócił nieoczekiwaną odpowiedź” | `CF_ACCESS_CLIENT_ID/SECRET` w Pages; service token przypisany do aplikacji `Kalendarz API` |
| Nie pamiętam hasła | `docker compose exec api npm run -s user passwd <login>` |
| Booking nie widzi eksportu | czy link otwiera się w oknie incognito; czy dla `kalendarz.odmorzadogor.pl` nie ma aplikacji Access |
| Błąd synchronizacji przy domku | czerwona plakietka w *Obiekty* – rozwiń domek, zobacz komunikat; sprawdź, czy link Bookingu jest aktualny |
