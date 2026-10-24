import { useEffect, useState } from 'react';

const parse = (s: string) => {
  const n = Number(s.replace(',', '.').replace(/\s/g, ''));
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
};
const show = (v: number | null) => (v == null ? '' : String(v).replace('.', ','));

/** Pole kwoty/liczby: pozwala wpisać „12,5” albo skasować wszystko; null = puste. */
export default function NumInput({ value, onChange, placeholder, ariaLabel }: {
  value: number | null; onChange: (v: number | null) => void; placeholder?: string; ariaLabel?: string;
}) {
  const [text, setText] = useState(show(value));
  useEffect(() => {
    setText((t) => (parse(t) === value ? t : show(value)));
  }, [value]);
  return (
    <input inputMode="decimal" value={text} placeholder={placeholder} aria-label={ariaLabel}
      onChange={(e) => { setText(e.target.value); onChange(parse(e.target.value)); }} />
  );
}
