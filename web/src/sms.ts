import type { SmsContext } from './types';
import { diffDays, dmy, nightsLabel } from './dates';
import { fmt } from './money';

// Pola w szablonach SMS: {imie}, {przyjazd}… — aplikacja podstawia dane rezerwacji przed wysłaniem.
export const SMS_FIELDS: [string, string][] = [
  ['imie', 'imię gościa'], ['gosc', 'imię i nazwisko'], ['obiekt', 'obiekt'], ['domek', 'domek / apartament'], ['adres', 'adres obiektu'],
  ['przyjazd', 'data przyjazdu'], ['wyjazd', 'data wyjazdu'], ['noce', 'liczba nocy'],
  ['cena', 'cena za pobyt'], ['do_zaplaty', 'pozostało do zapłaty'], ['zaliczka', 'kwota zaliczki'], ['termin_zaliczki', 'termin zaliczki'],
  ['konto', 'numer konta'], ['link_zaliczki', 'link: zapłać zaliczkę'], ['link_doplaty', 'link: zapłać resztę'],
];

/** Przykładowe dane — podgląd szablonu w ustawieniach */
export const SAMPLE: Record<string, string> = {
  imie: 'Anna', gosc: 'Anna Kowalska', obiekt: 'Apartamenty Karpatka', domek: 'Apartament 2', adres: 'ul. Myśliwska 36, Karpacz',
  przyjazd: '14/02/2027', wyjazd: '18/02/2027', noce: '4 noce', cena: '1 600 zł', do_zaplaty: '1 120 zł', zaliczka: '480 zł', termin_zaliczki: '05/02/2027',
  konto: '12 3456 7890 1234 5678 9012 3456', link_zaliczki: 'https://odmorzadogor.pl/oferta/?p=…', link_doplaty: 'https://odmorzadogor.pl/oferta/?p=…',
};

export const DEPOSIT_FIELDS = /\{(zaliczka|termin_zaliczki|link_zaliczki)\}/;

/** Wartości pól dla rezerwacji (kwota i termin zaliczki z formularza) */
export function smsValues(d: SmsContext['data'], deposit: { amount: number | null; due: string }): Record<string, string> {
  const money = (n: number | null) => (n == null ? '' : fmt(n, d.currency));
  return {
    imie: d.first_name, gosc: d.guest, obiekt: d.property, domek: d.unit, adres: d.address,
    przyjazd: dmy(d.check_in), wyjazd: dmy(d.check_out), noce: nightsLabel(diffDays(d.check_in, d.check_out)),
    cena: money(d.price), do_zaplaty: d.price == null ? '' : money(Math.max(0, d.price - d.paid)),
    zaliczka: money(deposit.amount), termin_zaliczki: deposit.due ? dmy(deposit.due) : '',
    konto: d.account, link_zaliczki: d.links.deposit, link_doplaty: d.links.balance,
  };
}

/** Podstawia pola; puste i nieznane zostają jako {pole} — widać, czego brakuje */
export const fillSms = (body: string, values: Record<string, string>) =>
  body.replace(/\{([a-z_]+)\}/g, (m, k: string) => values[k] || m);

export const missingFields = (text: string) => [...new Set([...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]))];

/** Polskie znaki → bez ogonków (SMS bez polskich znaków mieści 160 znaków zamiast 70) */
export const stripDiacritics = (s: string) => s.replace(/ł/g, 'l').replace(/Ł/g, 'L').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[–—]/g, '-').replace(/[„”“]/g, '"').replace(/[’‘]/g, "'");

// Znaki zwykłego SMS-a (GSM 7-bit); inne (np. ą, ę) zmieniają kodowanie na Unicode — 70 znaków na część
const GSM = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[\]~|€]*$/;
export function smsParts(text: string) {
  const unicode = !GSM.test(text);
  const len = [...text].length;
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return { len, unicode, parts: len === 0 ? 0 : len <= single ? 1 : Math.ceil(len / multi) };
}

/** Link sms: działający na iPhonie i Androidzie (z gotową treścią) */
export const smsHref = (phone: string, text: string) => `sms:${phone.replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(text)}`;
