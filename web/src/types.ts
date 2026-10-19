export type Feed = { id: number; unit_id: number; source: string; url: string; last_sync_at: string | null; last_error: string | null };
export type Unit = {
  id: number; property_id: number; name: string; capacity: number; color: string; sort: number; export_token: string; feeds: Feed[];
  base_price: number | null; min_nights: number; bookable: number; // cennik i rezerwacje ze strony www
  weekday_prices: string | null; // JSON: 7 cen od niedzieli, null = cena podstawowa
  type_name: string; // typ na stronie (np. „Mały domek”) — takie same domki rezerwowane razem
  type_name_en: string; // ten sam typ po angielsku (np. „Small cottage”)
};
export type Property = {
  id: number; name: string; location: string; address: string; sort: number; units: Unit[];
  // zamknięcie obiektu: bez dat = do odwołania
  closed: number; closed_from: string | null; closed_to: string | null; closed_note: string; closed_note_en: string;
};
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
  cancelled_at?: string | null;
  cancel_reviewed?: number;
  dates_locked?: number;
};

export type Draft = Omit<Reservation, 'id' | 'feed_id' | 'external_uid' | 'external_summary'> & { id?: number; feed_id?: number | null; external_summary?: string | null };

export const SOURCES: Record<string, string> = {
  direct: 'Prywatne',
  website: 'Strona www',
  booking: 'Booking.com',
  airbnb: 'Airbnb',
  other: 'Inne',
};

export const STATUS_LABELS: Record<Status, string> = {
  confirmed: 'Potwierdzona',
  tentative: 'Wstępna',
  cancelled: 'Anulowana',
};

/** Nadpisanie ceny / min. pobytu / blokady na konkretny dzień (noc zaczynająca się tego dnia). */
export type Rate = { unit_id: number; date: string; price: number | null; min_nights: number | null; closed: number };

export type RequestStatus = 'pending' | 'accepted' | 'rejected';
export type BookingRequest = {
  id: number; unit_id: number; unit_name: string; property_name: string;
  check_in: string; check_out: string; guest_name: string; guest_phone: string; guest_email: string;
  adults: number; children: number; message: string; quoted_price: number | null; status: RequestStatus;
  decided_by: string | null; decided_at: string | null; decision_note: string; reservation_id: number | null;
  created_at: string; lang: string;
  expired_at: string | null; // termin minął bez decyzji → archiwum
  cancel_status?: 'requested' | 'confirmed' | 'declined' | null; cancel_requested_at?: string | null; cancel_reason?: string; // prośba gościa o anulację
  extras: string | null; // JSON: wybrane opcje płatne [{ name, price, per, qty, total }]
  group_units: { id: number; name: string; type_name: string; free: boolean }[]; // domki typu do przydziału (pierwszy = proponowany)
  assign_mode?: 'auto' | 'manual';
  conflicts: { id: number; check_in: string; check_out: string; guest_name: string; source: string }[];
};

/** Opcja płatna (parking, zwierzę…) do wyboru przez gościa przy zapytaniu ze strony. */
export type Extra = {
  id: number; name: string; name_en: string; description: string; price: number; per: 'stay' | 'night'; max_qty: number;
  property_ids: string | null; active: number; sort: number;
};
export type ChosenExtra = { id: number; name: string; price: number; per: 'stay' | 'night'; qty: number; total: number };
