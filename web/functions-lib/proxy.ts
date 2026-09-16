// Proxy z Cloudflare Pages do API na domowym serwerze (przez Cloudflare Tunnel).
// Sekrety ustawiasz w Cloudflare: Workers & Pages → projekt → Settings → Variables and Secrets.

export interface Env {
  API_ORIGIN: string; // np. https://kalendarz-api.odmorzadogor.pl
  API_KEY: string; // ten sam co API_KEY na serwerze
  CF_ACCESS_CLIENT_ID?: string; // service token do aplikacji Access chroniącej API
  CF_ACCESS_CLIENT_SECRET?: string;
}

export type Ctx = { request: Request; env: Env };

export async function forward({ request, env }: Ctx, withApiKey: boolean): Promise<Response> {
  if (!env.API_ORIGIN) return new Response('Brak konfiguracji API_ORIGIN', { status: 500 });
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.API_ORIGIN);
  const headers = new Headers();
  for (const name of ['content-type', 'accept']) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  if (withApiKey) {
    headers.set('x-api-key', env.API_KEY);
    // sesja logowania (ciasteczko), adres IP do blokady zgadywania haseł, https dla flagi Secure
    const cookie = request.headers.get('cookie');
    if (cookie) headers.set('cookie', cookie);
    headers.set('x-client-ip', request.headers.get('cf-connecting-ip') ?? '');
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  }
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID);
    headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET);
  }
  try {
    const res = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
    });
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  } catch {
    return Response.json({ error: 'Serwer domowy nie odpowiada' }, { status: 502 });
  }
}
