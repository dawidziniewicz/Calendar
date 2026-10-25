import { zipSync, strToU8 } from 'fflate';
import { photoUrl, type Lang, type ListingData, type ListingObject, type ListingPhoto, type Portal } from './data';
import { loadPhoto, photoJpeg, posterJpeg, type PosterContent } from './render';
import { descriptions, titles, type TextOpts } from './texts';
import { dmy, today } from '../dates';

// Paczka ZIP dla portalu: zdjęcia w formacie portalu (01, 02…), plakat z adresem strony, opisy, tytuły i instrukcja.

export type PackInput = {
  data: ListingData; object: ListingObject; portal: Portal; lang: Lang;
  photos: ListingPhoto[]; // wybrane zdjęcia w kolejności
  poster: Omit<PosterContent, 'photo'> & { photo: ListingPhoto } | null;
  posterFirst: boolean;
  text: TextOpts;
  overrides?: Record<string, string>; // opisy poprawione ręcznie (id wariantu → tekst)
};

type Files = Record<string, Uint8Array | [Uint8Array, { level: 0 }]>;
const BOM = '﻿'; // polskie znaki w Notatniku na Windowsie
const txt = (s: string) => strToU8(BOM + s.replace(/\n/g, '\r\n'));
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
const blobBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

export async function addPortal(files: Files, dir: string, p: PackInput, progress: (msg: string) => void) {
  const { portal, object: o, lang } = p;
  const room = portal.maxPhotos - (p.poster ? 1 : 0);
  const chosen = p.photos.slice(0, Math.max(0, room));
  const order: ({ kind: 'photo'; photo: ListingPhoto } | { kind: 'poster' })[] = chosen.map((photo) => ({ kind: 'photo' as const, photo }));
  if (p.poster) {
    if (p.posterFirst) order.unshift({ kind: 'poster' });
    else order.push({ kind: 'poster' });
  }

  const listLines: string[] = [];
  for (const [i, item] of order.entries()) {
    const nr = String(i + 1).padStart(2, '0');
    if (item.kind === 'poster') {
      progress(`${portal.label}: plakat…`);
      const photo = await loadPhoto(photoUrl(p.poster!.photo));
      const jpg = await posterJpeg(portal.w, portal.h, { ...p.poster!, photo });
      const name = `${nr}-plakat-rezerwacja-bezposrednia.jpg`;
      files[`${dir}/${name}`] = [await blobBytes(jpg), { level: 0 }];
      listLines.push(`${nr}  ${lang === 'pl' ? 'Plakat z adresem strony' : 'Poster with website address'} (${p.poster!.domain})`);
    } else {
      progress(`${portal.label}: zdjęcie ${i + 1} z ${order.length}…`);
      const img = await loadPhoto(photoUrl(item.photo));
      const jpg = await photoJpeg(img, portal.w, portal.h);
      files[`${dir}/${nr}-${item.photo.name}.jpg`] = [await blobBytes(jpg), { level: 0 }];
      listLines.push(`${nr}  ${item.photo.alt[lang]}`);
    }
  }

  const tl = titles(o, portal, lang);
  const variants = descriptions(o, p.data, portal, lang, p.text);
  for (const v of variants) files[`${dir}/${v.file}.txt`] = txt(p.overrides?.[v.id] ?? v.text);
  if (tl.length) files[`${dir}/tytuly.txt`] = txt(tl.map((t) => `${t}\r\n(${t.length} / ${portal.titleMax} znaków)`).join('\n\n'));

  const readme = [
    `${o.name[lang]} — ${portal.label}`,
    `Przygotowano w kalendarzu ${dmy(today())}`,
    '',
    'JAK WSTAWIĆ',
    ...portal.tips.map((t) => `- ${t}`),
    '',
    `ZDJĘCIA: ${order.length} szt., format ${portal.w}×${portal.h} px (${portal.ratio}), wstaw w tej kolejności:`,
    ...listLines,
    '',
    'OPISY (wybierz jeden i wklej):',
    ...variants.map((v) => `- ${v.file}.txt — ${v.label} (${(p.overrides?.[v.id] ?? v.text).length}${portal.descMax ? ` / ${portal.descMax}` : ''} znaków)`),
    ...(tl.length ? ['', `TYTUŁY: tytuly.txt (do ${portal.titleMax} znaków)`] : []),
    '',
    'W opisach nie ma linków — portale ich nie przepuszczają. Adres strony jest na plakacie.',
  ];
  if (!p.poster) readme.splice(readme.length - 1, 1);
  files[`${dir}/CZYTAJ-MNIE.txt`] = txt(readme.join('\n'));
}

export async function buildZip(packs: PackInput[], progress: (msg: string) => void) {
  const files: Files = {};
  const single = packs.length === 1;
  const root = `Ogloszenie-${slug(packs[0].object.name.pl)}`;
  for (const p of packs) await addPortal(files, single ? `${root}-${p.portal.file}` : `${root}/${p.portal.file}`, p, progress);
  progress('Pakowanie ZIP…');
  const zip = zipSync(files, { level: 6 });
  const name = single ? `${root}-${packs[0].portal.file}.zip` : `${root}-wszystkie-portale.zip`;
  return { blob: new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), name };
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
