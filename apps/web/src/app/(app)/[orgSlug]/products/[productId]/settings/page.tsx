import { withUserContext } from '@growmy/db/context';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgMembership } from '@/lib/auth/guards';
import { getProductById } from '@/lib/queries/products';

import { ProductSettingsForm } from './_components/product-settings-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Impostazioni prodotto',
  robots: { index: false, follow: false },
};

interface ProductSettingsPageProps {
  params: Promise<{ orgSlug: string; productId: string }>;
}

export default async function ProductSettingsPage({ params }: ProductSettingsPageProps) {
  const { orgSlug, productId } = await params;

  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  const product = await withUserContext(membership.userId, () =>
    getProductById(membership.organizationId, productId),
  );
  if (!product) notFound();

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{product.name}</CardTitle>
          <CardDescription>{product.domain}</CardDescription>
        </CardHeader>
        <CardContent>
          <ProductSettingsForm product={product} />
        </CardContent>
      </Card>
    </main>
  );
}
