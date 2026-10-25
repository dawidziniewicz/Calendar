// Daty zawsze po europejsku: DD/MM/RRRR (e-maile, powiadomienia, rachunki, notatki w rezerwacjach)
const TZ = 'Europe/Warsaw';
export const dmy = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);
/** Dziś (czas polski) jako DD/MM/RRRR */
export const todayDmy = (d = new Date()) => dmy(d.toLocaleDateString('sv-SE', { timeZone: TZ }));
/** Data i godzina (czas polski): DD/MM/RRRR, GG:MM */
export const dmyTime = (d = new Date()) => `${todayDmy(d)}, ${d.toLocaleTimeString('pl-PL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })}`;
