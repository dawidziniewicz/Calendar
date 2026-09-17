// Ustawienia wyglądu kalendarza — zapisywane na tym urządzeniu (telefon i komputer mogą mieć inne).

export type DaySize = 'compact' | 'normal' | 'large';
export type Prefs = { months: number; daySize: DaySize };

export const MONTH_OPTIONS = [1, 2, 3, 6, 12];
export const DAY_SIZES: { id: DaySize; label: string }[] = [
  { id: 'compact', label: 'Wąskie' },
  { id: 'normal', label: 'Normalne' },
  { id: 'large', label: 'Szerokie' },
];

const KEY = 'kalendarz-prefs';
const DEFAULTS: Prefs = { months: 3, daySize: 'normal' };

export function getPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      months: MONTH_OPTIONS.includes(Number(saved.months)) ? Number(saved.months) : DEFAULTS.months,
      daySize: DAY_SIZES.some((s) => s.id === saved.daySize) ? (saved.daySize as DaySize) : DEFAULTS.daySize,
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // prywatny tryb przeglądarki — ustawienie działa do zamknięcia aplikacji
  }
}
