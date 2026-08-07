import { withUserContext } from '@growmy/db/context';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { requireOrgMembership } from '@/lib/auth/guards';
import { getKeywordsForProduct } from '@/lib/queries/keywords';

import { KeywordsPanel } from './_components/keywords-panel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Keyword',
  robots: { index: false, follow: false },
};

export default async function ProductKeywordsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; productId: string }>;
}) {
  const { orgSlug, productId } = await params;

  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  const keywords = await withUserContext(membership.userId, () =>
    getKeywordsForProduct(productId),
  );

  return (
    <KeywordsPanel
      productId={productId}
      orgSlug={orgSlug}
      initialKeywords={keywords.map((k) => ({
        id: k.id,
        term: k.term,
        status: k.status,
        priorityScore: k.priorityScore,
        clusterId: k.clusterId,
        clusterName: k.clusterName,
        isPillar: k.isPillar,
      }))}
    />
  );
}
