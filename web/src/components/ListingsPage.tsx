import { useEffect, useMemo, useRef, useState } from 'react';
import type { Property } from '../types';
import { PORTALS, SITE_URL, domainOf, loadListingData, photoUrl, type Lang, type ListingData, type ListingObject, type PortalId } from '../listing/data';
import { descriptions, posterHighlights, ratingShort, sleepsShort, titles } from '../listing/texts';
import { drawPoster, loadPhoto, photoJpeg, posterJpeg, type PosterContent } from '../listing/render';
import { buildZip, download, saveFile, type PackInput } from '../listing/pack';

// Ogłoszenia na portale: dla wybranego obiektu i portalu — zdjęcia w odpowiednim formacie, plakat z adresem strony
// (co ma być na plakacie — do zaznaczenia), kilka propozycji opisu i tytułu, wszystko w paczce ZIP.

type Show = { logo: boolean; region: boolean; name: boolean; sleeps: boolean; price: boolean; rating: boolean; highlights: boolean; note: boolean; qr: boolean; phone: boolean };
const SHOW_LABELS: [keyof Show, string][] = [
  ['name', 'Nazwa obiektu'], ['region', 'Miejscowość i region'], ['sleeps', 'Liczba osób'], ['price', 'Cena „od … zł / noc”'],
  ['rating', 'Ocena w Google'], ['highlights', 'Trzy największe atuty'], ['note', '„Bez prowizji pośredników”'], ['logo', 'Logo Od Morza do Gór'],
  ['qr', 'Kod QR do strony obiektu'], ['phone', 'Numer telefonu'],
];
const HEADLINES: Record<Lang, string[]> = {
  pl: ['Zarezerwuj bezpośrednio na', 'Wolne terminy i ceny sprawdzisz na', 'Rezerwacja bez pośredników na'],
  en: ['Book direct at', 'Check availability and prices at', 'Book with no middleman at'],
};
const NOTE: Record<Lang, string> = { pl: 'Bez prowizji pośredników', en: 'No booking fees' };

type Prefs = { show: Show; headline: number; posterFirst: boolean; withPhone: boolean; withPrice: boolean; phone: string };
const DEFAULT_PREFS: Prefs = {
  show: { logo: true, region: true, name: true, sleeps: true, price: true, rating: true, highlights: true, note: true, qr: false, phone: false },
  headline: 0, posterFirst: false, withPhone: false, withPrice: true, phone: '',
};
const readPrefs = (): Prefs => {
  try {
    const p = JSON.parse(localStorage.getItem('listing-prefs') ?? '{}') as Partial<Prefs>;
    return { ...DEFAULT_PREFS, ...p, show: { ...DEFAULT_PREFS.show, ...p.show } };
  } catch { return DEFAULT_PREFS; }
};

/** Najniższa cena za noc z cennika kalendarza (cena podstawowa i ceny wg dni tygodnia) */
function lowestPrice(o: ListingObject | undefined, properties: Property[]) {
  if (!o) return null;
  const prop = properties.find((p) => p.name.toLowerCase().includes(o.calendarMatch.toLowerCase()));
  const prices = (prop?.units ?? []).flatMap((u) => {
    let week: (number | null)[] = [];
    try { week = u.weekday_prices ? JSON.parse(u.weekday_prices) : []; } catch { /* brak */ }
    return [u.base_price, ...week].filter((x): x is number => typeof x === 'number' && x > 0);
  });
  return prices.length ? Math.min(...prices) : null;
}
const priceText = (n: number | null, lang: Lang) => (n ? (lang === 'pl' ? `od ${n} zł / noc` : `from ${n} PLN / night`) : '');
const priceInText = (n: number | null, lang: Lang) => (n ? (lang === 'pl' ? `od ${n} zł za noc` : `from ${n} PLN per night`) : '');
/** „+48517382997” → „+48 517 382 997” (czytelniej na plakacie i w opisie) */
const prettyPhone = (v: string) => {
  const d = v.replace(/[^\d+]/g, '');
  const m = d.match(/^(?:\+?48)?(\d{3})(\d{3})(\d{3})$/);
  return m ? `+48 ${m[1]} ${m[2]} ${m[3]}` : v;
};
const thumb = (src: string) => src.replace(/-\d+\.webp$/, '-480.webp');

