export type Feed = { id: number; unit_id: number; source: string; url: string; last_sync_at: string | null; last_error: string | null };
export type Unit = { id: number; property_id: number; name: string; capacity: number; color: string; sort: number; export_token: string; feeds: Feed[] };
export type Property = { id: number; name: string; location: string; address: string; sort: number; units: Unit[] };
export type Status = 'confirmed' | 'tentative' | 'cancelled';

export type Reservation = {
  id: number;
  unit_id: number;
  check_in: string;
  check_out: string;
  status: Status;
  source: string;
  feed_id: number | null;
  external_uid: string | null;
  external_summary: string | null;
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  adults: number;
  children: number;
  price: number | null;
  paid: number | null;
  notes: string;
};

export type Draft = Omit<Reservation, 'id' | 'feed_id' | 'external_uid' | 'external_summary'> & { id?: number; feed_id?: number | null; external_summary?: string | null };

export const SOURCES: Record<string, string> = {
  direct: 'Bezpośrednio',
  booking: 'Booking.com',
  airbnb: 'Airbnb',
  other: 'Inne',
};

export const STATUS_LABELS: Record<Status, string> = {
  confirmed: 'Potwierdzona',
  tentative: 'Wstępna',
  cancelled: 'Anulowana',
};
