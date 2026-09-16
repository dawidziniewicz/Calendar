// Proxy z Cloudflare Pages do API na domowym serwerze (przez Cloudflare Tunnel).
// Sekrety ustawiasz w Cloudflare: Workers & Pages → projekt → Settings → Variables and Secrets.

export interface Env {
  API_ORIGIN: string; // np. https://kalendarz-api.odmorzadogor.pl
  API_KEY: string; // ten sam co API_KEY na serwerze
  CF_ACCESS_CLIENT_ID?: string; // service token do aplikacji Access chroniącej API
  CF_ACCESS_CLIENT_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string; // np. odmorzadogor.cloudflareaccess.com
  ACCESS_AUD?: string; // "Application Audience (AUD) Tag" aplikacji Access (kilka rozdziel przecinkami)
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
  if (withApiKey) headers.set('x-api-key', env.API_KEY);
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

// ---- Weryfikacja logowania Cloudflare Access (obrona także dla adresów *.pages.dev) ----

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
let keysCache: { at: number; keys: Record<string, CryptoKey> } | null = null;

async function accessKeys(team: string) {
  if (keysCache && Date.now() - keysCache.at < 3600_000) return keysCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const out: Record<string, CryptoKey> = {};
  for (const k of keys) {
    out[k.kid] = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  keysCache = { at: Date.now(), keys: out };
  return out;
}

export async function verifyAccess(request: Request, env: Env): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return 'Brak konfiguracji ACCESS_TEAM_DOMAIN / ACCESS_AUD';
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return 'Brak logowania Cloudflare Access';
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
    const key = (await accessKeys(env.ACCESS_TEAM_DOMAIN))[header.kid];
    if (!key) return 'Nieznany klucz';
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return 'Nieprawidłowy podpis';
    const auds = env.ACCESS_AUD.split(',').map((a) => a.trim());
    const tokenAud: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!tokenAud.some((a) => auds.includes(a))) return 'Nieprawidłowe AUD';
    if (payload.exp * 1000 < Date.now()) return 'Sesja wygasła';
    return null;
  } catch {
    return 'Nieprawidłowy token';
  }
}
