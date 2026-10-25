// Ogłoszenia na portale: dane obiektów ze strony odmorzadogor.pl (/dane/ogloszenia.json, generowane przy budowaniu strony)
// i ustawienia portali (format zdjęć, limity znaków, czy wolno pokazać adres strony).

export type Lang = 'pl' | 'en';
export type L = { pl: string; en: string };
export type Pair = [string, string];
export type ListingPhoto = { src: string; width: number; height: number; name: string; alt: L };
export type ListingObject = {
  key: string; calendarMatch: string; name: L; kind: L; region: L; locality: string; address: string;
  sleeps: number; unitsCount: number; lead: L;
  intro: { pl: string[]; en: string[] };
  highlights: { pl: Pair; en: Pair }[];
  amenities: ({ key: string } & L)[];
  units: { count: number; sleeps: number; name: L; items: { pl: string[]; en: string[] } }[];
  distances: { pl: Pair[]; en: Pair[] };
  rating: L | null;
  path: L;
  photos: ListingPhoto[];
};
export type ListingData = { site: string; brand: string; phone: string; email: string; objects: ListingObject[] };

/** Adres strony, z której pobieramy dane i zdjęcia (lokalnie: VITE_SITE_URL=http://localhost:8080) */
export const SITE_URL = ((import.meta.env.VITE_SITE_URL as string | undefined) || 'https://odmorzadogor.pl').replace(/\/$/, '');
export const photoUrl = (p: ListingPhoto) => `${SITE_URL}${p.src}`;
/** Adres na plakacie: sama domena, bez https:// i www */
export const domainOf = (site: string) => site.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

export async function loadListingData(): Promise<ListingData> {
  const res = await fetch(`${SITE_URL}/dane/ogloszenia.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Nie udało się pobrać danych ze strony (${res.status}). Strona musi być wdrożona w najnowszej wersji.`);
  return res.json();
}

export type PortalId = 'olx' | 'facebook' | 'instagram' | 'nocowanie' | 'booking' | 'airbnb';
export type Portal = {
  id: PortalId; label: string; file: string;
  w: number; h: number; ratio: string; maxPhotos: number;
  titleMax: number; // 0 = portal nie ma tytułu
  descMax: number; // 0 = bez limitu
  poster: boolean; // czy plakat z adresem strony jest dozwolony / domyślnie włączony
  direct: boolean; // czy w opisie wolno zachęcać do rezerwacji bezpośredniej
  hashtags?: boolean;
  posterFirst?: boolean; // plakat jako pierwsze zdjęcie (domyślnie ostatnie)
  tips: string[];
};

export const PORTALS: Portal[] = [
  {
    id: 'olx', label: 'OLX', file: 'OLX', w: 1200, h: 900, ratio: '4:3', maxPhotos: 8, titleMax: 70, descMax: 9000, poster: true, direct: true,
    tips: [
      'Kategoria: Noclegi. Pierwsze zdjęcie jest okładką ogłoszenia — najlepiej najładniejsze zdjęcie obiektu.',
      'Tytuł do 70 znaków, opis co najmniej 80 znaków.',
      'Nie wpisuj adresu strony w opisie — OLX usuwa takie ogłoszenia. Adres strony jest na plakacie (ostatnie zdjęcie).',
    ],
  },
  {
    id: 'facebook', label: 'Facebook', file: 'Facebook', w: 1080, h: 1080, ratio: '1:1', maxPhotos: 10, titleMax: 100, descMax: 0, poster: true, direct: true,
    tips: [
      'Pasuje do posta na stronie, w grupach noclegowych i na Marketplace. Kwadratowe zdjęcia nie są przycinane.',
      'W grupach plakat może być pierwszym zdjęciem — przyciąga uwagę. Na Marketplace okładką daj zdjęcie obiektu.',
      'Część grup usuwa posty z linkami — dlatego adres strony jest tylko na plakacie.',
    ],
  },
  {
    id: 'instagram', label: 'Instagram', file: 'Instagram', w: 1080, h: 1350, ratio: '4:5', maxPhotos: 10, titleMax: 0, descMax: 2200, poster: true, direct: true, hashtags: true,
    tips: [
      'Karuzela do 10 zdjęć w formacie 4:5 (pionowo) — tak zajmuje najwięcej miejsca na ekranie.',
      'Opis do 2200 znaków. Linki w opisie nie są klikalne — adres strony jest na plakacie; warto dodać go też w profilu (bio).',
    ],
  },
  {
    id: 'nocowanie', label: 'Nocowanie.pl i inne', file: 'Portale-noclegowe', w: 1600, h: 1067, ratio: '3:2', maxPhotos: 20, titleMax: 80, descMax: 0, poster: true, direct: true,
    tips: [
      'Pasuje do nocowanie.pl, e-turysta.pl, noclegowo.pl, meteor-turystyka.pl i podobnych portali.',
      'Zdjęcia poziome 3:2. Jeśli portal ma osobne pole na stronę www — wpisz tam adres, w opisie go nie podawaj.',
    ],
  },
  {
    id: 'booking', label: 'Booking.com', file: 'Booking', w: 2048, h: 1365, ratio: '3:2', maxPhotos: 30, titleMax: 0, descMax: 0, poster: false, direct: false,
    tips: [
      'Zdjęcia dodajesz w Extranecie: Obiekt → Zdjęcia. Poziome 3:2, im większe, tym lepiej.',
      'Booking.com nie pozwala kierować gości do własnej strony — także przez napisy na zdjęciach (grozi ukryciem oferty). Dlatego plakat i zdanie o rezerwacji bezpośredniej są wyłączone.',
      'Opis: Extranet → Obiekt → Opis obiektu.',
    ],
  },
  {
    id: 'airbnb', label: 'Airbnb', file: 'Airbnb', w: 2048, h: 1365, ratio: '3:2', maxPhotos: 30, titleMax: 50, descMax: 500, poster: false, direct: false,
    tips: [
      'Tytuł do 50 znaków, opis główny do 500 znaków (więcej szczegółów w sekcjach „Miejsce” i „Dostęp gości”).',
      'Airbnb zakazuje linków i kontaktu poza platformą — także na zdjęciach. Dlatego plakat i zdanie o rezerwacji bezpośredniej są wyłączone.',
    ],
  },
];
