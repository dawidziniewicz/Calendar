import type { Lang, ListingData, ListingObject, Portal } from './data';

// Tytuły i opisy ogłoszeń z treści strony. Bez linków (portale je blokują) — o rezerwacji bezpośredniej
// tylko zdanie, że adres strony jest na zdjęciach (OLX, Facebook…). Na Booking.com i Airbnb bez tego zdania.

export type TextOpts = { price: string; withPrice: boolean; withPhone: boolean; posterIncluded: boolean };
export type Variant = { id: string; label: string; file: string; text: string };

/** Pierwsza litera mała, chyba że to skrót (Wi-Fi, TV, SUP) */
const low = (s: string) => (s.length > 1 && s[1] === s[1].toLowerCase() && s[1] !== s[1].toUpperCase() ? s[0].toLowerCase() + s.slice(1) : s);
const list = (items: string[], lang: Lang) => {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${lang === 'pl' ? 'i' : 'and'} ${items.at(-1)}`;
};
/** Skrócenie na granicy słowa (bez urwanych wyrazów) */
export function fit(text: string, max: number) {
  if (!max || text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf(','));
  let out = cut.slice(0, at > max * 0.6 ? at : max).replace(/[\s,–—:|·&-]+$/, '');
  // bez wiszących spójników i przyimków na końcu („…ogród z”, „…garden with”)
  while (/\s(i|a|z|ze|w|we|na|do|od|dla|o|oraz|and|with|for|of|the|to|in|at|&)$/i.test(out)) out = out.replace(/\s\S+$/, '').replace(/[\s,–—:|·&-]+$/, '');
  return out;
}
/** Pierwsza propozycja, która mieści się w limicie bez obcinania; inaczej obcięta pierwsza */
const firstFitting = (options: string[], max: number) => options.find((o) => o.length <= max) ?? fit(options[0], max);
const sentence = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const T = {
  pl: {
    sleeps: (n: number) => `do ${n} ${n === 1 ? 'osoby' : 'osób'}`,
    units: 'Zakwaterowanie',
    unitLine: (name: string, count: number, sleeps: number, items: string) => `${name}${count > 1 ? ` (${count} szt.)` : ''} — do ${sleeps} osób: ${items}`,
    whatsSpecial: 'Dlaczego warto:',
    onSite: 'Na miejscu',
    around: 'Okolica',
    best: 'Najważniejsze',
    amenities: 'Udogodnienia',
    price: (p: string) => `Ceny ${p}.`,
    direct: 'Rezerwujesz bezpośrednio u nas — bez prowizji pośredników i bez dopłat za rezerwację.',
    directPoster: 'Wolne terminy i aktualne ceny sprawdzisz na naszej stronie — adres jest na zdjęciach.',
    directNoPoster: (brand: string) => `Wolne terminy i ceny sprawdzisz na naszej stronie — wpisz w wyszukiwarkę „${brand}”.`,
    phone: (p: string) => `Zadzwoń lub napisz: ${p}.`,
    welcome: 'Do zobaczenia!',
    labels: ['Z opowieścią', 'Konkretnie, w punktach', 'Krótko'],
    files: ['opis-1-z-opowiescia', 'opis-2-konkretnie', 'opis-3-krotko'],
    stay: (loc: string) => `Noclegi ${loc}`,
  },
  en: {
    sleeps: (n: number) => `up to ${n} ${n === 1 ? 'guest' : 'guests'}`,
    units: 'Accommodation',
    unitLine: (name: string, count: number, sleeps: number, items: string) => `${name}${count > 1 ? ` (×${count})` : ''} — up to ${sleeps} guests: ${items}`,
    whatsSpecial: 'Why guests love it:',
    onSite: 'On site',
    around: 'Nearby',
    best: 'Highlights',
    amenities: 'Amenities',
    price: (p: string) => `Prices ${p}.`,
    direct: 'You book directly with us — no booking fees and no middleman.',
    directPoster: 'Check availability and current prices on our website — the address is in the photos.',
    directNoPoster: (brand: string) => `Check availability and prices on our website — just search for “${brand}”.`,
    phone: (p: string) => `Call or message us: ${p}.`,
    welcome: 'See you soon!',
    labels: ['Story', 'To the point', 'Short'],
    files: ['description-1-story', 'description-2-to-the-point', 'description-3-short'],
    stay: (loc: string) => `${loc} holiday stay`,
  },
};

const unitLines = (o: ListingObject, lang: Lang) => o.units.map((u) => T[lang].unitLine(u.name[lang], u.count, u.sleeps, u.items[lang].map(low).join(', ')));
const distanceText = (o: ListingObject, lang: Lang) => o.distances[lang].map(([a, b]) => `${a} — ${b}`);

function closing(o: ListingObject, d: ListingData, portal: Portal, lang: Lang, opts: TextOpts, short = false) {
  const t = T[lang];
  const out: string[] = [];
  // Booking.com i Airbnb same pokazują ceny i nie pozwalają kierować na własną stronę
  if (opts.withPrice && opts.price.trim() && portal.direct) out.push(t.price(opts.price.trim()));
  if (portal.direct) {
    out.push(t.direct);
    if (!short || opts.posterIncluded) out.push(opts.posterIncluded ? t.directPoster : t.directNoPoster(d.brand));
  }
  if (opts.withPhone && portal.direct) out.push(t.phone(d.phone));
  return out;
}

function hashtags(o: ListingObject, lang: Lang) {
  const tag = (s: string) => `#${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}`;
  const words = [o.locality, ...o.region.pl.split('·').map((s) => s.trim())];
  const byAmenity: Record<string, string[]> = {
    pool: ['basen'], sauna: ['sauna'], jacuzzi: ['jacuzzi'], mountain: ['góry', 'widoknagóry'], ski: ['narty'], lake: ['jezioro'],
    pets: ['zpsem', 'petfriendly'], playground: ['zdziećmi'], fireplace: ['kominek'], horses: ['konie'],
  };
  const extra = o.amenities.flatMap((a) => byAmenity[a.key] ?? []);
  const base = lang === 'pl' ? ['noclegi', 'urlopwpolsce', 'wakacje', 'weekendwpolsce'] : ['visitpoland', 'holidayrental', 'travelpoland'];
  return [...new Set([...words, ...extra, ...base, 'odmorzadogor'].map(tag))].slice(0, 20).join(' ');
}

