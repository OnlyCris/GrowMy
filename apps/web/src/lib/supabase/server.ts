import { env } from '@growmy/env';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { cache } from 'react';

/**
 * Forma dei cookie che Supabase chiede di scrivere.
 *
 * Il tipo è dichiarato qui invece di essere inferito perché `@supabase/ssr` non
 * lo esporta: senza annotazione, `strict` lo tratta come `any` implicito e il
 * build fallisce. Tipizzarlo a mano è anche più onesto — rende visibile cosa
 * stiamo effettivamente scrivendo nei cookie di sessione.
 */
type CookieToSet = {
  name: string;
  value: string;
  options?: CookieOptions;
};

/**
 * CLIENT SUPABASE LATO SERVER
 *
 * Un'istanza per richiesta, legata ai cookie di quella richiesta. Non è
 * memoizzabile a livello di modulo: due utenti concorrenti condividerebbero la
 * stessa sessione, che è il bug di sicurezza più grave possibile in un SaaS
 * multi-tenant.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, {
                ...options,
                // Il cookie di sessione non deve essere leggibile da JavaScript:
                // riduce l'impatto di un eventuale XSS a zero furto di sessione.
                httpOnly: true,
                secure: env.NODE_ENV === 'production',
                // `lax` consente il ritorno dal redirect OAuth mantenendo la
                // protezione contro le richieste cross-site.
                sameSite: 'lax',
                path: '/',
              });
            }
          } catch {
            /**
             * `cookies().set()` lancia se chiamato da un Server Component.
             * È atteso: in quel contesto il refresh del token è già stato
             * eseguito dal middleware, quindi ignorare è corretto e non
             * produce sessioni scadute.
             */
          }
        },
      },
    },
  );
}

/**
 * Utente autenticato della richiesta corrente, oppure `null`.
 *
 * USA SEMPRE `getUser()`, MAI `getSession()`.
 *
 * `getSession()` legge il JWT dal cookie e si fida del suo contenuto senza
 * verificarne la firma: un cookie contraffatto passerebbe. `getUser()` chiama
 * il server di autenticazione e valida il token. La differenza è fra un
 * controllo di autorizzazione reale e uno decorativo.
 *
 * `cache()` di React deduplica la chiamata all'interno della stessa richiesta:
 * dieci Server Component che chiedono l'utente producono una sola verifica.
 */
export const getAuthenticatedUser = cache(async () => {
  /**
   * Scorciatoia di sviluppo. L'import è DINAMICO di proposito: in un build di
   * produzione questo ramo non viene mai raggiunto, quindi il modulo di bypass
   * non entra nemmeno nel grafo delle dipendenze. E se qualcuno forzasse la
   * variabile in produzione, `dev-session.ts` lancia al proprio import.
   */
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.DEV_AUTH_BYPASS === 'true'
  ) {
    const { getDevUser } = await import('@/lib/auth/dev-session');
    return getDevUser();
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  return {
    id: user.id,
    email: user.email ?? null,
    emailVerified: user.email_confirmed_at !== null,
  };
});

export type AuthenticatedUser = NonNullable<
  Awaited<ReturnType<typeof getAuthenticatedUser>>
>;
