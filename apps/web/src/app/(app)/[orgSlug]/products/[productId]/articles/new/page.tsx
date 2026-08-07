import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgMembership } from '@/lib/auth/guards';

import { ManualArticleForm } from './_components/manual-article-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Nuovo articolo',
  robots: { index: false, follow: false },
};

export default async function NewManualArticlePage({
  params,
}: {
  params: Promise<{ orgSlug: string; productId: string }>;
}) {
  const { orgSlug, productId } = await params;

  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  return (
    <Card>
      <CardHeader>
        <Link
          href={`/${orgSlug}/products/${productId}/articles`}
          className="text-xs text-foreground-muted underline underline-offset-4 hover:no-underline"
        >
          ← Torna agli articoli
        </Link>
        <CardTitle>Scrivi un articolo</CardTitle>
        <CardDescription>
          Entra nella coda di revisione come una bozza generata dall’AI — stesso quality
          score, stessa approvazione prima di pubblicare.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ManualArticleForm orgSlug={orgSlug} productId={productId} />
      </CardContent>
    </Card>
  );
}
