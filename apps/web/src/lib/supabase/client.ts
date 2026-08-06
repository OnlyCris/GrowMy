'use client';

import { env } from '@growmy/env';
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
 * Sicuro importare `@growmy/env` qui (a differenza di `middleware.ts`, che lo
 * evita per motivi di edge runtime): questo file gira solo nel bundle browser
 * o in Node durante l'SSR, mai in edge.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
