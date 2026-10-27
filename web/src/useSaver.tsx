import { useState } from 'react';
import { saveFiles, type SaveResult } from './files';

type Item = { blob: Blob; name: string };

/**
 * Zapis plików z drugim stuknięciem na iPhonie: gdy plik przygotowywał się dłużej, iOS nie otworzy okna Udostępnij
 * bez ponownego stuknięcia — wtedy pokazujemy przycisk „Zapisz plik”.
 */
export function useSaver() {
  const [pending, setPending] = useState<Item[] | null>(null);
  const save = async (items: Item[]): Promise<SaveResult> => {
    const r = await saveFiles(items);
    setPending(r === 'needs-tap' ? items : null);
    return r;
  };
  const prompt = pending ? (
    <div className="banner info save-pending">
      <span>{pending.length === 1 ? `Plik „${pending[0].name}” jest gotowy.` : `Gotowe: ${pending.length} pliki.`}</span>
      <span className="save-pending-actions">
        <button type="button" className="btn small primary" onClick={() => save(pending)}>{pending.length === 1 ? 'Zapisz plik' : 'Zapisz pliki'}</button>
        <button type="button" className="link" onClick={() => setPending(null)}>Zamknij</button>
      </span>
    </div>
  ) : null;
  return { save, prompt };
}
