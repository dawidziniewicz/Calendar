import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ForeignAccount, InvoiceListItem, InvoiceTemplate, PaymentSettings } from '../types';
import { formatShort } from '../dates';
import InvoiceSheet from './InvoiceSheet';
import NumInput from './NumInput';
import NotePhrases from './NotePhrases';

import { CURRENCIES, fmt } from '../money';

// Ustawienia płatności (konto do przelewów, domyślna zaliczka, warunki) i rachunków (szablon wystawcy, lista).
export default function PaymentsPage({ onBack, canEdit }: { onBack: () => void; canEdit: boolean }) {
  const [ps, setPs] = useState<PaymentSettings | null>(null);
  const [tpl, setTpl] = useState<InvoiceTemplate | null>(null);
  const [list, setList] = useState<InvoiceListItem[]>([]);
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<{ id?: number } | null>(null);
  const [msg, setMsg] = useState<{ where: 'pay' | 'tpl'; ok: boolean; text: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.paymentSettings().then(setPs).catch((e) => setError(e.message));
    api.invoiceTemplate().then(setTpl).catch(() => {});
  }, []);
  useEffect(() => { api.invoices().then(setList).catch(() => {}); }, [version]);

  const savePayments = async () => {
    if (!ps) return;
    try {
      setPs(await api.savePaymentSettings(ps));
      setMsg({ where: 'pay', ok: true, text: 'Zapisano.' });
    } catch (e) { setMsg({ where: 'pay', ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };
  const saveTemplate = async () => {
    if (!tpl) return;
    try {
      setTpl(await api.saveInvoiceTemplate(tpl));
      setMsg({ where: 'tpl', ok: true, text: 'Zapisano szablon — tak będą wyglądały nowe rachunki.' });
    } catch (e) { setMsg({ where: 'tpl', ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };
  const p = <K extends keyof PaymentSettings>(k: K, v: PaymentSettings[K]) => ps && setPs({ ...ps, [k]: v });
  const setAccount = (i: number, patch: Partial<ForeignAccount>) => ps && setPs({ ...ps, accounts: ps.accounts.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  // link revolut.me z Revtagu (tak samo liczy serwer)
  const revolut = (() => {
    const t = (ps?.revolut ?? '').trim().replace(/^https?:\/\//, '').replace(/^(www\.)?revolut\.me\//i, '').replace(/^@/, '').replace(/\/.*$/, '');
    return /^[a-z0-9._-]{2,40}$/i.test(t) ? `https://revolut.me/${t.toLowerCase()}` : '';
  })();
  const t = <K extends keyof InvoiceTemplate>(k: K, v: InvoiceTemplate[K]) => tpl && setTpl({ ...tpl, [k]: v });

  return (
    <section className="pricing-page payments-page">
      <div className="page-head">
        <button type="button" className="link back" onClick={onBack}>‹ Ustawienia</button>
        <h1>Płatności i rachunki</h1>
      </div>
      <p className="muted page-lead">Dane do przelewu trafiają do e-maili z prośbą o zaliczkę i do potwierdzenia po akceptacji oferty. Wszystkie pola są opcjonalne.</p>
      {error && <div className="banner error">{error}</div>}

      {ps && (
        <div className="panel">
          <h2 className="panel-title">Dane do przelewu (PLN)</h2>
          <fieldset className="plain">
            <label className="full">Numer konta<input inputMode="numeric" value={ps.account_number} disabled={!canEdit} onChange={(e) => p('account_number', e.target.value)} placeholder="np. 12 3456 7890 1234 5678 9012 3456" /></label>
            <label>Odbiorca przelewu<input value={ps.account_name} disabled={!canEdit} onChange={(e) => p('account_name', e.target.value)} placeholder="imię i nazwisko / firma" /></label>
            <label>Bank<input value={ps.bank_name} disabled={!canEdit} onChange={(e) => p('bank_name', e.target.value)} placeholder="opcjonalnie" /></label>
            <label>BIC / SWIFT<input value={ps.bic} disabled={!canEdit} onChange={(e) => p('bic', e.target.value.toUpperCase())} placeholder="dla przelewów z zagranicy" /></label>
          </fieldset>

          <h2 className="panel-title">Konta walutowe</h2>
          <p className="muted small-note">Dla rezerwacji, ofert i rachunków w EUR, GBP… goście dostaną IBAN i BIC z konta w tej walucie (np. konto walutowe albo Revolut Business).</p>
          {ps.accounts.map((a, i) => (
            <fieldset key={i} className="plain foreign-account">
              <label>Waluta
                <select value={a.currency} disabled={!canEdit} onChange={(e) => setAccount(i, { currency: e.target.value })}>
                  {CURRENCIES.filter((c) => c !== 'PLN').map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label>BIC / SWIFT<input value={a.bic} disabled={!canEdit} onChange={(e) => setAccount(i, { bic: e.target.value.toUpperCase() })} /></label>
              <label className="full">IBAN<input value={a.account_number} disabled={!canEdit} onChange={(e) => setAccount(i, { account_number: e.target.value })} placeholder="np. PL61 1090 1014 0000 0712 1981 2874" /></label>
              <label>Odbiorca<input value={a.account_name} disabled={!canEdit} onChange={(e) => setAccount(i, { account_name: e.target.value })} placeholder={ps.account_name || 'imię i nazwisko'} /></label>
              <label>Bank<input value={a.bank_name} disabled={!canEdit} onChange={(e) => setAccount(i, { bank_name: e.target.value })} /></label>
              {canEdit && <button type="button" className="link danger-link full" onClick={() => p('accounts', ps.accounts.filter((_, j) => j !== i))}>Usuń konto {a.currency}</button>}
            </fieldset>
          ))}
          {canEdit && <button type="button" className="btn small" onClick={() => p('accounts', [...ps.accounts, { currency: ['EUR', 'GBP', 'USD'].find((c) => !ps.accounts.some((a) => a.currency === c)) ?? 'EUR', account_number: '', account_name: ps.account_name, bank_name: '', bic: '' }])}>＋ Dodaj konto walutowe</button>}

          <h2 className="panel-title revolut-title">Revolut</h2>
          <fieldset className="plain">
            <label className="full">Revtag (nazwa użytkownika Revolut)
              <input value={ps.revolut} disabled={!canEdit} onChange={(e) => p('revolut', e.target.value)} placeholder="np. @jankowalski" autoCapitalize="none" />
            </label>
            {revolut && <p className="full muted">Goście dostaną link <a href={revolut} target="_blank" rel="noopener noreferrer">{revolut.replace('https://', '')}</a> i kod QR — płacą kartą lub z aplikacji Revolut w dowolnej walucie (kwotę wpisują sami).</p>}
            <label className="check-row full"><input type="checkbox" checked={ps.show_qr} disabled={!canEdit} onChange={(e) => p('show_qr', e.target.checked)} /> Kody QR do płatności (e-maile, strona oferty, rachunek)</label>
            <p className="full muted">QR do przelewu: w PLN dla aplikacji polskich banków, w EUR — kod SEPA (EPC) dla banków w strefie euro. Dla innych walut tylko Revolut.</p>
          </fieldset>
          <h2 className="panel-title">Zaliczka i oferty</h2>
          <fieldset className="plain">
            <label>Domyślna zaliczka (% ceny)<NumInput value={ps.deposit_percent} onChange={(v) => p('deposit_percent', v)} placeholder="np. 30" /></label>
            <label>Dni na wpłatę zaliczki<NumInput value={ps.deposit_days} onChange={(v) => p('deposit_days', v)} placeholder="np. 3" /></label>
            <label>Oferta ważna (dni)<NumInput value={ps.offer_days} onChange={(v) => p('offer_days', v)} placeholder="np. 3" /></label>
            <label className="full">Warunki rezerwacji (pokazywane przy akceptacji oferty i w prośbie o zaliczkę)
              <textarea rows={3} value={ps.terms} disabled={!canEdit} onChange={(e) => p('terms', e.target.value)} placeholder="np. Zaliczka jest bezzwrotna. Pozostałą kwotę płatną przy przyjeździe…" />
            </label>
            <label className="full">Warunki po angielsku
              <textarea rows={3} value={ps.terms_en} disabled={!canEdit} onChange={(e) => p('terms_en', e.target.value)} placeholder="e.g. The deposit is non-refundable…" />
            </label>
          </fieldset>
          {canEdit && <button className="btn primary" onClick={savePayments}>Zapisz</button>}
          {msg?.where === 'pay' && <div className={`banner ${msg.ok ? 'info' : 'error'}`} style={{ marginTop: 10 }}>{msg.text}</div>}
        </div>
      )}

      {tpl && (
        <div className="panel">
          <h2 className="panel-title">Szablon rachunku</h2>
          <p className="muted small-note">Te dane wpisują się w każdy nowy rachunek (możesz je zmienić przy wystawianiu — ostatnio użyte zapamiętują się same).</p>
          <fieldset className="plain">
            <label className="full">Wystawca — imię i nazwisko / firma<input value={tpl.name} onChange={(e) => t('name', e.target.value)} /></label>
            <label className="full">Adres<input value={tpl.address} onChange={(e) => t('address', e.target.value)} /></label>
            <label>Kod i miejscowość<input value={tpl.city} onChange={(e) => t('city', e.target.value)} /></label>
            <label>NIP (opcjonalnie)<input inputMode="numeric" value={tpl.nip} onChange={(e) => t('nip', e.target.value)} /></label>
            <label>Telefon<input type="tel" value={tpl.phone} onChange={(e) => t('phone', e.target.value)} /></label>
            <label>E-mail<input type="email" value={tpl.email} onChange={(e) => t('email', e.target.value)} /></label>
            <label>Numer konta na rachunku<input value={tpl.account} onChange={(e) => t('account', e.target.value)} placeholder={ps?.account_number || 'jak w danych do przelewu'} /></label>
            <label>Miejsce wystawienia<input value={tpl.place} onChange={(e) => t('place', e.target.value)} /></label>
            <label>Domyślny sposób płatności<input list="pay-methods-tpl" value={tpl.payment_method} onChange={(e) => t('payment_method', e.target.value)} />
              <datalist id="pay-methods-tpl">{['przelew', 'gotówka', 'karta', 'BLIK'].map((m) => <option key={m} value={m} />)}</datalist>
            </label>
            <label>Termin płatności (dni)<NumInput value={tpl.payment_days} onChange={(v) => t('payment_days', v)} placeholder="np. 7" /></label>
            <label>Numeracja
              <select value={tpl.numbering} onChange={(e) => t('numbering', e.target.value as 'yearly' | 'monthly')}>
                <option value="yearly">roczna (1/2026, 2/2026…)</option>
                <option value="monthly">miesięczna (1/10/2026…)</option>
              </select>
            </label>
            <label className="check-row"><input type="checkbox" checked={tpl.show_account} onChange={(e) => t('show_account', e.target.checked)} /> Numer konta na rachunku</label>
            <label className="check-row"><input type="checkbox" checked={tpl.signatures} onChange={(e) => t('signatures', e.target.checked)} /> Pola na podpisy</label>
            <label className="check-row"><input type="checkbox" checked={tpl.sale_date !== false} onChange={(e) => t('sale_date', e.target.checked)} /> Data wykonania usługi (dzień wyjazdu) na nowych rachunkach</label>
            {tpl.seller_signature && (
              <div className="sig-row full">
                <div className="sig-row-head"><span>Zapamiętany podpis wystawcy</span></div>
                <img className="sig-preview" src={tpl.seller_signature} alt="Podpis wystawcy" />
                <div className="sig-row-actions"><button type="button" className="link danger-link" onClick={() => t('seller_signature', '')}>Usuń podpis z szablonu</button></div>
              </div>
            )}
            <label className="full">Dopisek pod pozycjami<textarea rows={2} value={tpl.note} onChange={(e) => t('note', e.target.value)} placeholder="np. informacja o zwolnieniu z VAT" /></label>
            <NotePhrases note={tpl.note} onChange={(v) => t('note', v)} />
            <label className="full">Stopka (dół strony)<textarea rows={2} value={tpl.footer ?? tpl.auto_footer} onChange={(e) => t('footer', e.target.value)} placeholder="puste = bez stopki" /></label>
          </fieldset>
          <button className="btn primary" onClick={saveTemplate}>Zapisz szablon</button>
          {msg?.where === 'tpl' && <div className={`banner ${msg.ok ? 'info' : 'error'}`} style={{ marginTop: 10 }}>{msg.text}</div>}
        </div>
      )}

      <div className="panel">
        <div className="special-head">
          <h2 className="panel-title">Wystawione rachunki</h2>
          {canEdit && <button type="button" className="btn small" onClick={() => setOpen({})}>＋ Rachunek bez rezerwacji</button>}
        </div>
        <p className="muted small-note">Rachunek do pobytu wystawisz najwygodniej z rezerwacji: stuknij ją w kalendarzu → „Wystaw rachunek”.</p>
        {list.length === 0 ? <p className="muted">Brak rachunków.</p> : (
          <ul className="history invoice-list">
            {list.map((i) => (
              <li key={i.id}>
                <button type="button" className="history-item" onClick={() => setOpen({ id: i.id })}>
                  <span className="history-kind invoice">{i.number}</span>
                  <span>{i.buyer_name || '—'}{i.check_in ? ` · ${formatShort(i.check_in)}–${formatShort(i.check_out!)}` : ''}</span>
                  <span className="muted">{fmt(i.total, i.currency, true)} · {formatShort(i.issue_date)}</span>
                  <span className="chev">›</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && <InvoiceSheet invoiceId={open.id} onClose={() => setOpen(null)} onChanged={() => setVersion((v) => v + 1)} />}
    </section>
  );
}
