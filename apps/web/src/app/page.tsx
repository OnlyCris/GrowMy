import { db, organizationMembers, organizations } from '@growmy/db';
import { and, eq, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { getAuthenticatedUser } from '@/lib/supabase/server';

/**
 * Radice dell'applicazione: smista l'utente verso la sua organizzazione.
 *
 * Non è una landing page — quella vive nel gruppo di route `(marketing)`.
 * Qui decidiamo soltanto dove mandare chi arriva su `/`.
 */
export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const user = await getAuthenticatedUser();

  if (!user) redirect('/signin');

  // Prima organizzazione di cui l'utente è membro. Con più organizzazioni
  // servirebbe un selettore; per ora la prima è la scelta ragionevole.
  const [membership] = await db
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
    .limit(1);

  // Utente autenticato senza organizzazione: è il caso del primo accesso.
  if (!membership) redirect('/onboarding');

  redirect(`/${membership.slug}/review`);
}
