import { forward, type Ctx } from '../../functions-lib/proxy';

// Publiczne API dla strony odmorzadogor.pl: cennik, dostępność i zapytania o rezerwację.
// Bez logowania — serwer zwraca tu tylko ceny i zajęte dni (bez danych gości). Przeglądarka woła je z innej domeny (CORS).

const DEFAULT_ORIGINS = ['https://odmorzadogor.pl', 'https://www.odmorzadogor.pl', 'https://new.odmorzadogor.pl'];

function allowedOrigin(origin: string | null, extra?: string) {
  if (!origin) return null;
  const list = [...DEFAULT_ORIGINS, ...(extra ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  // podglądy strony na Cloudflare Pages (np. abc123.osadajantar.pages.dev) i praca lokalna
  if (list.includes(origin) || /^https:\/\/([\w-]+\.)?osadajantar\.pages\.dev$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

export const onRequest = async (ctx: Ctx & { env: { PUBLIC_ORIGINS?: string } }) => {
  const origin = allowedOrigin(ctx.request.headers.get('origin'), ctx.env.PUBLIC_ORIGINS);
  const cors: Record<string, string> = origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : { Vary: 'Origin' };
  if (ctx.request.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: cors });
  if (!['GET', 'POST'].includes(ctx.request.method)) return Response.json({ error: 'Metoda niedozwolona' }, { status: 405, headers: cors });
  const res = await forward(ctx, true, { publicOnly: true });
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
};
