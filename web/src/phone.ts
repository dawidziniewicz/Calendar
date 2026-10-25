// Link do czatu WhatsApp (wa.me) z numeru gościa; numer bez kierunkowego (9 cyfr) = Polska. Opcjonalnie z gotową wiadomością.
export function whatsappHref(phone: string, text?: string): string | null {
  let digits = phone.trim().replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.length === 9) digits = `48${digits}`;
  digits = digits.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
