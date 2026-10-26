import { useEffect, useRef, useState } from 'react';

// Podgląd PDF (rachunek A4): strony renderowane przez pdf.js do szerokości okna — tak samo na telefonie i komputerze
// (Safari na iPhonie w ramce pokazuje tylko pierwszą stronę i nie da się powiększyć).
type PdfJs = typeof import('pdfjs-dist');
let pdfjs: Promise<PdfJs> | null = null;
const loadPdfJs = () => (pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib;
}).catch((err) => { pdfjs = null; throw err; })); // nieudane wczytanie — następna próba od nowa

export default function PdfPreview({ blob, loading, error: outerError }: { blob: Blob | null; loading?: boolean; error?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(false);
  const [width, setWidth] = useState(0);

  // szerokość kontenera (obrót telefonu, zmiana okna) → ponowne renderowanie w ostrej rozdzielczości
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth((w) => (Math.abs(w - e.contentRect.width) > 40 ? Math.round(e.contentRect.width) : w)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!blob || !el || !width) return;
    let cancelled = false;
    setRendering(true);
    (async () => {
      const lib = await loadPdfJs();
      // bez eval (polityka CSP aplikacji)
      const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const pages: HTMLElement[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / base.width) * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.setAttribute('aria-label', `Strona ${i} z ${doc.numPages}`);
        await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
        const wrap = document.createElement('div');
        wrap.className = 'pdf-page';
        wrap.style.aspectRatio = `${base.width} / ${base.height}`;
        wrap.appendChild(canvas);
        pages.push(wrap);
      }
      await doc.destroy();
      if (!cancelled) { el.replaceChildren(...pages); setError(''); }
    })().catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setRendering(false); });
    return () => { cancelled = true; };
  }, [blob, width]);

  const err = outerError || error;
  return (
    <div className="pdf-preview">
      {(loading || rendering) && <div className="pdf-status">Przygotowywanie podglądu…</div>}
      {err && (
        // stara wersja aplikacji po wdrożeniu nowej (brak plików podglądu) → wystarczy odświeżyć
        /MIME type|dynamically imported module|fake worker|Importing a module script failed/i.test(err)
          ? <div className="banner info">Jest nowa wersja aplikacji. <button type="button" className="link" onClick={() => location.reload()}>Odśwież</button>, żeby zobaczyć podgląd.</div>
          : <div className="banner error">{err}</div>
      )}
      <div ref={box} className={`pdf-pages ${loading ? 'is-loading' : ''}`} />
    </div>
  );
}
