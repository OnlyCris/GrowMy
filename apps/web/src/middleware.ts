import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * NIENTE IMPORT DI `@growmy/env` QUI.
 *
 * Il middleware di Next gira in EDGE RUNTIME, che non ha accesso ai moduli
 * Node. `@growmy/env` usa `dotenv`, che importa `node:fs` e `node:path`:
 * l'import fa esplodere il middleware con `node-module-in-edge-runtime`, e
 * poiché il middleware intercetta OGNI richiesta, l'intera applicazione
 * risponde 500 — anche gli endpoint di health.
 *
 * Leggiamo quindi `process.env` direttamente. Le `NEXT_PUBLIC_*` sono inlinee
 * dal bundler in fase di build, quindi qui sono valori letterali e non lookup
 * a runtime. La validazione con Zod avviene comunque nel resto dell'app, che
 * gira in runtime Node.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Hostname dell'app stessa, per distinguere il traffico verso la dashboard da
 * quello verso un dominio blog personalizzato (`products.blog_domain`, es.
 * "blog.menuisland.it") — entrambi arrivano allo stesso processo Next.js
 * dietro la Caddy dell'host, che li smista solo per TLS/porta, non per
 * contenuto (vedi `docker/caddy/blog.menuisland.it.caddy`).
 */
const APP_HOSTNAME = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').hostname;
  } catch {
    return '';
  }
})();

/** Forma dei cookie che Supabase chiede di scrivere. Vedi lib/supabase/server.ts. */
type CookieToSet = {
  name: string;
  value: string;
  options?: CookieOptions;
};

/**
 * MIDDLEWARE — sicurezza degli header e refresh della sessione.
 *
 * Due responsabilità, entrambe da eseguire prima di ogni richiesta:
 *
 *  1. REFRESH DELLA SESSIONE. I Server Component non possono scrivere cookie,
 *     quindi il rinnovo del token deve avvenire qui. Senza, le sessioni
 *     scadrebbero silenziosamente e l'utente verrebbe sloggato a metà lavoro.
 *
 *  2. SECURITY HEADERS, in particolare una CSP con nonce. È l'ultima linea di
 *     difesa contro l'XSS: anche se un payload riuscisse a entrare nel DOM, il
 *     browser rifiuterebbe di eseguirlo perché privo del nonce di questa
 *     specifica risposta.
 */

export async function middleware(request: NextRequest) {
  /**
   * Nonce per richiesta. Deve essere imprevedibile: un nonce statico o
   * derivabile rende la CSP decorativa.
   */
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  // --- 0. Dominio blog personalizzato ---------------------------------------
  // Stessa app, stessa porta — la Caddy dell'host smista blog.menuisland.it
  // qui per TLS, non per contenuto (vedi docker/caddy/blog.menuisland.it.caddy).
  // Il contenuto lo decide questo controllo sull'header Host.
  //
  // `/api/health` e `/api/ready` sono ESCLUSI a prescindere dall'host: li
  // interroga l'healthcheck Docker con `fetch('http://127.0.0.1:3000/...')`,
  // Host "127.0.0.1", diverso da APP_HOSTNAME — senza questa esclusione
  // finivano riscritti verso `/sites/127.0.0.1/api/ready`, un 404, e il
  // container veniva segnato "unhealthy" pur essendo perfettamente
  // funzionante. Stessa ragione per cui la Caddy del dominio blog li blocca
  // già dall'esterno: non sono contenuto pubblico, sono infrastruttura.
  const hostname = request.headers.get('host')?.split(':')[0]?.toLowerCase() ?? '';
  const isHealthCheck =
    request.nextUrl.pathname === '/api/health' || request.nextUrl.pathname === '/api/ready';
  const isBlogDomain =
    !isHealthCheck &&
    Boolean(hostname) &&
    hostname !== APP_HOSTNAME &&
    hostname !== 'localhost' &&
    hostname !== '127.0.0.1';

  if (isBlogDomain) {
    // Nessuna sessione Supabase da rinnovare: i cookie dell'app sono legati
    // al SUO dominio, non arrivano mai qui su un dominio diverso. Si
    // riscrive dritti verso le route pubbliche, che risolvono il dominio in
    // un prodotto reale via DB (lib/queries/blog.ts) — impossibile
    // dall'edge runtime in cui gira questo middleware.
    const url = request.nextUrl.clone();
    url.pathname = `/sites/${hostname}${request.nextUrl.pathname}`;
    response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  } else {
    // --- 1. Refresh della sessione -------------------------------------------
    const supabase = createServerClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet: CookieToSet[]) {
            for (const { name, value } of cookiesToSet) {
              request.cookies.set(name, value);
            }
            response = NextResponse.next({ request: { headers: requestHeaders } });
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, {
                ...options,
                httpOnly: true,
                secure: IS_PRODUCTION,
                sameSite: 'lax',
                path: '/',
              });
            }
          },
        },
      },
    );

    /**
     * `getUser()` e non `getSession()`: verifica la firma del token contro il
     * server di autenticazione e, come effetto collaterale, lo rinnova se sta
     * per scadere. Il valore non serve qui — serve la validazione.
     */
    await supabase.auth.getUser();
  }

  // --- 2. Security headers --------------------------------------------------
  const isDev = !IS_PRODUCTION;

  /**
   * `'strict-dynamic'` consente agli script già fidati (quelli con il nonce) di
   * caricarne altri, che è come funziona il chunk loading di Next.js.
   *
   * `'unsafe-eval'` compare solo in sviluppo: React Refresh lo richiede. In
   * produzione è assente, ed è il punto in cui una CSP diventa utile davvero.
   */
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval'" : ''}`,
    // Tailwind inietta stili a runtime: 'unsafe-inline' sugli stili è
    // inevitabile e a basso rischio (non consente esecuzione di codice).
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: https:`,
    `font-src 'self' data:`,
    // Connessioni in uscita limitate a Supabase e all'origine stessa.
    `connect-src 'self' ${SUPABASE_URL} ${isDev ? 'ws: wss:' : ''}`,
    // Nessun plugin, nessun iframe, nessun applet.
    `object-src 'none'`,
    // Impedisce l'iniezione di un <base> che dirotterebbe gli URL relativi.
    `base-uri 'self'`,
    // Le form non possono postare verso domini esterni.
    `form-action 'self'`,
    // Difesa contro il clickjacking, versione moderna di X-Frame-Options.
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ]
    .filter(Boolean)
    .join('; ');

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);

  // Legacy, per i browser che non implementano frame-ancestors.
  response.headers.set('X-Frame-Options', 'DENY');
  // Impedisce al browser di indovinare il MIME type e trattare un upload come script.
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // Non far trapelare l'URL interno verso siti terzi.
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Nega esplicitamente API sensibili che l'applicazione non usa.
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );

  if (IS_PRODUCTION) {
    // HSTS con preload: dopo la prima visita il browser rifiuta HTTP.
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }

  return response;
}

export const config = {
  matcher: [
    /**
     * Esclude asset statici e immagini: applicare la CSP e un round-trip di
     * autenticazione a ogni file di build sarebbe puro spreco.
     *
     * I webhook sono esclusi separatamente: hanno la propria autenticazione
     * per firma HMAC e non devono passare dal refresh della sessione.
     */
    {
      source:
        '/((?!_next/static|_next/image|favicon.ico|api/webhooks|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
