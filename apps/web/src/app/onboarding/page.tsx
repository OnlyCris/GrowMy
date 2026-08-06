import { db, organizationMembers, organizations } from '@growmy/db';
import { withUserContext } from '@growmy/db/context';
import { and, eq, isNull } from 'drizzle-orm';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ensureUserProvisioned } from '@/lib/auth/provision-user';
import { requireSession } from '@/lib/auth/guards';
import { getAuthenticatedUser } from '@/lib/supabase/server';

import { OnboardingForm } from './_components/onboarding-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Crea la tua organizzazione',
  robots: { index: false, follow: false },
};

export default async function OnboardingPage() {
  // Redirige a `/signin?redirectTo=/onboarding` se non c'è sessione.
  await requireSession('/onboarding');

  const user = await getAuthenticatedUser();
  if (!user) redirect('/signin?redirectTo=/onboarding'); // difensivo: vedi sopra

  /**
   * Punto di provisioning che conta davvero (vedi `provision-user.ts`): un
   * login via magic link non passa mai da `auth/callback` come route
   * separata nel senso classico OAuth — in pratica ci passa comunque (stesso
   * scambio PKCE), ma non possiamo assumerlo qui. Idempotente: costa poco
   * chiamarla anche se il callback l'ha già fatto.
   */
  await ensureUserProvisioned(user);

  const [existing] = await withUserContext(user.id, () =>
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

  // Chi ha già un'organizzazione non deve poterne creare una seconda solo
  // rivisitando questa pagina.
  if (existing) redirect(`/${existing.slug}/review`);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Crea la tua organizzazione</CardTitle>
          <CardDescription>
            È lo spazio dove vivono i tuoi prodotti, articoli e integrazioni.
            Puoi rinominarla in seguito.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OnboardingForm />
        </CardContent>
      </Card>
    </main>
  );
}
