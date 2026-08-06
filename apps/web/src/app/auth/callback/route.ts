import { NextResponse } from 'next/server';

import { ensureUserProvisioned } from '@/lib/auth/provision-user';
import { isSafeRelativePath } from '@/lib/auth/guards';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * CALLBACK OAUTH / MAGIC LINK.
 *
 * Punto di atterraggio unico sia per "Continua con Google" sia per il link
 * ricevuto via email: `@supabase/ssr` usa il flusso PKCE per entrambi, quindi
 * entrambi arrivano qui con lo stesso `?code=` da scambiare per una sessione
 * con `exchangeCodeForSession` — non serve distinguerli.
 *
 * `ensureUserProvisioned` va chiamata qui (oltre che in `/onboarding`, che
 * resta il percorso che conta davvero per il login via email — vedi il
 * commento in `provision-user.ts`) così un utente Google al primo accesso ha
 * già la riga `public.users` prima ancora di atterrare su `/`.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const requestedRedirect = searchParams.get('redirectTo');
  const redirectTo = isSafeRelativePath(requestedRedirect) ? requestedRedirect : '/';

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error && data.user) {
      await ensureUserProvisioned({
        id: data.user.id,
        email: data.user.email ?? null,
        emailVerified: data.user.email_confirmed_at != null,
      });

      return NextResponse.redirect(`${origin}${redirectTo}`);
    }

    logger.warn(
      { err: error?.message },
      'scambio del codice di autenticazione fallito',
    );
  }

  return NextResponse.redirect(`${origin}/signin?error=auth_callback_failed`);
}
