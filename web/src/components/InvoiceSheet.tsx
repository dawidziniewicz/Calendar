import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Invoice, InvoiceData, InvoiceItem } from '../types';
import PdfPreview from './PdfPreview';
import NumInput from './NumInput';
import SignaturePad from './SignaturePad';
import NotePhrases from './NotePhrases';
import { CURRENCIES, currencySymbol, fmt } from '../money';
import { useWide } from './useWide';
import { whatsappHref } from '../phone';
import DateInput from './DateInput';

type Props = {
  reservationId?: number; // nowy rachunek do rezerwacji
  invoiceId?: number; // istniejący rachunek
  guestEmail?: string;
  onClose: () => void;
  onChanged: () => void;
};

const PAYMENT_METHODS = ['przelew', 'gotówka', 'karta', 'BLIK'];

// Rachunek: edycja (wszystkie pola opcjonalne) + podgląd PDF A4; po zapisaniu — pobranie, udostępnienie, wysyłka e-mailem.
export default function InvoiceSheet({ reservationId, invoiceId, guestEmail, onClose, onChanged }: Props) {
  const [inv, setInv] = useState<InvoiceData | null>(null);
  const [signing, setSigning] = useState<'seller' | 'buyer' | null>(null);
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
    if (signing) return; // Escape zamyka najpierw pole do podpisu
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, signing]);

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
  const money = (n: number) => fmt(n, inv.currency, true);
  // zmiana waluty nowego rachunku: konto z ustawień dla tej waluty (EUR → konto walutowe)
  const changeCurrency = async (c: string) => {
    if (saved) { set('currency', c); return; }
    try {
      const d = await api.invoiceDraft(reservationId, c);
      setInv({ ...inv, currency: c, seller: { ...inv.seller, account: d.seller.account, bank: d.seller.bank } });
    } catch { set('currency', c); }
  };
  const total = inv.items.reduce((s, it) => s + Math.round(it.qty * it.price * 100) / 100, 0);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.saveInvoice({ ...inv, reservation_id: reservationId ?? inv.reservation_id ?? null, save_template: saveTemplate }, saved?.id);
      setSaved(res);
      setInv(res);
      setMode('view');
      setInfo(saved ? 'Zapisano zmiany.' : `Wystawiono rachunek nr ${res.number}. Możesz go od razu wysłać gościowi e-mailem lub WhatsAppem.`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Podpis palcem: w edycji trafia do formularza, w podglądzie zapisuje się od razu (np. gość podpisuje przy wymeldowaniu)
  const applySignature = async (who: 'seller' | 'buyer', png: string) => {
    setSigning(null);
    const key = who === 'seller' ? 'seller_signature' : 'buyer_signature';
    if (mode === 'edit' || !saved) { setInv({ ...inv, [key]: png }); return; }
    setBusy(true);
    setError('');
    try {
      const res = await api.saveInvoice({ ...saved, [key]: png, save_template: false }, saved.id);
      setSaved(res);
      setInv(res);
      setInfo(who === 'buyer' ? 'Dodano podpis gościa.' : 'Dodano Twój podpis.');
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
  // WhatsApp: czat z gościem (albo wybór kontaktu) z gotową wiadomością i linkiem do PDF
  const waText = saved ? ((saved.guest?.lang ?? 'pl') === 'pl'
    ? `Dzień dobry, przesyłamy rachunek nr ${saved.number} za pobyt. PDF: ${saved.share_url}\n\nPozdrawiamy,\nOd Morza do Gór`
    : `Hello, here is your bill no. ${saved.number} for your stay. PDF: ${saved.share_url}\n\nBest regards,\nOd Morza do Gór`) : '';
  const waPhone = saved?.guest?.phone ? whatsappHref(saved.guest.phone) : null;
  const waHref = (saved?.guest?.phone && whatsappHref(saved.guest.phone, waText)) || `https://wa.me/?text=${encodeURIComponent(waText)}`;
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
                <label>Data wystawienia<DateInput value={inv.issue_date} onChange={(v) => v && set('issue_date', v)} /></label>
                <label>Data wykonania usługi (opcjonalnie)<DateInput clearable value={inv.sale_date} onChange={(v) => set('sale_date', v)} placeholder="brak — nie będzie na rachunku" /></label>
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
                    <label>Cena ({currencySymbol(inv.currency)})<NumInput value={it.price} onChange={(v) => setItem(i, { price: v ?? 0 })} /></label>
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
                <label>Termin płatności<DateInput clearable placeholder="brak" value={inv.payment_due} onChange={(v) => set('payment_due', v)} /></label>
                <label>Waluta
                  <select value={inv.currency} onChange={(e) => changeCurrency(e.target.value)}>
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label>Zapłacono ({currencySymbol(inv.currency)})<NumInput value={inv.paid} onChange={(v) => set('paid', v)} placeholder="puste = nie pokazuj" /></label>
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
                <legend>Podpisy</legend>
                <label className="check-row full">
                  <input type="checkbox" checked={inv.signatures} onChange={(e) => set('signatures', e.target.checked)} />
                  Pola na podpisy na rachunku
                </label>
                <SignatureRow label="Podpis wystawcy" note={saveTemplate ? 'zapamięta się w szablonie' : undefined} value={inv.seller_signature}
                  onSign={() => setSigning('seller')} onClear={() => set('seller_signature', '')} />
                <SignatureRow label="Podpis odbiorcy (gościa)" value={inv.buyer_signature}
                  onSign={() => setSigning('buyer')} onClear={() => set('buyer_signature', '')} />
                {!inv.signatures && <p className="full muted">Bez pól na podpisy — złożony podpis i tak pojawi się na rachunku.</p>}
              </fieldset>

              <fieldset>
                <legend>Dopisek i stopka</legend>
                <label className="full">Dopisek pod pozycjami<textarea rows={2} value={inv.note} onChange={(e) => set('note', e.target.value)} placeholder="np. informacja o zwolnieniu z VAT" /></label>
                <NotePhrases note={inv.note} onChange={(v) => set('note', v)} />
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
                  {saved && (
                    <div className="invoice-send">
                      <span className="invoice-send-label">Wyślij gościowi</span>
                      <div className="invoice-buttons">
                        {saved.reservation_id && (
                          <button type="button" className={`btn ${sendTo != null ? 'primary' : ''}`} onClick={() => setSendTo(sendTo == null ? saved.guest?.email || guestEmail || '' : null)}>
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18v12H3zM3 6l9 7 9-7" /></svg>
                            E-mail z PDF
                          </button>
                        )}
                        <a className="btn whatsapp-btn" href={waHref} target="_blank" rel="noopener noreferrer">
                          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden><path d="M12 2.2A9.8 9.8 0 0 0 3.6 17l-1.4 4.8 4.9-1.3A9.8 9.8 0 1 0 12 2.2Zm0 17.8a8 8 0 0 1-4.1-1.1l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 1 1 12 20Zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.1 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5c-.2 0-.4.1-.6.3-.2.2-.8.8-.8 1.9s.8 2.2.9 2.4c.1.1 1.6 2.5 4 3.5 1.5.6 2 .7 2.8.6.4-.1 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1l-.1-.1Z" /></svg>
                          WhatsApp
                        </a>
                      </div>
                      {sendTo != null && (
                        <div className="send-row">
                          <label>Adres e-mail<input type="email" value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="e-mail gościa" /></label>
                          <button type="button" className="btn primary" disabled={busy || !sendTo} onClick={send}>{busy ? 'Wysyłanie…' : 'Wyślij z PDF'}</button>
                        </div>
                      )}
                      <small className="muted invoice-send-hint">
                        {waPhone ? `WhatsApp otworzy czat z ${saved.guest?.phone} z gotową wiadomością i linkiem do PDF.` : 'Brak numeru gościa — w WhatsAppie wybierzesz, do kogo wysłać wiadomość z linkiem do PDF.'}
                      </small>
                    </div>
                  )}
                  <div className="invoice-buttons">
                    {saved && <a className="btn" href={api.invoicePdfUrl(saved.id, true)} download={fileName}>Pobierz PDF</a>}
                    <button type="button" className="btn" disabled={!blob} onClick={share}>Udostępnij plik / drukuj</button>
                  </div>
                  {saved && (
                    <div className="invoice-buttons sign-buttons">
                      <button type="button" className="btn small" disabled={busy} onClick={() => setSigning('buyer')}>✍ {saved.buyer_signature ? 'Podpisz ponownie (gość)' : 'Podpis gościa'}</button>
                      <button type="button" className="btn small" disabled={busy} onClick={() => setSigning('seller')}>✍ {saved.seller_signature ? 'Podpisz ponownie (Ty)' : 'Mój podpis'}</button>
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
      {signing && (
        <div onClick={(e) => e.stopPropagation()}>
          <SignaturePad
            title={signing === 'buyer' ? 'Podpis odbiorcy (gościa)' : 'Podpis wystawcy'}
            hint={signing === 'buyer' ? 'Podaj telefon gościowi — podpis pojawi się nad linią „osoby upoważnionej do odbioru”.' : undefined}
            onCancel={() => setSigning(null)}
            onSave={(png) => applySignature(signing, png)}
          />
        </div>
      )}
    </div>
  );
}

function SignatureRow({ label, note, value, onSign, onClear }: { label: string; note?: string; value: string; onSign: () => void; onClear: () => void }) {
  return (
    <div className="sig-row full">
      <div className="sig-row-head"><span>{label}</span>{note && value && <small className="muted">{note}</small>}</div>
      {value ? <img className="sig-preview" src={value} alt={label} /> : <div className="sig-empty">brak podpisu</div>}
      <div className="sig-row-actions">
        <button type="button" className="btn small" onClick={onSign}>✍ {value ? 'Podpisz ponownie' : 'Podpisz palcem'}</button>
        {value && <button type="button" className="link danger-link" onClick={onClear}>Usuń</button>}
      </div>
    </div>
  );
}
