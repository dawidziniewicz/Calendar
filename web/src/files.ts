// Zapisywanie plików (PDF rachunku, załączniki, zdjęcia):
// na telefonie okno „Udostępnij” (iPhone: „Zapisz w Plikach” / „Zapisz obraz”) — w aplikacji z ekranu głównego iOS
// zwykły link do pobrania nic nie robi; na komputerze zwykłe pobranie.

export type SaveResult = 'saved' | 'cancelled' | 'needs-tap';

/**
 * 'needs-tap' — iOS pozwala otworzyć okno Udostępnij tylko zaraz po stuknięciu; gdy plik pobierał się dłużej,
 * trzeba stuknąć jeszcze raz (przycisk „Zapisz plik”).
 */
export async function saveFile(blob: Blob, name: string): Promise<SaveResult> {
  return saveFiles([{ blob, name }]);
}

/** Kilka plików naraz (np. zdjęcia do ogłoszenia): na telefonie jedno okno Udostępnij, na komputerze po kolei */
export async function saveFiles(list: { blob: Blob; name: string }[]): Promise<SaveResult> {
  const files = list.map(({ blob, name }) => new File([blob], name, { type: blob.type || 'application/octet-stream' }));
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, title: list.length === 1 ? list[0].name : undefined });
      return 'saved';
    } catch (e) {
      const n = (e as Error).name;
      if (n === 'AbortError') return 'cancelled';
      if (n === 'NotAllowedError') return 'needs-tap';
    }
  }
  for (const [i, { blob, name }] of list.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 350)); // przeglądarka pobiera pliki po kolei
    download(blob, name);
  }
  return 'saved';
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

/** Plik z API (z ciasteczkiem sesji) jako Blob */
export async function fetchBlob(url: string) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { 'x-requested-with': 'kalendarz' } });
  if (!res.ok) throw new Error(`Nie udało się pobrać pliku (${res.status})`);
  return res.blob();
}
