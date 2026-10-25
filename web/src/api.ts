import type {
  Activity, BookingRequest, Draft, Extra, Invoice, InvoiceData, InvoiceListItem, InvoiceTemplate, MessageKind, Offer, PaymentSettings, Property, Rate, Reservation, UnitExtra,
} from './types';

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, data: Record<string, unknown>) {
    super(typeof data.error === 'string' ? data.error : `Błąd ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, { error: 'Brak połączenia z internetem' });
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status || 500, { error: `Serwer zwrócił nieoczekiwaną odpowiedź (HTTP ${res.status}). Sprawdź konfigurację API_ORIGIN / tunelu.` });
  }
  if (res.status === 401 && data.code === 'unauthenticated') window.dispatchEvent(new Event('auth:required'));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** PDF (podgląd rachunku) jako Blob */
async function pdf(method: string, path: string, body?: unknown): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: 'Brak połączenia z internetem' });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) window.dispatchEvent(new Event('auth:required'));
    throw new ApiError(res.status, data);
  }
  return res.blob();
}

export type MailThread = {
  id: number; mailbox: string; subject: string; counterpart: string; counterpart_name: string; last_at: string; snippet: string;
  unread: number; message_count: number; has_attachments: number; archived: number;
};
export type MailMessage = {
  id: number; thread_id: number; mailbox: string; direction: 'in' | 'out'; from_addr: string; from_name: string; to_addrs: string[]; cc_addrs: string[];
  subject: string; text: string; html: string; date: string; is_read: number; sent_by: string;
  attachments: { id: number; filename: string; content_type: string; size: number; content_id: string }[];
};
export type MailThreadDetail = {
  thread: MailThread; messages: MailMessage[];
  reservations: { id: number; check_in: string; check_out: string; status: string; guest_name: string; unit_name: string; property_name: string }[];
  requests: { id: number; check_in: string; check_out: string; status: string; created_at: string }[];
};
export type MailSummary = { allowed: boolean; mailboxes: string[]; reply_to: 'auto' | 'inbox' | 'admin'; last_inbound: string | null; sending: boolean; unread: number };
export type OfferInput = { currency?: string; price: number; deposit?: number | null; deposit_due?: string | null; valid_until?: string | null; message?: string; email?: boolean; unit_id?: number; lang?: string };
export type MessageInput = { kind: MessageKind; subject?: string; body?: string; amount?: number | null; due?: string | null; title?: string; lang?: string };
export type MessageDraft = { lang: string; subject: string; body: string; amount: number | null; due: string | null; title: string; has_account: boolean; default_deposit: { amount: number | null; due: string | null } };

export type PushSettings = { time: string; changes: boolean; requests: boolean; mail: boolean };
export type HorizonAfter = 'ask' | 'closed';
export type BookingSettings = { horizon_days: number; horizon_until: string | null; horizon_last: string; default_days: number; assign_mode: 'auto' | 'manual'; horizon_after: HorizonAfter };
export type ExtraInput = {
  name: string; name_en: string; description: string; price: number; per: 'stay' | 'night'; max_qty: number; property_ids: number[] | null; active: boolean;
  required: boolean; price_overrides: Record<string, number> | null;
};
export type EmailNotify = { requests: boolean; cancellations: boolean; offers: boolean; guest_receipt: boolean };
export type EmailSettings = { configured: boolean; kind: 'resend' | 'smtp' | 'log' | null; from: string | null; emails: string; notify: EmailNotify };
/** price/min_nights: liczba = ustaw, null = przywróć ustawienie domku, brak = bez zmian */
export type RatePatch = { unit_ids: number[]; from: string; to: string; weekdays?: number[]; price?: number | null; min_nights?: number | null; closed?: boolean };
/** properties: nazwy obiektów, do których konto ma dostęp (null = wszystkie). */
export type Session = { username: string; role: 'admin' | 'viewer'; properties: string[] | null; canManageUsers: boolean };
/** properties: id obiektów (null = wszystkie). */
export type AppUser = { id: number; username: string; role: 'admin' | 'viewer'; properties: number[] | null; created_at: string; me?: boolean };
export type UserInput = { role: 'admin' | 'viewer'; properties: number[] | null };
export type SyncResult = { feedId: number; unitId: number; ok: boolean; added: number; updated: number; cancelled: number; error?: string };
export type Guest = { guest_name: string; guest_phone: string; guest_email: string; last_stay: string; stays: number };

export const api = {
  me: () => request<Session>('GET', '/auth/me'),
  login: (username: string, password: string) => request<Session>('POST', '/auth/login', { username, password }),
  logout: () => request('POST', '/auth/logout'),
  changePassword: (current: string, next: string) => request('POST', '/auth/password', { current, next }),
  properties: () => request<Property[]>('GET', '/properties'),
  createProperty: (p: { name: string; location?: string; address?: string }) => request<{ id: number }>('POST', '/properties', p),
  updateProperty: (id: number, p: { name: string; location: string; address: string }) => request('PUT', `/properties/${id}`, p),
  deleteProperty: (id: number) => request('DELETE', `/properties/${id}`),
  createUnit: (u: { property_id: number; name: string; capacity: number; color: string }) => request<{ id: number }>('POST', '/units', u),
  updateUnit: (id: number, u: { name: string; capacity: number; color: string }) => request('PUT', `/units/${id}`, u),
  deleteUnit: (id: number) => request('DELETE', `/units/${id}`),
  regenerateToken: (id: number) => request('POST', `/units/${id}/regenerate-token`),
  createFeed: (f: { unit_id: number; source: string; url: string }) => request('POST', '/feeds', f),
  deleteFeed: (id: number) => request('DELETE', `/feeds/${id}`),
  updateFeed: (id: number, url: string) => request('PUT', `/feeds/${id}`, { url }),
  sync: () => request<SyncResult[]>('POST', '/sync'),
  reservation: (id: number) => request<Reservation>('GET', `/reservations/${id}`),
  reservations: (from: string, to: string, cancelled = false) =>
    request<Reservation[]>('GET', `/reservations?from=${from}&to=${to}${cancelled ? '&cancelled=1' : ''}`),
  saveReservation: (r: Draft, force = false) =>
    r.id ? request<Reservation>('PUT', `/reservations/${r.id}`, { ...r, force }) : request<Reservation>('POST', '/reservations', { ...r, force }),
  deleteReservation: (id: number) => request('DELETE', `/reservations/${id}`),
  pushPublicKey: () => request<{ publicKey: string }>('GET', '/push/public-key'),
  pushSubscribe: (subscription: PushSubscriptionJSON) => request('POST', '/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint: string) => request('POST', '/push/unsubscribe', { endpoint }),
  pushTest: () => request<{ sent: number }>('POST', '/push/test'),
  pushSettings: () => request<PushSettings>('GET', '/push/settings'),
  savePushSettings: (patch: Partial<PushSettings>) => request<PushSettings>('PUT', '/push/settings', patch),
  users: () => request<AppUser[]>('GET', '/users'),
  createUser: (u: UserInput & { username: string; password: string }) => request<AppUser>('POST', '/users', u),
  updateUser: (id: number, u: UserInput) => request<AppUser>('PUT', `/users/${id}`, u),
  setUserPassword: (id: number, password: string) => request('POST', `/users/${id}/password`, { password }),
  deleteUser: (id: number) => request('DELETE', `/users/${id}`),
  bookingCancellations: () => request<Reservation[]>('GET', '/booking-cancellations'),
  convertToDirect: (id: number, force = false) => request<Reservation>('POST', `/reservations/${id}/convert-direct`, { force }),
  reviewCancellation: (id: number) => request<Reservation>('POST', `/reservations/${id}/review-cancellation`),
  rates: (from: string, to: string) => request<Rate[]>('GET', `/rates?from=${from}&to=${to}`),
  saveRates: (patch: RatePatch) => request<{ changed: number }>('PUT', '/rates', patch),
  saveUnitPricing: (id: number, p: { base_price: number | null; min_nights: number; bookable: boolean; weekday_prices?: (number | null)[]; type_name?: string; type_name_en?: string }) => request('PUT', `/rates/unit/${id}`, p),
  saveClosure: (propertyId: number, c: { closed: boolean; from: string | null; to: string | null; note: string; note_en: string }) => request('PUT', `/rates/property/${propertyId}/closure`, c),
  extras: () => request<Extra[]>('GET', '/extras'),
  saveExtra: (e: ExtraInput, id?: number) => (id ? request<Extra>('PUT', `/extras/${id}`, e) : request<Extra>('POST', '/extras', e)),
  deleteExtra: (id: number) => request('DELETE', `/extras/${id}`),
  unitExtras: (unitId: number) => request<UnitExtra[]>('GET', `/units/${unitId}/extras`),
  setHorizon: (b: { property_id?: number; unit_ids?: number[]; until?: string | null; after?: HorizonAfter | null }) => request<{ ok: boolean }>('PUT', '/settings/horizon', b),
  bookingSettings: () => request<BookingSettings>('GET', '/settings/booking'),
  saveBookingSettings: (patch: Partial<Pick<BookingSettings, 'horizon_days' | 'horizon_until' | 'assign_mode' | 'horizon_after'>>) => request<BookingSettings>('PUT', '/settings/booking', patch),
  requests: (status: 'pending' | 'decided') => request<BookingRequest[]>('GET', `/requests?status=${status}`),
  acceptRequest: (id: number, body: { price?: number | null; note?: string; email?: boolean; force?: boolean; unit_id?: number; deposit?: number | null; deposit_due?: string | null }) =>
    request<{ request: BookingRequest; reservation: Reservation; emailed: boolean }>('POST', `/requests/${id}/accept`, body),
  cancellations: () => request<BookingRequest[]>('GET', '/cancellations'),
  cancelConfirm: (id: number, body: { note?: string; email?: boolean }) => request<{ ok: boolean; emailed: boolean }>('POST', `/requests/${id}/cancel-confirm`, body),
  cancelDecline: (id: number, body: { note?: string; email?: boolean }) => request<{ ok: boolean; emailed: boolean }>('POST', `/requests/${id}/cancel-decline`, body),
  requestPreview: (id: number, body: { action: 'accept' | 'reject'; price?: number | null; note?: string; unit_id?: number; deposit?: number | null; deposit_due?: string | null }) =>
    request<{ subject: string; html: string }>('POST', `/requests/${id}/preview`, body),
  rejectRequest: (id: number, body: { note?: string; email?: boolean }) => request<{ request: BookingRequest; emailed: boolean }>('POST', `/requests/${id}/reject`, body),
  emailSettings: () => request<EmailSettings>('GET', '/settings/email'),
  saveEmailSettings: (emails: string) => request<EmailSettings>('PUT', '/settings/email', { emails }),
  saveEmailNotify: (notify: Partial<EmailNotify>) => request<EmailSettings>('PUT', '/settings/email', { notify }),
  testEmail: () => request<{ sent: number }>('POST', '/settings/email/test'),
  mailSummary: () => request<MailSummary>('GET', '/mail/summary'),
  saveMailSettings: (s: { mailboxes?: string[]; reply_to?: string }) => request<MailSummary>('PUT', '/mail/settings', s),
  mailThreads: (o: { mailbox?: string; q?: string; archived?: boolean } = {}) => {
    const q = new URLSearchParams({ ...(o.mailbox ? { mailbox: o.mailbox } : {}), ...(o.q ? { q: o.q } : {}), ...(o.archived ? { archived: '1' } : {}) });
    return request<MailThread[]>('GET', `/mail/threads?${q}`);
  },
  mailThread: (id: number) => request<MailThreadDetail>('GET', `/mail/threads/${id}`),
  mailThreadState: (id: number, s: { archived?: boolean; read?: boolean }) => request<MailThread>('POST', `/mail/threads/${id}/state`, s),
  deleteMailThread: (id: number) => request('DELETE', `/mail/threads/${id}`),
  sendMail: (m: { from: string; to: string; cc?: string; subject?: string; text: string; thread_id?: number; quote?: boolean }) =>
    request<{ ok: boolean; thread_id: number | null }>('POST', '/mail/send', m),
  mailAttachmentUrl: (id: number, download = false) => `/api/mail/attachments/${id}${download ? '?download=1' : ''}`,
  guests: (q: string) => request<Guest[]>('GET', `/guests?q=${encodeURIComponent(q)}`),
  setUnitType: (id: number, typeName: string) => request<{ type_name: string }>('PUT', `/rates/unit/${id}/type`, { type_name: typeName }),
  renameType: (unitId: number, typeName: string, typeNameEn: string) => request('PUT', '/rates/type', { unit_id: unitId, type_name: typeName, type_name_en: typeNameEn }),
  // oferty cenowe
  requestOffer: (id: number, o: OfferInput) => request<{ offer: Offer; emailed: boolean }>('POST', `/requests/${id}/offers`, o),
  reservationOffer: (id: number, o: OfferInput) => request<{ offer: Offer; emailed: boolean }>('POST', `/reservations/${id}/offers`, o),
  offerPreview: (kind: 'request' | 'reservation', id: number, o: OfferInput) =>
    request<{ subject: string; html: string }>('POST', `/${kind === 'request' ? 'requests' : 'reservations'}/${id}/offers/preview`, o),
  withdrawOffer: (id: number) => request<Offer>('POST', `/offers/${id}/withdraw`),
  // wiadomości do gościa
  activity: (id: number) => request<Activity>('GET', `/reservations/${id}/activity`),
  messageDraft: (id: number, kind: MessageKind, o: { amount?: number | null; due?: string | null; lang?: string } = {}) => {
    const q = new URLSearchParams({ kind });
    if (o.amount !== undefined) q.set('amount', o.amount == null ? '' : String(o.amount));
    if (o.due !== undefined) q.set('due', o.due ?? '');
    if (o.lang) q.set('lang', o.lang);
    return request<MessageDraft>('GET', `/reservations/${id}/messages/draft?${q}`);
  },
  messagePreview: (id: number, m: MessageInput) => request<{ subject: string; html: string }>('POST', `/reservations/${id}/messages/preview`, m),
  cancelUnpaid: (id: number, body: { email: boolean; subject?: string; body?: string }) =>
    request<{ ok: boolean; emailed: boolean; reservation: Reservation }>('POST', `/reservations/${id}/cancel-unpaid`, body),
  sendMessage: (id: number, m: MessageInput) => request<{ ok: boolean; reservation: Reservation }>('POST', `/reservations/${id}/messages`, m),
  // płatności i rachunki
  paymentSettings: () => request<PaymentSettings>('GET', '/settings/payments'),
  savePaymentSettings: (p: PaymentSettings) => request<PaymentSettings>('PUT', '/settings/payments', p),
  invoiceTemplate: () => request<InvoiceTemplate>('GET', '/settings/invoice'),
  saveInvoiceTemplate: (t: Partial<InvoiceTemplate>) => request<InvoiceTemplate>('PUT', '/settings/invoice', t),
  invoices: (reservationId?: number) => request<InvoiceListItem[]>('GET', `/invoices${reservationId ? `?reservation_id=${reservationId}` : ''}`),
  invoiceDraft: (reservationId?: number, currency?: string) => request<InvoiceData>('GET', `/invoices/draft?${new URLSearchParams({ ...(reservationId ? { reservation_id: String(reservationId) } : {}), ...(currency ? { currency } : {}) })}`),
  invoice: (id: number) => request<Invoice>('GET', `/invoices/${id}`),
  saveInvoice: (inv: InvoiceData & { save_template?: boolean }, id?: number) => (id ? request<Invoice>('PUT', `/invoices/${id}`, inv) : request<Invoice>('POST', '/invoices', inv)),
  deleteInvoice: (id: number) => request('DELETE', `/invoices/${id}`),
  sendInvoice: (id: number, body: { to?: string; body?: string } = {}) => request<{ ok: boolean; to: string }>('POST', `/invoices/${id}/send`, body),
  invoicePdf: (id: number) => pdf('GET', `/invoices/${id}/pdf`),
  invoicePreview: (inv: InvoiceData) => pdf('POST', '/invoices/preview', inv),
  invoicePdfUrl: (id: number, download = false) => `/api/invoices/${id}/pdf${download ? '?download=1' : ''}`,
};
