import 'server-only';

import {
  auditLogs,
  db,
  organizationMembers,
  organizations,
  userPreferences,
} from '@growmy/db';
import { withUserContext } from '@growmy/db/context';
import { createOrganizationSchema } from '@growmy/validation';
import { eq } from 'drizzle-orm';

import { randomSlugSuffix, slugify } from '@/lib/slug';

import { ActionError } from './_action-result';
import { createBootstrapAction } from './_bootstrap-action';

/**
 * `server-only`, non `'use server'` — stesso motivo di `auth.impl.ts` e
 * `review.impl.ts`: `onboarding.actions.ts` è il confine pubblico sottile,
 * questo file resta fuori dalla superficie invocabile dal client.
 */

export const createOrganization = createBootstrapAction(
  {
    name: 'onboarding.create-organization',
    schema: createOrganizationSchema,
    rateLimit: 'onboarding.create-organization',
    requireAuth: true,
  },
  async ({ input, user, traceId }) => {
    if (!user) {
      // Irraggiungibile in pratica: `requireAuth: true` ha già fermato la
      // richiesta prima di arrivare qui. Il controllo esiste solo per non
      // dover forzare il tipo con `!` più sotto.
      throw new ActionError('UNAUTHENTICATED', 'Sessione scaduta. Accedi di nuovo.');
    }

    /**
     * Un solo `withUserContext`: crea l'organizzazione, la membership owner,
     * segna l'onboarding completato e scrive l'audit, tutto nella STESSA
     * transazione. Non è solo pulizia — è ciò che rende possibile la riga di
     * audit: `audit_logs_insert` verifica che l'organizzazione sia fra quelle
     * dell'utente corrente (`app_current_org_ids()`), e quella funzione la
     * vede solo perché la membership è già stata inserita, nella stessa
     * transazione, un istante prima (Postgres vede le proprie scritture non
     * ancora committate). Due transazioni separate romperebbero questo.
     *
     * Lo slug porta sempre un suffisso casuale, mai un controllo di unicità
     * via SELECT: sotto RLS un utente nuovo non vedrebbe comunque le
     * organizzazioni altrui, quindi quel controllo risulterebbe sempre
     * "libero" — dare l'illusione di una verifica che non verifica nulla è
     * peggio che non farla. Vedi `lib/slug.ts`.
     */
    return withUserContext(user.id, async () => {
      const slug = `${slugify(input.name)}-${randomSlugSuffix()}`;

      const [org] = await db
        .insert(organizations)
        .values({ name: input.name, slug, ownerId: user.id })
        .returning({ id: organizations.id, slug: organizations.slug });

      await db.insert(organizationMembers).values({
        organizationId: org.id,
        userId: user.id,
        role: 'owner',
      });

      await db
        .update(userPreferences)
        .set({ onboardingCompletedAt: new Date() })
        .where(eq(userPreferences.userId, user.id));

      await db.insert(auditLogs).values({
        organizationId: org.id,
        actorUserId: user.id,
        action: 'organization.created',
        targetType: 'organization',
        targetId: org.id,
        metadata: { traceId },
      });

      return { slug: org.slug };
    });
  },
);
