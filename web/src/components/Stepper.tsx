import { useEffect, useState } from 'react';

// Pole liczby ze strzałkami − / +: można też skasować i wpisać nową liczbę z klawiatury (bez „12” zamiast „2”).
export default function Stepper({ value, onChange, label, min = 0, max = 999 }: { value: number; onChange: (v: number) => void; label: string; min?: number; max?: number }) {
  // Tekst trzymany lokalnie, żeby dało się skasować pole i wpisać nową liczbę z klawiatury.
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  return (
    <div className="stepper">
      <button type="button" onClick={() => onChange(clamp(value - 1))} disabled={value <= min} aria-label={`${label}: mniej`}>−</button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={label}
        value={text}
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 3);
          setText(digits);
          if (digits !== '' && Number(digits) >= min) onChange(clamp(Number(digits)));
        }}
        onBlur={() => { if (text === '' || Number(text) < min || Number(text) > max) { setText(String(value)); } }}
      />
      <button type="button" onClick={() => onChange(clamp(value + 1))} disabled={value >= max} aria-label={`${label}: więcej`}>+</button>
    </div>
  );
}
