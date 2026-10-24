# Kalendarz Od Morza Do Gór

Prywatna aplikacja do zarządzania rezerwacjami domków i apartamentów z [odmorzadogor.pl](https://odmorzadogor.pl):
Osada Jantar (5 domków), Apartament Sopot, Apartamenty Karpatka (2), Agroturystyka Karszewo (2).

- **Kalendarz** – oś czasu wszystkich domków; stuknięcie w wolny dzień tworzy rezerwację, w pasek otwiera ją.
- **Aktualności** – kto dziś jest w obiektach, kto przyjeżdża i wyjeżdża (po 14 dni, przycisk „Załaduj więcej”), wyszukiwarka, dzwonienie jednym dotknięciem.
- **Zapytania** – rezerwacje wysłane przyciskiem „Zarezerwuj” na odmorzadogor.pl: **Akceptuj** (rezerwacja trafia do kalendarza, gość dostaje e-mail z potwierdzeniem) albo **Odrzuć** (gość dostaje e-mail z odmową).
- **Ceny** – *Ustawienia → Cennik* (cena podstawowa, ceny wg dnia tygodnia, ceny na wybrane dni, opcje płatne, horyzont rezerwacji) oraz przycisk *Ceny* w kalendarzu — goście od razu widzą zmiany na stronie.
- **Obiekty** – edycja domków, cena podstawowa i widoczność na stronie, podłączenie kalendarzy Booking.com / Airbnb i adresy eksportu.
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

Logowanie jest w samej aplikacji: **login + hasło**. Nie ma rejestracji z internetu.

**W aplikacji** (admin bez ograniczeń, np. `dawid`): *Ustawienia i obiekty* → **Użytkownicy i uprawnienia** – dodawanie kont, rola (*Admin – pełna edycja* / *Obsługa – tylko podgląd*), dostęp do wybranych obiektów, zmiana hasła, usuwanie. Własnych uprawnień nie da się zmienić ani usunąć swojego konta (ochrona przed zablokowaniem się).

**Pierwsze konto** (i awaryjnie) zakładasz na serwerze:

```bash
cd ~/kalendarz
docker compose exec api npm run -s user add dawid        # zapyta o hasło (min. 8 znaków)
docker compose exec api npm run -s user add jozek
docker compose exec api npm run -s user add jan podglad  # konto TYLKO DO PODGLĄDU
docker compose exec api npm run -s user role jan admin    # zmiana roli: admin / podglad
docker compose exec api npm run -s user obiekty jantar "Osada Jantar"   # dostęp tylko do wybranych obiektów
docker compose exec api npm run -s user obiekty jantar wszystkie        # zdjęcie ograniczenia
docker compose exec api npm run -s user list             # lista kont
docker compose exec api npm run -s user passwd jozek     # nowe hasło (wylogowuje z urządzeń)
docker compose exec api npm run -s user remove jozek     # usunięcie konta
```

- Konto **podglad** widzi kalendarz, przyjazdy i szczegóły rezerwacji (może dzwonić do gości), ale nie może niczego dodać, zmienić ani usunąć – blokuje to serwer. Nie widzi też prywatnych linków do kalendarzy Bookingu.
- Konto z ograniczeniem **obiekty** widzi i obsługuje tylko wskazane obiekty (kalendarz, Aktualności, rezerwacje, powiadomienia). Nie może zmieniać ustawień obiektów, domków ani linków Bookingu. Można to łączyć z rolą *podglad*.
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

W aplikacji: *Ustawienia* → **Aplikacja na telefonie** – na Androidzie (Chrome) przycisk **Zainstaluj aplikację**, na iPhonie instrukcja krok po kroku (Apple nie pozwala instalować przyciskiem). Panel znika, gdy aplikacja jest otwarta z ikony.

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

## Strona www: ceny i rezerwacje online

Strona [odmorzadogor.pl](https://github.com/dawidziniewicz/osadajantar) pobiera z kalendarza ceny i wolne terminy, a zapytania o rezerwację wysyła tutaj.

```
 odmorzadogor.pl (przeglądarka gościa)
        │  https://kalendarz.odmorzadogor.pl/public/…   (funkcja web/functions/public — bez logowania, tylko ceny i zajęte dni)
        ▼
 Cloudflare Pages (proxy z API_KEY + token Access) ──▶ tunel ──▶ serwer w domu
```

- Publiczne API zwraca **wyłącznie** ceny, minimalny pobyt i zajęte dni — żadnych danych gości. Zapytania chroni pole-pułapka na boty i limit (5 na godzinę z jednego adresu IP, 60 łącznie).
- Dozwolone domeny strony (CORS): `odmorzadogor.pl`, `www.odmorzadogor.pl`, `new.odmorzadogor.pl`, podglądy `*.osadajantar.pages.dev`. Inne dodasz zmienną `PUBLIC_ORIGINS` w Cloudflare Pages (lista po przecinku).
- **Cennik** (*Ustawienia → Cennik i rezerwacje online*):
  - cena podstawowa za noc, minimalny pobyt i widoczność każdego domku na stronie,
  - **ceny wg dnia tygodnia** — np. 300 zł w tygodniu i 600 zł w piątek i sobotę (przycisk *Ustaw weekend*),
  - **ceny na wybrane dni** (święta, sezon) z listą i usuwaniem; to samo w *Kalendarz → Ceny* (zaznaczasz zakres na osi czasu),
  - **do kiedy** strona pokazuje ceny i przyjmuje zapytania — konkretna data (np. koniec wakacji) albo stała liczba dni do przodu (domyślnie 365),
  - **opcje płatne** — parking, zwierzę, łóżeczko… z ceną za pobyt albo za noc, ilością i wyborem obiektów; gość zaznacza je w formularzu, a cena dolicza się do wyceny.
  - Kolejność ceny nocy: cena na konkretny dzień → cena dnia tygodnia → cena podstawowa.
  - **Typ domku** (np. „Mały domek”): przypisujesz go z listy w panelu *Typy domków* (bez wpisywania — bez literówek). Domki tego samego typu strona pokazuje jako jedną opcję („3 × Mały domek”); termin jest wolny, jeśli którykolwiek z nich jest wolny przez cały pobyt. **Cennik typu jest wspólny** — cena podstawowa, dni tygodnia i ceny na wybrane dni zawsze zmieniają się dla wszystkich jego domków (osobno się nie da). Domek dołączający do typu przejmuje jego ceny.
  - **Przydział domku**: zapytanie przychodzi z proponowanym wolnym domkiem; przy akceptacji wybierasz domek z listy (wolny / zajęty) albo zostawiasz automatyczny wybór. W trybie „Zawsze wybieram ręcznie” bez wyboru nie da się zaakceptować.
  - **Obiekt zamknięty**: do odwołania (strona pokazuje komunikat zamiast kalendarza) albo w terminie (dni niedostępne, komunikat nad kalendarzem); na osi czasu w aplikacji dni są zakreskowane.
- **Zapytanie** od gościa: powiadomienie push („Zapytania ze strony www” w *Powiadomieniach*), e-mail na adresy z *Ustawienia → Powiadomienia e-mail*, a gość dostaje e-mail „Otrzymaliśmy Twoje zapytanie”. Zapytania ze strony angielskiej dostają e-maile po angielsku.
- **Anulacja przez gościa**: e-mail z potwierdzeniem ma link „Poproś o anulację” (`odmorzadogor.pl/anulacja/?t=…`, unikalny kod). Gość podaje powód, Ty dostajesz push i e-mail, a w *Zapytania* pojawia się „Prośby o anulację”: **Potwierdź anulację** (rezerwacja anulowana, termin wolny, e-mail do gościa) albo **Odrzuć prośbę** (rezerwacja zostaje, e-mail z Twoją wiadomością).
- **Akceptacja** tworzy rezerwację „Strona www” (można poprawić cenę i dopisać informację dla gościa, np. o zaliczce). Gdy termin w międzyczasie się zajął, aplikacja ostrzeże.

## Płatności, oferty, wiadomości i rachunki

*Ustawienia → Płatności i rachunki*: numer konta, odbiorca, bank, domyślna zaliczka (% ceny), ile dni na wpłatę, ile dni oferta jest ważna, warunki rezerwacji (PL/EN), szablon rachunku i lista wystawionych rachunków. Wszystkie pola są opcjonalne.

- **Oferta cenowa** — w *Zapytania* przycisk **Zaproponuj cenę** (albo korekta ceny z cennika), a w każdej rezerwacji **Oferta do akceptacji** (np. po rozmowie telefonicznej). Cena, zaliczka z terminem, ważność oferty, wiadomość. Gość dostaje e-mail z przyciskiem *Zobacz ofertę i zaakceptuj* → strona `odmorzadogor.pl/oferta/?t=…` (`/en/offer/` po angielsku), gdzie zaznacza „Akceptuję cenę … i zobowiązuję się do zapłaty (oraz wpłaty zaliczki …)” i klika **Akceptuję i rezerwuję**. Zapisujemy datę, godzinę i adres IP akceptacji (w notatkach rezerwacji). Zapytanie od razu staje się rezerwacją w kalendarzu (wolny domek z typu), gość dostaje potwierdzenie z danymi do przelewu, a Ty push i e-mail. Gość może też ofertę odrzucić (z powodem). Link można wysłać SMS-em / WhatsAppem (gdy gość nie ma e-maila).
- **Wiadomości do gościa** z każdej rezerwacji (także z Bookingu czy telefonicznych, jeśli jest e-mail): prośba o zaliczkę (kwota, termin, numer konta, tytuł przelewu), prośba o dopłatę, potwierdzenie wpłaty, potwierdzenie rezerwacji, dowolna wiadomość. Treść można edytować, jest podgląd e-maila, wszystko trafia do historii rezerwacji. Język e-maili ustawiasz w rezerwacji (PL/EN).
- **Zaliczka** w rezerwacji: kwota i termin, status „wpłacona ✓ / minął termin”, przycisk *Klient wpłacił zaliczkę*.
- **Rachunki** (PDF A4, czcionki strony, kwota słownie): z rezerwacji przycisk *Wystaw rachunek* — nabywca, pozycje, płatność wpisują się same. Edycja z podglądem PDF na żywo (na komputerze obok formularza, na telefonie w zakładce). Wystawca, miejsce, sposób płatności, dopisek (np. zwolnienie z VAT) i stopka zapamiętują się jako szablon. Numeracja roczna (1/2026) albo miesięczna (1/10/2026). Gotowy rachunek: pobierz, udostępnij / wydrukuj, wyślij gościowi e-mailem z PDF w załączniku.

### E-maile (do ustawienia w `.env` na serwerze w domu)

Bez tej konfiguracji wszystko działa, tylko bez e-maili (zostają powiadomienia push).

| Zmienna | Przykład | Opis |
|---|---|---|
| `ADMIN_EMAIL` | `kontakt@odmorzadogor.pl` | dokąd wysyłać powiadomienia o zapytaniach (potem można zmienić w aplikacji) |
| `MAIL_FROM` | `Od Morza do Gór <rezerwacje@odmorzadogor.pl>` | nadawca e-maili do gości |
| `RESEND_API_KEY` | `re_…` | **wariant A (zalecany):** [resend.com](https://resend.com) → *Domains* → dodaj `odmorzadogor.pl` (rekordy DNS dodajesz w Cloudflare) → *API Keys* |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | `poczta.example.pl`, `465`, `kontakt@odmorzadogor.pl`, hasło | **wariant B:** istniejąca skrzynka pocztowa (używane, gdy `RESEND_API_KEY` jest pusty) |
| `APP_URL` | `https://kalendarz.odmorzadogor.pl` | link „Otwórz w kalendarzu” w e-mailu |
| `SITE_URL` | `https://new.odmorzadogor.pl` → potem `https://odmorzadogor.pl` | link do strony w e-mailach do gości |

Lokalnie (programowanie) `MAIL_LOG=1` zapisuje e-maile do `data/mail-outbox/` zamiast je wysyłać.

Po zmianie `.env`: `docker compose up -d` (restart kontenera). Test: *Ustawienia → Powiadomienia e-mail → Wyślij test*. W logach serwera przy starcie: `E-maile: resend, nadawca …`.

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