export function titles(o: ListingObject, portal: Portal, lang: Lang): string[] {
  if (!portal.titleMax) return [];
  const name = o.name[lang], kind = o.kind[lang], loc = o.locality;
  const am = o.amenities.slice(0, 3).map((a) => low(a[lang]));
  const h = o.highlights.map((x) => low(x[lang][0]));
  const withLoc = name.toLowerCase().includes(loc.toLowerCase()) ? '' : `, ${loc}`;
  const sleeps = Math.max(...o.units.map((u) => u.sleeps), 0) || o.sleeps;
  const max = portal.titleMax;
  const stay = lang === 'pl' ? `${T.pl.stay(loc)} ${T.pl.sleeps(sleeps)}` : `${T.en.stay(loc)} for ${T.en.sleeps(sleeps)}`;
  const list1 = [
    firstFitting([`${name} — ${low(kind)}${withLoc}`, name], max),
    firstFitting([`${kind}, ${loc}: ${list(am.slice(0, 2), lang)}`, `${kind}, ${loc}: ${am[0] ?? ''}`, `${kind}, ${loc}`], max),
    firstFitting([`${stay} — ${am[0] ?? low(kind)}`, stay], max),
    firstFitting([`${name}: ${h.slice(0, 2).join(', ')}`, `${name}: ${h[0] ?? ''}`], max),
  ];
  return [...new Set(list1.map((s) => s.replace(/[:\s]+$/, '')))];
}