export default function ListingsPage({ properties, onBack }: { properties: Property[]; onBack: () => void }) {
  const [data, setData] = useState<ListingData | null>(null);
  const [error, setError] = useState('');
  const [objKey, setObjKey] = useState('');
  const [portalId, setPortalId] = useState<PortalId>('olx');
  const [lang, setLang] = useState<Lang>('pl');
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const [posterOn, setPosterOn] = useState(true);
  const [posterPhoto, setPosterPhoto] = useState(0);
  const [selected, setSelected] = useState<Record<string, number[]>>({}); // obiekt → indeksy zdjęć w kolejności
  const [price, setPrice] = useState<number | null>(null);
  const [variant, setVariant] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState('');
  const preview = useRef<HTMLCanvasElement>(null);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    loadListingData().then((d) => { setData(d); setObjKey((k) => k || d.objects[0]?.key || ''); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { try { localStorage.setItem('listing-prefs', JSON.stringify(prefs)); } catch { /* prywatny tryb */ } }, [prefs]);

  // numer na plakacie i w opisach (puste pole = numer ze strony)
  const info = useMemo(() => (data ? { ...data, phone: prettyPhone(prefs.phone.trim() || data.phone) } : null), [data, prefs.phone]);
  const o = data?.objects.find((x) => x.key === objKey);
  const portal = PORTALS.find((p) => p.id === portalId)!;
  useEffect(() => { setPrice(lowestPrice(o, properties)); setPosterPhoto(0); }, [o, properties]);
  useEffect(() => { setPosterOn(portal.poster); setOverrides({}); }, [portal]);
  useEffect(() => { setOverrides({}); }, [objKey, lang]);

  const picks = o ? (selected[o.key] ?? o.photos.map((_, i) => i)) : [];
  const room = portal.maxPhotos - (posterOn ? 1 : 0);
  const togglePhoto = (i: number) => {
    if (!o) return;
    const cur = picks.includes(i) ? picks.filter((x) => x !== i) : [...picks, i];
    setSelected({ ...selected, [o.key]: cur });
  };

  const show = prefs.show;
  const setShow = (k: keyof Show, v: boolean) => setPrefs({ ...prefs, show: { ...show, [k]: v } });
  const posterContent = (): (Omit<PosterContent, 'photo'> & { photo: ListingObject['photos'][number] }) | null => {
    if (!o || !data) return null;
    const facts = [show.sleeps ? sleepsShort(o, lang) : '', show.price ? priceText(price, lang) : '', show.rating ? ratingShort(o, lang) : ''].filter(Boolean);
    return {
      photo: o.photos[posterPhoto] ?? o.photos[0],
      brand: data.brand, domain: domainOf(data.site), headline: HEADLINES[lang][prefs.headline] ?? HEADLINES[lang][0],
      region: show.region ? o.region[lang] : '', name: show.name ? o.name[lang] : '', facts,
      highlights: show.highlights ? posterHighlights(o, lang) : [],
      note: show.note ? NOTE[lang] : '', phone: show.phone && info ? info.phone : '',
      qr: show.qr ? `${data.site}${o.path[lang]}?utm_source=${portal.id}&utm_medium=ogloszenie&utm_campaign=${o.key}` : '',
      logo: show.logo,
    };
  };
  const pc = posterContent();
  const pcKey = JSON.stringify([pc, portal.w, portal.h]);

  // podgląd plakatu na żywo
  useEffect(() => {
    if (!pc || !posterOn || !preview.current) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const photo = await loadPhoto(photoUrl(pc.photo));
        if (cancelled || !preview.current) return;
        await drawPoster(preview.current, portal.w, portal.h, { ...pc, photo });
        setPreviewError('');
      } catch (e) {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : String(e));
      }
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pcKey, posterOn]);

  const textOpts = { price: priceInText(price, lang), withPrice: prefs.withPrice && !!price, withPhone: prefs.withPhone, posterIncluded: posterOn };
  const variants = useMemo(() => (o && info ? descriptions(o, info, portal, lang, textOpts) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [o, info, portal, lang, textOpts.price, textOpts.withPrice, textOpts.withPhone, textOpts.posterIncluded]);
  const tl = o ? titles(o, portal, lang) : [];
  const v = variants[variant] ?? variants[0];
  const vText = v ? overrides[v.id] ?? v.text : '';

  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 1500); } catch { /* brak uprawnień */ }
  };

  const pack = (p = portal, all = false): PackInput | null => {
    if (!o || !info) return null;
    const withPoster = all ? p.poster : posterOn;
    return {
      data: info, object: o, portal: p, lang,
      photos: picks.map((i) => o.photos[i]).filter(Boolean),
      poster: withPoster ? pc : null,
      posterFirst: prefs.posterFirst,
      text: { ...textOpts, posterIncluded: withPoster },
      overrides: all ? undefined : overrides,
    };
  };
  // pojedyncze pliki (bez ZIP): plakat i zdjęcia w formacie portalu
  const slugName = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
  const fileBase = o ? `${slugName(o.name.pl)}-${portal.file}` : '';
  const savePoster = async () => {
    if (!pc) return;
    setError('');
    try {
      setBusy('Przygotowywanie plakatu…');
      const photo = await loadPhoto(photoUrl(pc.photo));
      await saveFile(await posterJpeg(portal.w, portal.h, { ...pc, photo }), `plakat-${fileBase}.jpg`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  const savePhoto = async (i: number, nr?: number) => {
    const ph = o?.photos[i];
    if (!ph) return;
    setError('');
    try {
      setBusy('Przygotowywanie zdjęcia…');
      const img = await loadPhoto(photoUrl(ph));
      await saveFile(await photoJpeg(img, portal.w, portal.h), `${nr ? `${String(nr).padStart(2, '0')}-` : ''}${ph.name}-${portal.file}.jpg`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); }
  };
  const saveAllPhotos = async () => {
    const list = picks.slice(0, room);
    for (const [n, i] of list.entries()) {
      const ph = o?.photos[i];
      if (!ph) continue;
      setBusy(`Zdjęcie ${n + 1} z ${list.length}…`);
      try { download(await photoJpeg(await loadPhoto(photoUrl(ph)), portal.w, portal.h), `${String(n + 1).padStart(2, '0')}-${ph.name}-${portal.file}.jpg`); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); break; }
      await new Promise((r) => setTimeout(r, 350)); // przeglądarka pobiera pliki po kolei
    }
    setBusy('');
  };
  const makeZip = async (all: boolean) => {
    const packs = (all ? PORTALS.map((p) => pack(p, true)) : [pack()]).filter((x): x is PackInput => !!x);
    if (!packs.length) return;
    setError('');
    try {
      setBusy('Przygotowywanie…');
      const { blob, name } = await buildZip(packs, setBusy);
      download(blob, name);
      setBusy('');
    } catch (e) {
      setBusy('');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="pricing-page listings-page">
      <div className="page-head">
        <button type="button" className="link back" onClick={onBack}>‹ Ustawienia</button>
        <h1>Ogłoszenia na portale</h1>
      </div>
      <p className="muted page-lead">
        Zdjęcia w formacie portalu, plakat z adresem strony i kilka propozycji opisu — wszystko w jednej paczce ZIP.
        Opisy nie zawierają linków (portale je blokują); adres strony jest na plakacie.
      </p>
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <p className="muted">Wczytywanie danych ze strony {domainOf(SITE_URL)}…</p>}

      {data && o && (<>
        <div className="panel listing-pick">
          <h2 className="panel-title">Obiekt</h2>
          <div className="chips">
            {data.objects.map((x) => <button key={x.key} type="button" className={`chip ${x.key === objKey ? 'active' : ''}`} onClick={() => setObjKey(x.key)}>{x.name.pl}</button>)}
          </div>
          <h2 className="panel-title">Portal</h2>
          <div className="chips">
            {PORTALS.map((p) => <button key={p.id} type="button" className={`chip ${p.id === portalId ? 'active' : ''}`} onClick={() => setPortalId(p.id)}>{p.label}</button>)}
          </div>
          <div className="listing-format muted">
            Zdjęcia {portal.w}×{portal.h} px ({portal.ratio}) · do {portal.maxPhotos} zdjęć
            {portal.titleMax ? ` · tytuł do ${portal.titleMax} znaków` : ''}{portal.descMax ? ` · opis do ${portal.descMax} znaków` : ''}
          </div>
          <ul className="listing-tips">{portal.tips.map((t) => <li key={t}>{t}</li>)}</ul>
          <div className="seg listing-lang" role="group" aria-label="Język">
            <span>Język ogłoszenia</span>
            <button type="button" className={`chip ${lang === 'pl' ? 'active' : ''}`} onClick={() => setLang('pl')}>Polski</button>
            <button type="button" className={`chip ${lang === 'en' ? 'active' : ''}`} onClick={() => setLang('en')}>English</button>
          </div>
        </div>

        <div className="panel">
          <h2 className="panel-title">Plakat z adresem strony</h2>
          {!portal.poster && (
            <div className="banner info">
              {portal.label} nie pozwala kierować gości do własnej strony — także przez napisy na zdjęciach. Taka oferta może zostać ukryta, dlatego plakat jest domyślnie wyłączony.
            </div>
          )}
          <label className="check-row"><input type="checkbox" checked={posterOn} onChange={(e) => setPosterOn(e.target.checked)} /> Dodaj plakat do paczki</label>
          {posterOn && (<>
            <div className="listing-poster">
              <div className="listing-poster-preview">
                <canvas ref={preview} className="poster-canvas" style={{ aspectRatio: `${portal.w} / ${portal.h}` }} aria-label="Podgląd plakatu" />
                {previewError && <div className="banner error">{previewError}</div>}
                <button type="button" className="btn poster-save" disabled={!!busy} onClick={savePoster}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>
                  Pobierz plakat (JPG {portal.w}×{portal.h})
                </button>
              </div>
              <div className="listing-poster-opts">
                <label className="full">Hasło
                  <select value={prefs.headline} onChange={(e) => setPrefs({ ...prefs, headline: Number(e.target.value) })}>
                    {HEADLINES[lang].map((h, i) => <option key={h} value={i}>{h} {domainOf(data.site)}</option>)}
                  </select>
                </label>
                <span className="listing-sub">Co ma być na plakacie</span>
                <div className="check-grid">
                  {SHOW_LABELS.map(([k, label]) => (
                    <label key={k} className="check-row">
                      <input type="checkbox" checked={show[k]} disabled={k === 'price' && !price} onChange={(e) => setShow(k, e.target.checked)} /> {label}
                    </label>
                  ))}
                </div>
                {show.phone && (
                  <label className="full">Numer na plakacie
                    <input type="tel" inputMode="tel" value={prefs.phone} placeholder={data.phone} onChange={(e) => setPrefs({ ...prefs, phone: e.target.value })} />
                  </label>
                )}
                <label className="full">Cena od (zł za noc)
                  <input inputMode="numeric" value={price ?? ''} onChange={(e) => setPrice(Number(e.target.value.replace(/\D/g, '')) || null)} placeholder="np. 450" />
                </label>
                <span className="listing-sub">Miejsce plakatu w ogłoszeniu</span>
                <div className="chips">
                  <button type="button" className={`chip ${!prefs.posterFirst ? 'active' : ''}`} onClick={() => setPrefs({ ...prefs, posterFirst: false })}>Ostatnie zdjęcie</button>
                  <button type="button" className={`chip ${prefs.posterFirst ? 'active' : ''}`} onClick={() => setPrefs({ ...prefs, posterFirst: true })}>Pierwsze (okładka)</button>
                </div>
              </div>
            </div>
            <span className="listing-sub">Zdjęcie w tle plakatu</span>
            <div className="photo-strip">
              {o.photos.map((ph, i) => (
                <button key={ph.src} type="button" className={`photo-thumb ${i === posterPhoto ? 'is-on' : ''}`} onClick={() => setPosterPhoto(i)} aria-label={ph.alt.pl}>
                  <img src={`${SITE_URL}${thumb(ph.src)}`} alt="" loading="lazy" onError={(e) => { e.currentTarget.src = photoUrl(ph); }} />
                </button>
              ))}
            </div>
          </>)}
        </div>

        <div className="panel">
          <h2 className="panel-title">Zdjęcia <small className="muted">{Math.min(picks.length, room)} z {room}{posterOn ? ' + plakat' : ''}</small></h2>
          <p className="muted small-note">Kliknij, żeby dodać lub usunąć. Numer to kolejność w ogłoszeniu — pierwsze zdjęcie jest okładką. Zdjęcia ponad limit portalu nie trafią do paczki.
            Strzałka w rogu pobiera jedno zdjęcie w formacie {portal.label} ({portal.w}×{portal.h}).</p>
          <div className="photo-grid">
            {o.photos.map((ph, i) => {
              const at = picks.indexOf(i);
              return (
                <div key={ph.src} className="photo-cell">
                  <button type="button" className={`photo-thumb ${at >= 0 ? 'is-on' : ''} ${at >= room ? 'is-over' : ''}`} onClick={() => togglePhoto(i)} title={ph.alt.pl}>
                    <img src={`${SITE_URL}${thumb(ph.src)}`} alt={ph.alt.pl} loading="lazy" onError={(e) => { e.currentTarget.src = photoUrl(ph); }} />
                    {at >= 0 && <span className="photo-nr">{at + 1}</span>}
                  </button>
                  <button type="button" className="photo-dl" disabled={!!busy} onClick={() => savePhoto(i, at >= 0 ? at + 1 : undefined)} aria-label={`Pobierz zdjęcie: ${ph.alt.pl}`} title="Pobierz to zdjęcie (JPG)">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <h2 className="panel-title">Opis</h2>
          <div className="check-grid">
            {portal.direct && <label className="check-row"><input type="checkbox" checked={prefs.withPrice} disabled={!price} onChange={(e) => setPrefs({ ...prefs, withPrice: e.target.checked })} /> Cena „od …” w opisie</label>}
            {portal.direct && <label className="check-row"><input type="checkbox" checked={prefs.withPhone} onChange={(e) => setPrefs({ ...prefs, withPhone: e.target.checked })} /> Telefon w opisie</label>}
          </div>
          {tl.length > 0 && (<>
            <span className="listing-sub">Propozycje tytułu</span>
            <ul className="title-list">
              {tl.map((t) => (
                <li key={t}>
                  <span>{t} <small className="muted">{t.length}/{portal.titleMax}</small></span>
                  <button type="button" className="btn small" onClick={() => copy(t, t)}>{copied === t ? 'Skopiowano ✓' : 'Kopiuj'}</button>
                </li>
              ))}
            </ul>
          </>)}
          <span className="listing-sub">Propozycje opisu</span>
          <div className="chips">
            {variants.map((x, i) => <button key={x.id} type="button" className={`chip ${i === variant ? 'active' : ''}`} onClick={() => setVariant(i)}>{x.label}</button>)}
          </div>
          {v && (<>
            <textarea className="listing-text" rows={14} value={vText} onChange={(e) => setOverrides({ ...overrides, [v.id]: e.target.value })} />
            <div className="listing-text-foot">
              <small className={`muted ${portal.descMax && vText.length > portal.descMax ? 'warn' : ''}`}>{vText.length}{portal.descMax ? ` / ${portal.descMax}` : ''} znaków</small>
              {overrides[v.id] != null && <button type="button" className="link" onClick={() => { const n = { ...overrides }; delete n[v.id]; setOverrides(n); }}>Przywróć</button>}
              <button type="button" className="btn small" onClick={() => copy('desc', vText)}>{copied === 'desc' ? 'Skopiowano ✓' : 'Kopiuj opis'}</button>
            </div>
          </>)}
        </div>

        <div className="listing-actions">
          {busy && <div className="banner info">{busy}</div>}
          <button type="button" className="btn primary big" disabled={!!busy} onClick={() => makeZip(false)}>Pobierz paczkę ZIP — {portal.label}</button>
          <div className="listing-actions-row">
            <button type="button" className="btn" disabled={!!busy || !posterOn} onClick={savePoster}>Sam plakat (JPG)</button>
            <button type="button" className="btn" disabled={!!busy || !picks.length} onClick={saveAllPhotos}>Wybrane zdjęcia osobno (JPG)</button>
          </div>
          <button type="button" className="btn" disabled={!!busy} onClick={() => makeZip(true)}>Paczka dla wszystkich portali</button>
          <p className="muted small-note">Paczka: zdjęcia ponumerowane w kolejności{posterOn ? ', plakat' : ''}, 3 propozycje opisu{tl.length ? ', tytuły' : ''} i plik CZYTAJ-MNIE z instrukcją dla portalu.
            W paczce „dla wszystkich portali” plakat jest tylko tam, gdzie portal na to pozwala.</p>
        </div>
      </>)}
    </section>
  );
}
