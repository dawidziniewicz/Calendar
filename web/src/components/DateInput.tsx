import { useRef } from 'react';
import { dmy } from '../dates';

// Pole daty, które zawsze pokazuje DD/MM/RRRR. Zwykłe <input type="date"> pokazuje format z języka systemu
// (np. MM/DD/YYYY na Macu po angielsku) — tu systemowy kalendarzyk zostaje, ale napis jest nasz.
type Props = {
  value: string; onChange: (iso: string) => void;
  min?: string; max?: string; disabled?: boolean; required?: boolean; placeholder?: string; 'aria-label'?: string;
};

export default function DateInput({ value, onChange, min, max, disabled, required, placeholder = 'DD/MM/RRRR', ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className={`date-input ${disabled ? 'is-disabled' : ''}`}>
      <span className={`date-input-text ${value ? '' : 'is-empty'}`}>{value ? dmy(value) : placeholder}</span>
      <svg className="date-input-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 6h16v14H4zM4 10h16M8 3v4m8-4v4" />
      </svg>
      <input
        ref={ref} type="date" value={value} min={min} max={max} disabled={disabled} required={required} aria-label={rest['aria-label']}
        onChange={(e) => onChange(e.target.value)}
        // na komputerze kliknięcie w pole od razu otwiera kalendarzyk
        onClick={() => { try { ref.current?.showPicker?.(); } catch { /* starsze przeglądarki */ } }}
      />
    </span>
  );
}