export function descriptions(o: ListingObject, d: ListingData, portal: Portal, lang: Lang, opts: TextOpts): Variant[] {
  const t = T[lang];
  const name = o.name[lang];
  const tags = portal.hashtags ? `\n\n${hashtags(o, lang)}` : '';

  // 1. Z opowieścią: tekst ze strony + atuty + domki + okolica
  const story = [
    `${name} — ${low(o.kind[lang])}`,
    ...o.intro[lang],
    [t.whatsSpecial, ...o.highlights.map((x) => `— ${x[lang][0]}: ${low(x[lang][1])}`)].join('\n'),
    [`${t.units}:`, ...unitLines(o, lang).map((l) => `— ${l}`)].join('\n'),
    `${t.onSite}: ${o.amenities.map((a) => low(a[lang])).join(', ')}.`,
    `${t.around}: ${distanceText(o, lang).join(', ')}.`,
    o.rating ? sentence(o.rating[lang]) : '',
    closing(o, d, portal, lang, opts).join(' '),
  ].filter(Boolean).join('\n\n');

  // 2. Konkretnie: punkty, łatwe do przejrzenia na telefonie
  const points = [
    `${name} — ${low(o.kind[lang])}\n${o.region[lang]}`,
    o.lead[lang],
    [`${t.best}:`, ...o.highlights.map((x) => `• ${x[lang][0]} — ${low(x[lang][1])}`)].join('\n'),
    [`${t.units}:`, ...unitLines(o, lang).map((l) => `• ${l}`)].join('\n'),
    [`${t.amenities}:`, ...o.amenities.map((a) => `• ${a[lang]}`)].join('\n'),
    [`${t.around}:`, ...distanceText(o, lang).map((l) => `• ${l}`)].join('\n'),
    o.rating ? sentence(o.rating[lang]) : '',
    closing(o, d, portal, lang, opts).join('\n'),
  ].filter(Boolean).join('\n\n');

  // 3. Krótko: na Facebooka, Instagram i Airbnb (500 znaków)
  const sizes = o.units.map((u) => u.sleeps);
  const [min, max] = sizes.length ? [Math.min(...sizes), Math.max(...sizes)] : [o.sleeps, o.sleeps];
  const am = o.amenities.slice(0, 4).map((a) => low(a[lang]));
  const firstDistance = o.distances[lang][0];
  const shortBody = [
    o.lead[lang],
    lang === 'pl'
      ? (min === max ? `Noclegi ${t.sleeps(max)}.` : `Noclegi dla ${min}–${max} osób.`)
      : (min === max ? `Sleeps ${t.sleeps(max)}.` : `Sleeps ${min}–${max} guests.`),
    `${t.onSite}: ${list(am, lang)}.`,
    firstDistance ? `${firstDistance[0]} — ${firstDistance[1]}.` : '',
  ].filter(Boolean).join(' ');
  const shortClose = closing(o, d, portal, lang, opts, true).join(' ');
  let short = [shortBody, shortClose].filter(Boolean).join('\n\n');
  if (portal.descMax && short.length > portal.descMax) short = fit(shortBody, portal.descMax - 1);

  const v = [story, points, short].map((text, i) => ({
    id: t.files[i], label: t.labels[i], file: t.files[i],
    text: (portal.descMax ? fitParagraphs(text, portal.descMax - tags.length) : text) + tags,
  }));
  return v;
}

/** Za długi opis: całe akapity po kolei, póki się mieszczą (zakończenie zawsze zostaje) */
function fitParagraphs(text: string, max: number) {
  if (text.length <= max) return text;
  const parts = text.split('\n\n').filter(Boolean);
  const last = parts.length > 1 ? parts.pop()! : '';
  const room = max - (last ? last.length + 2 : 0);
  const keep: string[] = [];
  for (const p of parts) {
    const len = keep.join('\n\n').length + (keep.length ? 2 : 0) + p.length;
    if (len <= room) keep.push(p);
  }
  if (!keep.length) keep.push(fit(parts[0] ?? '', room));
  return [...keep, last].filter(Boolean).join('\n\n');
}

/** Krótkie atuty na plakat (z tytułów wyróżników na stronie) */
export const posterHighlights = (o: ListingObject, lang: Lang) => o.highlights.map((h) => h[lang][0]).slice(0, 3);
export const ratingShort = (o: ListingObject, lang: Lang) => {
  const m = o.rating?.[lang].match(/\d[,.]\d/);
  if (!m) return '';
  return lang === 'pl' ? `Ocena ${m[0]} w Google` : `Rated ${m[0]} on Google`;
};
export const sleepsShort = (o: ListingObject, lang: Lang) => {
  const n = Math.max(...o.units.map((u) => u.sleeps), 0) || o.sleeps;
  return lang === 'pl' ? `Do ${n} osób` : `Up to ${n} guests`;
};
