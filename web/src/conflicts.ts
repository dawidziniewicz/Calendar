import type { Reservation } from './types';

/** Id rezerwacji, które nakładają się z inną (nieanulowaną) w tym samym domku. */
export function conflictIds(reservations: Reservation[]): Set<number> {
  const byUnit = new Map<number, Reservation[]>();
  for (const r of reservations) {
    if (r.status === 'cancelled') continue;
    byUnit.set(r.unit_id, [...(byUnit.get(r.unit_id) ?? []), r]);
  }
  const ids = new Set<number>();
  for (const list of byUnit.values()) {
    for (const a of list) for (const b of list) {
      if (a.id < b.id && a.check_in < b.check_out && b.check_in < a.check_out) { ids.add(a.id); ids.add(b.id); }
    }
  }
  return ids;
}
