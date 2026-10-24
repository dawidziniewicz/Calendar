import { useEffect, useState } from 'react';

/** Szeroki ekran (komputer, tablet poziomo): formularz i podgląd obok siebie. */
export function useWide(query = '(min-width: 980px)') {
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return wide;
}
