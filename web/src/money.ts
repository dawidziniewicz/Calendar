// Waluty: rezerwacje, oferty i rachunki mogą być w PLN, EUR, GBP… (ceny na stronie www zawsze w PLN)
export const CURRENCIES = ['PLN', 'EUR', 'GBP', 'USD', 'CHF', 'CZK', 'NOK', 'SEK', 'DKK'] as const;
export const CURRENCY_LABELS: Record<string, string> = {
  PLN: 'zł — złoty (PLN)', EUR: '€ — euro (EUR)', GBP: '£ — funt (GBP)', USD: '$ — dolar (USD)', CHF: 'CHF — frank szwajcarski',
  CZK: 'Kč — korona czeska (CZK)', NOK: 'kr — korona norweska (NOK)', SEK: 'kr — korona szwedzka (SEK)', DKK: 'kr — korona duńska (DKK)',
};
/** Symbol do etykiet pól („Cena (€)”) */
export const currencySymbol = (c = 'PLN') => ({ PLN: 'zł', EUR: '€', GBP: '£', USD: '$' } as Record<string, string>)[c] ?? c;

/** 1200 zł · 1 200 € · 85,50 £ (z groszami tylko gdy są) */
export function fmt(n: number, currency = 'PLN', alwaysCents = false) {
  const cents = alwaysCents || Math.round(n * 100) % 100 !== 0;
  if (!currency || currency === 'PLN') return `${n.toLocaleString('pl-PL', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })} zł`;
  return new Intl.NumberFormat('pl-PL', { style: 'currency', currency, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 }).format(n);
}

// Języki strony www / gościa (e-maile: po polsku albo po angielsku; linki do strony w języku gościa)
export type GuestLang = 'pl' | 'en' | 'cs' | 'de' | 'uk';
export const GUEST_LANGS: [GuestLang, string][] = [
  ['pl', 'polski'], ['en', 'angielski'], ['cs', 'czeski (e-mail po angielsku)'], ['de', 'niemiecki (e-mail po angielsku)'], ['uk', 'ukraiński (e-mail po angielsku)'],
];
export const guestLang = (v: string | null | undefined): GuestLang => (GUEST_LANGS.some(([k]) => k === v) ? v as GuestLang : 'pl');
