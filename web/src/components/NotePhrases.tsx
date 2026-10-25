// Gotowe zdania do dopisku na rachunku — przycisk wstawia zdanie albo (gdy już jest) je usuwa
export const NOTE_PHRASES: [label: string, text: string][] = [
  ['Zwolnienie z VAT (art. 113)', 'Sprzedawca zwolniony podmiotowo z podatku VAT na podstawie art. 113 ust. 1 ustawy o podatku od towarów i usług.'],
];

export function toggleNotePhrase(note: string, phrase: string) {
  if (note.includes(phrase)) return note.replace(phrase, '').replace(/\n{2,}/g, '\n').trim();
  return note.trim() ? `${note.trim()}\n${phrase}` : phrase;
}

export default function NotePhrases({ note, onChange }: { note: string; onChange: (v: string) => void }) {
  return (
    <div className="full chips note-phrases">
      {NOTE_PHRASES.map(([label, text]) => {
        const on = note.includes(text);
        return (
          <button type="button" key={label} className={`chip ${on ? 'active' : ''}`} aria-pressed={on} onClick={() => onChange(toggleNotePhrase(note, text))}>
            {on ? '✓ ' : '＋ '}{label}
          </button>
        );
      })}
    </div>
  );
}
