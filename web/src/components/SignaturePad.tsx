import { useEffect, useRef, useState } from 'react';

// Pole do podpisu palcem (telefon, tablet) lub myszką. Wynik: PNG z przezroczystym tłem, przycięty do podpisu.
export default function SignaturePad({ title, hint, onCancel, onSave }: {
  title: string; hint?: string; onCancel: () => void; onSave: (png: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [empty, setEmpty] = useState(true);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  // rozmiar płótna = rozmiar na ekranie × gęstość pikseli (ostra linia na iPhonie)
  useEffect(() => {
    const c = canvas.current!;
    const fit = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (c.width === Math.round(r.width * dpr) && c.height === Math.round(r.height * dpr)) return;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      setEmpty(true); // zmiana rozmiaru (obrót telefonu) czyści pole
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const point = (e: PointerEvent | React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  };
  const ctx = () => {
    const g = canvas.current!.getContext('2d')!;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#1b2a4a';
    g.lineWidth = 2.6 * (window.devicePixelRatio || 1);
    return g;
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
    const g = ctx();
    g.beginPath();
    g.arc(last.current.x, last.current.y, g.lineWidth / 2, 0, Math.PI * 2);
    g.fillStyle = g.strokeStyle;
    g.fill();
    setEmpty(false);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    e.preventDefault();
    const g = ctx();
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events) {
      const p = point(ev);
      const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
      g.beginPath();
      g.moveTo(last.current.x, last.current.y);
      g.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
      g.lineTo(p.x, p.y);
      g.stroke();
      last.current = p;
    }
  };
  const up = () => { drawing.current = false; last.current = null; };

  const clear = () => {
    const c = canvas.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setEmpty(true);
  };

  // przycięcie do podpisu (+ margines) i zmniejszenie do maks. 900 px szerokości
  const save = () => {
    const c = canvas.current!;
    const { data, width, height } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return;
    const pad = Math.round(8 * (window.devicePixelRatio || 1));
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const scale = Math.min(1, 900 / w);
    const out = document.createElement('canvas');
    out.width = Math.round(w * scale);
    out.height = Math.round(h * scale);
    out.getContext('2d')!.drawImage(c, minX, minY, w, h, 0, 0, out.width, out.height);
    onSave(out.toDataURL('image/png'));
  };

  return (
    <div className="sig-overlay" role="dialog" aria-label={title}>
      <div className="sig-box">
        <div className="sig-head">
          <button type="button" className="link" onClick={onCancel}>Anuluj</button>
          <h2>{title}</h2>
          <button type="button" className="link strong" disabled={empty} onClick={save}>Gotowe</button>
        </div>
        <div className="sig-area">
          <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
          <div className="sig-line" aria-hidden />
          {empty && <div className="sig-placeholder" aria-hidden>Podpisz się tutaj palcem</div>}
        </div>
        <p className="sig-hint">{hint ?? 'Na telefonie obróć ekran poziomo, żeby mieć więcej miejsca.'}</p>
        <div className="sig-actions">
          <button type="button" className="btn" disabled={empty} onClick={clear}>Wyczyść</button>
          <button type="button" className="btn primary" disabled={empty} onClick={save}>Zatwierdź podpis</button>
        </div>
      </div>
    </div>
  );
}
