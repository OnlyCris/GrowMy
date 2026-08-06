import 'server-only';

import { db, userPreferences, users } from '@growmy/db';
import { withUserContext } from '@growmy/db/context';
import { cache } from 'react';

import type { AuthenticatedUser } from '@/lib/supabase/server';

/**
 * PROVISIONING DEL PROFILO APPLICATIVO — rimpiazza il trigger `on_auth_user_created`.
 *
 * Quel trigger (rimosso da `0002_deferred_constraints.sql`) avrebbe dovuto
 * creare la riga `public.users` + `user_preferences` a ogni signup Supabase.
 * Impossibile in questo deploy: `auth.users` vive nel progetto Supabase Cloud,
 * `public.users` in un Postgres self-hosted separato — due server fisici
 * distinti, nessun trigger può scavalcarli.
 *
 * Questa funzione fa lo stesso lavoro dall'applicazione. Upsert, non
 * insert-if-missing: aggiorna anche `email`/`lastSeenAt` a ogni chiamata, così
 * un cambio email lato Supabase o un login dopo mesi di inattività restano
 * riflessi qui senza bisogno di un percorso separato.
 *
 * Chiamata da due punti (non ridondanti, coprono percorsi diversi):
 *   - `auth/callback/route.ts`, dopo un `exchangeCodeForSession` riuscito —
 *     copre Google OAuth.
 *   - `onboarding/page.tsx`, in testa — quello che conta davvero: un login
 *     email/password non passa mai dal callback, quindi l'onboarding non può
 *     assumere che il provisioning sia già avvenuto.
 * `cache()` deduplica per richiesta: chiamarla da entrambi i punti nello stesso
 * giro (raro, ma possibile) non fa due upsert.
 *
 * Deliberatamente NON richiamata da `getAuthenticatedUser()`: quella funzione
 * è la base di ogni guard nell'app, e non deve guadagnare una dipendenza da
 * Postgres — né una transazione — sul percorso caldo di ogni richiesta.
 */
export const ensureUserProvisioned = cache(
  async (user: AuthenticatedUser): Promise<void> => {
    await withUserContext(user.id, async () => {
      await db
        .insert(users)
        .values({ id: user.id, email: user.email ?? '', lastSeenAt: new Date() })
        .onConflictDoUpdate({
          target: users.id,
          set: { email: user.email ?? '', lastSeenAt: new Date() },
        });

      await db
        .insert(userPreferences)
        .values({ userId: user.id })
        .onConflictDoNothing();
    });
  },
);
