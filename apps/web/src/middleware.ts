import { env } from '@growmy/env';
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

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

  // --- 1. Refresh della sessione -------------------------------------------
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request: { headers: requestHeaders } });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, {
              ...options,
              httpOnly: true,
              secure: env.NODE_ENV === 'production',
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

  // --- 2. Security headers --------------------------------------------------
  const isDev = env.NODE_ENV === 'development';

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
    `connect-src 'self' ${env.NEXT_PUBLIC_SUPABASE_URL} ${isDev ? 'ws: wss:' : ''}`,
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

  if (env.NODE_ENV === 'production') {
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
