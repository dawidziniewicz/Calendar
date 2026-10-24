import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Invoice, InvoiceData, InvoiceItem } from '../types';
import PdfPreview from './PdfPreview';
import NumInput from './NumInput';
import { useWide } from './useWide';

type Props = {
  reservationId?: number; // nowy rachunek do rezerwacji
  invoiceId?: number; // istniejący rachunek
  guestEmail?: string;
  onClose: () => void;
  onChanged: () => void;
};

const money = (n: number) => `${n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
const PAYMENT_METHODS = ['przelew', 'gotówka', 'karta', 'BLIK'];

// Rachunek: edycja (wszystkie pola opcjonalne) + podgląd PDF A4; po zapisaniu — pobranie, udostępnienie, wysyłka e-mailem.
export default function InvoiceSheet({ reservationId, invoiceId, guestEmail, onClose, onChanged }: Props) {
  const [inv, setInv] = useState<InvoiceData | null>(null);
  const [saved, setSaved] = useState<Invoice | null>(null);
  const [mode, setMode] = useState<'edit' | 'view'>(invoiceId ? 'view' : 'edit');
  const [tab, setTab] = useState<'form' | 'preview'>('form');
  const [saveTemplate, setSaveTemplate] = useState(true);
  const [showSeller, setShowSeller] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [sendTo, setSendTo] = useState<string | null>(null);
  const wide = useWide();
  const body = useRef<HTMLDivElement>(null);
  // po zapisaniu / przejściu do edycji — od góry
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [mode]);

  useEffect(() => {
    (invoiceId ? api.invoice(invoiceId).then((i) => { setSaved(i); setInv(i); }) : api.invoiceDraft(reservationId).then((d) => {
      setInv(d);
      // pusty wystawca = pierwszy rachunek → od razu rozwinięte dane wystawcy
      if (!d.seller.name) setShowSeller(true);
    })).catch((e) => setError(e.message));
  }, [invoiceId, reservationId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Podgląd: zapisany rachunek z serwera, wersja robocza na żywo (z opóźnieniem po pisaniu)
  const previewVisible = mode === 'view' || wide || tab === 'preview';
  const draftKey = useMemo(() => JSON.stringify(inv), [inv]);
  useEffect(() => {
    if (!inv || !previewVisible) return;
    let cancelled = false;
    const t = setTimeout(() => {
      setPreviewBusy(true);
      (mode === 'view' && saved ? api.invoicePdf(saved.id) : api.invoicePreview(inv))
        .then((b) => { if (!cancelled) { setBlob(b); setPreviewError(''); } })
        .catch((e) => { if (!cancelled) setPreviewError(e.message); })
        .finally(() => { if (!cancelled) setPreviewBusy(false); });
    }, mode === 'view' ? 0 : 500);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, previewVisible, mode, saved?.updated_at]);

  if (!inv) {
    return (
      <div className="sheet-backdrop" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <header className="sheet-head"><button type="button" className="link" onClick={onClose}>Zamknij</button><h2>Rachunek</h2><span className="head-spacer" /></header>
          <div className="sheet-body">{error ? <div className="banner error">{error}</div> : <p className="muted">Wczytywanie…</p>}</div>
        </div>
      </div>
    );
  }

  const set = <K extends keyof InvoiceData>(k: K, v: InvoiceData[K]) => setInv({ ...inv, [k]: v });
  const setSeller = (k: keyof InvoiceData['seller'], v: string) => setInv({ ...inv, seller: { ...inv.seller, [k]: v } });
  const setBuyer = (k: keyof InvoiceData['buyer'], v: string) => setInv({ ...inv, buyer: { ...inv.buyer, [k]: v } });
  const setItem = (i: number, patch: Partial<InvoiceItem>) => setInv({ ...inv, items: inv.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const total = inv.items.reduce((s, it) => s + Math.round(it.qty * it.price * 100) / 100, 0);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.saveInvoice({ ...inv, reservation_id: reservationId ?? inv.reservation_id ?? null, save_template: saveTemplate }, saved?.id);
      setSaved(res);
      setInv(res);
      setMode('view');
      setInfo(saved ? 'Zapisano zmiany.' : `Wystawiono rachunek nr ${res.number}.`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fileName = `Rachunek-${(saved?.number || inv.number || 'bez-numeru').replace(/[^\w-]+/g, '-')}.pdf`;
  const share = async () => {
    if (!blob) return;
    const file = new File([blob], fileName, { type: 'application/pdf' });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: fileName });
      else window.open(URL.createObjectURL(blob), '_blank');
    } catch { /* anulowane udostępnianie */ }
  };
  const send = async () => {
    if (!saved) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.sendInvoice(saved.id, { to: sendTo ?? undefined });
      setInfo(`Wysłano rachunek na ${r.to}.`);
      setSendTo(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!saved || !confirm(`Usunąć rachunek nr ${saved.number}?`)) return;
    try {
      await api.deleteInvoice(saved.id);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const title = mode === 'view' ? `Rachunek ${saved?.number ?? ''}` : saved ? 'Edycja rachunku' : 'Nowy rachunek';
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet wide invoice-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="sheet-head">
          <button type="button" className="link" onClick={mode === 'edit' && saved ? () => { setInv(saved); setMode('view'); } : onClose}>{mode === 'edit' && saved ? 'Wróć' : 'Zamknij'}</button>
          <h2>{title}</h2>
          {mode === 'edit'
            ? <button type="button" className="link strong" disabled={busy} onClick={save}>{busy ? 'Zapis…' : saved ? 'Zapisz' : 'Wystaw'}</button>
            : <button type="button" className="link strong" onClick={() => setMode('edit')}>Edytuj</button>}
        </header>

        {mode === 'edit' && !wide && (
          <div className="sheet-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'form'} className={tab === 'form' ? 'active' : ''} onClick={() => setTab('form')}>Dane</button>
            <button role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Podgląd PDF</button>
          </div>
        )}

        <div ref={body} className={`sheet-body invoice-layout ${mode === 'view' ? 'is-view' : ''}`}>
          {mode === 'edit' && (wide || tab === 'form') && (
            <div className="invoice-form">
              <p className="muted small-note">Wszystkie pola są opcjonalne — puste nie pojawią się na rachunku.</p>
              <fieldset>
                <legend>Numer i daty</legend>
                <label>Numer<input value={inv.number} onChange={(e) => set('number', e.target.value)} placeholder="np. 1/2026" /></label>
                <label>Miejsce wystawienia<input value={inv.place} onChange={(e) => set('place', e.target.value)} placeholder="np. Gdańsk" /></label>
                <label>Data wystawienia<input type="date" value={inv.issue_date} onChange={(e) => e.target.value && set('issue_date', e.target.value)} /></label>
                <label>Data wykonania usługi<input type="date" value={inv.sale_date} onChange={(e) => set('sale_date', e.target.value)} /></label>
              </fieldset>

              <fieldset>
                <legend>Nabywca</legend>
                <label className="full">Imię i nazwisko / firma<input value={inv.buyer.name} onChange={(e) => setBuyer('name', e.target.value)} /></label>
                <label className="full">Adres<input value={inv.buyer.address} onChange={(e) => setBuyer('address', e.target.value)} placeholder="ulica i numer" /></label>
                <label>Kod i miejscowość<input value={inv.buyer.city} onChange={(e) => setBuyer('city', e.target.value)} placeholder="00-000 Miasto" /></label>
                <label>NIP<input inputMode="numeric" value={inv.buyer.nip} onChange={(e) => setBuyer('nip', e.target.value)} /></label>
              </fieldset>

              <fieldset className="items-fieldset">
                <legend>Pozycje</legend>
                {inv.items.map((it, i) => (
                  <div key={i} className="invoice-item full">
                    <label className="item-name">Nazwa usługi<textarea rows={2} value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} /></label>
                    <label>Ilość<NumInput value={it.qty} onChange={(v) => setItem(i, { qty: v ?? 0 })} /></label>
                    <label>J.m.<input value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })} placeholder="usł." /></label>
                    <label>Cena (zł)<NumInput value={it.price} onChange={(v) => setItem(i, { price: v ?? 0 })} /></label>
                    <div className="item-total"><small className="muted">Wartość</small><b>{money(Math.round(it.qty * it.price * 100) / 100)}</b></div>
                    {inv.items.length > 1 && <button type="button" className="link danger-link item-remove" onClick={() => set('items', inv.items.filter((_, j) => j !== i))}>Usuń</button>}
                  </div>
                ))}
                <div className="full items-foot">
                  <button type="button" className="btn small" onClick={() => set('items', [...inv.items, { name: '', qty: 1, unit: 'usł.', price: 0 }])}>＋ Dodaj pozycję</button>
                  <span>Razem: <b>{money(total)}</b></span>
                </div>
              </fieldset>

              <fieldset>
                <legend>Płatność</legend>
                <label>Sposób płatności
                  <input list="pay-methods" value={inv.payment_method} onChange={(e) => set('payment_method', e.target.value)} />
                  <datalist id="pay-methods">{PAYMENT_METHODS.map((m) => <option key={m} value={m} />)}</datalist>
                </label>
                <label>Termin płatności<input type="date" value={inv.payment_due} onChange={(e) => set('payment_due', e.target.value)} /></label>
                <label>Zapłacono (zł)<NumInput value={inv.paid} onChange={(v) => set('paid', v)} placeholder="puste = nie pokazuj" /></label>
                {inv.paid !== total && <button type="button" className="chip paid-chip" onClick={() => set('paid', total)}>✓ Zapłacone w całości</button>}
              </fieldset>

              <fieldset>
                <button type="button" className="collapse-head full seller-toggle" onClick={() => setShowSeller(!showSeller)} aria-expanded={showSeller}>
                  <span><b>Wystawca</b> <small className="muted">{inv.seller.name || 'nieuzupełniony'}</small></span><span className="chev">{showSeller ? '▴' : '▾'}</span>
                </button>
                {showSeller && (
                  <>
                    <label className="full">Imię i nazwisko / nazwa firmy<input value={inv.seller.name} onChange={(e) => setSeller('name', e.target.value)} /></label>
                    <label className="full">Adres<input value={inv.seller.address} onChange={(e) => setSeller('address', e.target.value)} /></label>
                    <label>Kod i miejscowość<input value={inv.seller.city} onChange={(e) => setSeller('city', e.target.value)} /></label>
                    <label>NIP (opcjonalnie)<input inputMode="numeric" value={inv.seller.nip} onChange={(e) => setSeller('nip', e.target.value)} /></label>
                    <label>Telefon<input type="tel" value={inv.seller.phone} onChange={(e) => setSeller('phone', e.target.value)} /></label>
                    <label>E-mail<input type="email" value={inv.seller.email} onChange={(e) => setSeller('email', e.target.value)} /></label>
                    <label>Numer konta<input value={inv.seller.account} onChange={(e) => setSeller('account', e.target.value)} placeholder="przy płatności przelewem" /></label>
                    <label>Bank<input value={inv.seller.bank} onChange={(e) => setSeller('bank', e.target.value)} /></label>
                  </>
                )}
              </fieldset>

              <fieldset>
                <legend>Dopisek i stopka</legend>
                <label className="full">Dopisek pod pozycjami<textarea rows={2} value={inv.note} onChange={(e) => set('note', e.target.value)} placeholder="np. Sprzedawca zwolniony z VAT na podstawie art. 113 ust. 1 ustawy o VAT" /></label>
                <label className="full">Stopka (dół strony)<textarea rows={2} value={inv.footer} onChange={(e) => set('footer', e.target.value)} placeholder="puste = bez stopki" /></label>
              </fieldset>

              <label className="check-row template-check">
                <input type="checkbox" checked={saveTemplate} onChange={(e) => setSaveTemplate(e.target.checked)} />
                <span>Zapamiętaj jako szablon — następny rachunek będzie miał te same dane wystawcy, miejsce, płatność, dopisek i stopkę</span>
              </label>
              {error && <div className="banner error">{error}</div>}
              <button type="button" className="btn primary big" disabled={busy} onClick={save}>{busy ? 'Zapisywanie…' : saved ? 'Zapisz zmiany' : 'Wystaw rachunek'}</button>
            </div>
          )}

          {previewVisible && (
            <div className="invoice-preview-pane">
              {mode === 'view' && (
                <div className="invoice-actions">
                  {info && <div className="banner info">{info}</div>}
                  {error && <div className="banner error">{error}</div>}
                  <div className="invoice-buttons">
                    {saved && <a className="btn" href={api.invoicePdfUrl(saved.id, true)} download={fileName}>Pobierz PDF</a>}
                    <button type="button" className="btn" disabled={!blob} onClick={share}>Udostępnij / drukuj</button>
                    {saved?.reservation_id && <button type="button" className="btn primary" onClick={() => setSendTo(sendTo == null ? guestEmail ?? '' : null)}>Wyślij gościowi</button>}
                  </div>
                  {sendTo != null && (
                    <div className="send-row">
                      <label>Adres e-mail<input type="email" value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="e-mail gościa" /></label>
                      <button type="button" className="btn primary" disabled={busy || !sendTo} onClick={send}>{busy ? 'Wysyłanie…' : 'Wyślij z PDF'}</button>
                    </div>
                  )}
                </div>
              )}
              <PdfPreview blob={blob} loading={previewBusy} error={previewError} />
              {mode === 'view' && saved && <button type="button" className="link danger-link invoice-delete" onClick={remove}>Usuń rachunek</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
