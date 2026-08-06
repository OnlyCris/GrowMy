'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * CLIENT SUPABASE LATO BROWSER.
 *
 * Serve per un solo motivo: `signInWithOAuth` (Google) fa una navigazione
 * `window.location` verso Google, che deve partire dal browser — un Server
 * Component/Action non può innescarla. Email/password NON passa da qui: gira
 * come Server Action tramite `createSupabaseServerClient()`
 * (`lib/supabase/server.ts`), l'unico contesto in cui l'app può scrivere il
 * cookie di sessione con `httpOnly`.
 *
 * NIENTE IMPORT DI `@growmy/env` QUI — non solo per l'edge runtime (il motivo
 * per cui lo evita `middleware.ts`): il modulo esegue, al proprio livello
 * più esterno, un controllo che "almeno un provider LLM sia configurato",
 * leggendo `env.ANTHROPIC_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY`/ecc. — tutte
 * variabili SERVER-ONLY. Un file `'use client'` che importa `@growmy/env`
 * trascina quel controllo nel bundle del browser, dove gira comunque
 * all'apertura del modulo: la guardia di t3-env lo blocca subito con
 * "Attempted to access a server-side environment variable on the client" —
 * scoperto in produzione su `/signin`, non a compile time, perché nessun tipo
 * lo segnala.
 *
 * `NEXT_PUBLIC_*` letta direttamente da `process.env`: Next.js la inlinea a
 * build time ovunque compaia testualmente nel codice sorgente dell'app,
 * indipendentemente dal pacchetto — stesso approccio già usato da
 * `middleware.ts` per lo stesso motivo di fondo.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
