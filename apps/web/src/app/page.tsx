import { db, organizationMembers, organizations } from '@growmy/db';
import { withUserContext } from '@growmy/db/context';
import { and, eq, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { MarketingLanding } from '@/components/marketing/landing';
import { getAuthenticatedUser } from '@/lib/supabase/server';

/**
 * Radice dell'applicazione.
 *
 * Anonimo: la landing di marketing (niente route group `(marketing)` a parte —
 * collideerebbe con questo stesso `page.tsx`, entrambi risolverebbero `/`).
 * Autenticato: smista verso la sua organizzazione, senza mai mostrare la landing.
 */
export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const user = await getAuthenticatedUser();

  if (!user) return <MarketingLanding />;

  // Prima organizzazione di cui l'utente è membro. Con più organizzazioni
  // servirebbe un selettore; per ora la prima è la scelta ragionevole.
  const [membership] = await withUserContext(user.id, () =>
    db
      .select({ slug: organizations.slug })
      .from(organizationMembers)
      .innerJoin(
        organizations,
        eq(organizations.id, organizationMembers.organizationId),
      )
      .where(
        and(
          eq(organizationMembers.userId, user.id),
          isNull(organizations.deletedAt),
        ),
      )
      .limit(1),
  );

  // Utente autenticato senza organizzazione: è il caso del primo accesso.
  if (!membership) redirect('/onboarding');

  redirect(`/${membership.slug}/review`);
}
