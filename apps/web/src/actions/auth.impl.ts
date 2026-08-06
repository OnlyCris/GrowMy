import 'server-only';

import { env } from '@growmy/env';
import { signInSchema, signUpSchema } from '@growmy/validation';
import { redirect } from 'next/navigation';

import { isSafeRelativePath } from '@/lib/auth/guards';
import { createSupabaseServerClient } from '@/lib/supabase/server';

import { ActionError } from './_action-result';
import { createBootstrapAction } from './_bootstrap-action';

/**
 * IMPLEMENTAZIONE — autenticazione via magic link (Supabase `signInWithOtp`).
 *
 * `server-only`, non `'use server'`: questo modulo NON è il confine pubblico.
 * Vedi `auth.actions.ts` per il motivo (un file `'use server'` espone come
 * endpoint invocabile ogni funzione esportata, `sendMagicLink` compreso se
 * finisse lì per errore).
 *
 * Niente password: `signInAction` e `signUpAction` inviano entrambe un'email
 * con un link di accesso. La sola differenza è `shouldCreateUser`:
 *
 *   - signin: `false` — se l'email non corrisponde a nessun account, Supabase
 *     rifiuta e lo segnaliamo chiaramente ("non trovato, registrati") invece
 *     di far credere che un'email sia partita quando non è successo nulla.
 *   - signup: `true` — se l'account esiste già, Supabase manda comunque il
 *     link (equivale a un accesso): non serve distinguere i due casi lato UI,
 *     "controlla la tua email" è vero in entrambi.
 */

async function sendMagicLink(
  email: string,
  redirectTo: string | undefined,
  shouldCreateUser: boolean,
): Promise<{ email: string }> {
  const safeRedirect = isSafeRelativePath(redirectTo) ? redirectTo : '/';
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser,
      emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback?redirectTo=${encodeURIComponent(safeRedirect)}`,
    },
  });

  if (error) {
    if (!shouldCreateUser) {
      // Il caso più comune per un errore qui, a `shouldCreateUser: false`, è
      // che l'email non corrisponda a nessun account.
      throw new ActionError(
        'NOT_FOUND',
        'Nessun account trovato con questa email. Prova a registrarti.',
      );
    }
    throw new ActionError(
      'INTERNAL_ERROR',
      'Non siamo riusciti a inviare il link di accesso. Riprova fra qualche minuto.',
    );
  }

  return { email };
}

export const signIn = createBootstrapAction(
  { name: 'auth.signin', schema: signInSchema, rateLimit: 'auth.signin', requireAuth: false },
  async ({ input }) => sendMagicLink(input.email, input.redirectTo, false),
);

export const signUp = createBootstrapAction(
  { name: 'auth.signup', schema: signUpSchema, rateLimit: 'auth.signup', requireAuth: false },
  async ({ input }) => sendMagicLink(input.email, input.redirectTo, true),
);

/**
 * Usata direttamente come `action` di un `<form>` (pattern nativo di Next per
 * le Server Action: nessun hook, nessuno stato client, funziona anche senza
 * JavaScript). Non passa da `createBootstrapAction`: non c'è input da validare
 * né un `ActionResult` da restituire — o la sessione finisce e la pagina
 * cambia, o non c'era nulla da terminare.
 */
export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect('/signin');
}
