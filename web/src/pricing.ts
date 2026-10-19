import type { Rate, Unit } from './types';
import { fromIso } from './dates';

// Kolejność dni w formularzach (pon → niedz) i ich numery w JS (0 = niedziela)
export const WEEKDAYS: [number, string][] = [[1, 'Pn'], [2, 'Wt'], [3, 'Śr'], [4, 'Cz'], [5, 'Pt'], [6, 'So'], [0, 'Nd']];

/** Ceny wg dni tygodnia zapisane przy domku: 7 pozycji (0 = niedziela), null = cena podstawowa. */
export function weekdayPrices(u: Pick<Unit, 'weekday_prices'>): (number | null)[] {
  try {
    const arr = u.weekday_prices ? JSON.parse(u.weekday_prices) : [];
    return Array.from({ length: 7 }, (_, i) => (typeof arr[i] === 'number' ? arr[i] : null));
  } catch {
    return Array(7).fill(null);
  }
}

/** Cena nocy zaczynającej się `date`: cena na ten dzień → cena dnia tygodnia → cena podstawowa (tak samo liczy serwer). */
export function nightPrice(u: Unit, date: string, rate?: Rate) {
  return rate?.price ?? weekdayPrices(u)[fromIso(date).getDay()] ?? u.base_price;
}
