import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgMembership } from '@/lib/auth/guards';

import { CreateProductForm } from './_components/create-product-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Aggiungi sito',
  robots: { index: false, follow: false },
};

export default async function NewProductPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  return (
    <main className="mx-auto flex w-full max-w-md flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Aggiungi un sito</CardTitle>
          <CardDescription>
            Solo l&rsquo;essenziale per iniziare — lingua, orario di
            pubblicazione e regole di approvazione si configurano subito dopo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateProductForm
            organizationId={membership.organizationId}
            orgSlug={orgSlug}
          />
        </CardContent>
      </Card>
    </main>
  );
}
