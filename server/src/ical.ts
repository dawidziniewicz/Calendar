export type IcalEvent = { uid: string; start: string; end: string; summary: string };

/** Zamienia 20260716 / 20260716T140000Z na 2026-07-16. */
function toIsoDate(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const unescapeText = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const escapeText = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');

/** Minimalny parser iCal wystarczający dla eksportów Booking.com / Airbnb / Google. */
export function parseIcal(text: string): IcalEvent[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events: IcalEvent[] = [];
  let cur: Partial<IcalEvent> | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur?.start) {
        const end = cur.end && cur.end > cur.start ? cur.end : addDays(cur.start, 1);
        events.push({ uid: cur.uid || `${cur.start}_${end}`, start: cur.start, end, summary: cur.summary ?? '' });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).split(';')[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (name === 'UID') cur.uid = value.trim();
    else if (name === 'SUMMARY') cur.summary = unescapeText(value);
    else if (name === 'DTSTART') cur.start = toIsoDate(value) ?? undefined;
    else if (name === 'DTEND') cur.end = toIsoDate(value) ?? undefined;
  }
  return events;
}

export function buildIcal(calName: string, events: { id: number; start: string; end: string }[]): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const d = (s: string) => s.replaceAll('-', '');
  const out = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//odmorzadogor//kalendarz//PL', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calName)}`,
  ];
  for (const e of events) {
    out.push(
      'BEGIN:VEVENT', `UID:rez-${e.id}@kalendarz.odmorzadogor`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d(e.start)}`, `DTEND;VALUE=DATE:${d(e.end)}`, 'SUMMARY:Zajęte', 'END:VEVENT',
    );
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n') + '\r\n';
}
