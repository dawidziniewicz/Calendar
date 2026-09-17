const pad = (n: number) => String(n).padStart(2, '0');

export const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromIso = (s: string) => new Date(`${s}T12:00:00`);
export const today = () => toIso(new Date());

export function addDays(iso: string, n: number) {
  const d = fromIso(iso);
  d.setDate(d.getDate() + n);
  return toIso(d);
}

export function addMonths(iso: string, n: number) {
  const d = fromIso(iso);
  d.setMonth(d.getMonth() + n);
  return toIso(d);
}

export const monthsLabel = (n: number) => (n === 1 ? '1 miesiąc' : n >= 2 && n <= 4 ? `${n} miesiące` : `${n} miesięcy`);

export const diffDays = (from: string, to: string) => Math.round((fromIso(to).getTime() - fromIso(from).getTime()) / 86_400_000);

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('pl-PL', opts);
const dayMonth = fmt({ day: 'numeric', month: 'short' });
const longDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const weekdayShort = fmt({ weekday: 'short' });
const monthYear = fmt({ month: 'long', year: 'numeric' });

export const formatShort = (iso: string) => dayMonth.format(fromIso(iso));
export const formatLong = (iso: string) => longDay.format(fromIso(iso));
export const formatWeekday = (iso: string) => weekdayShort.format(fromIso(iso)).replace('.', '');
export const formatMonth = (iso: string) => monthYear.format(fromIso(iso));
export const isWeekend = (iso: string) => [0, 6].includes(fromIso(iso).getDay());

export function nightsLabel(n: number) {
  if (n === 1) return '1 noc';
  const last = n % 10, lastTwo = n % 100;
  return `${n} ${last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'noce' : 'nocy'}`;
}
