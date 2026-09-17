import type { Draft, Property, Reservation } from './types';

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

export type PushSettings = { time: string; changes: boolean };
export type Session = { username: string; role: 'admin' | 'viewer' };
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
  bookingCancellations: () => request<Reservation[]>('GET', '/booking-cancellations'),
  convertToDirect: (id: number, force = false) => request<Reservation>('POST', `/reservations/${id}/convert-direct`, { force }),
  reviewCancellation: (id: number) => request<Reservation>('POST', `/reservations/${id}/review-cancellation`),
  guests: (q: string) => request<Guest[]>('GET', `/guests?q=${encodeURIComponent(q)}`),
};
