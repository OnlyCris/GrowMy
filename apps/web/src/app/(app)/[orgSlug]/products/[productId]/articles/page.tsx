import { withUserContext } from '@growmy/db/context';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { StatusBadge } from '@/components/shared/status-badge';
import { requireOrgMembership } from '@/lib/auth/guards';
import { getArticlesForProduct } from '@/lib/queries/articles';
import { formatRelativeTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Articoli',
  robots: { index: false, follow: false },
};

export default async function ProductArticlesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; productId: string }>;
}) {
  const { orgSlug, productId } = await params;

  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  const items = await withUserContext(membership.userId, () =>
    getArticlesForProduct(productId),
  );

  if (items.length === 0) {
    return (
      <p className="text-sm text-foreground-muted">
        Nessun articolo ancora. Vai su{' '}
        <Link
          href={`/${orgSlug}/products/${productId}/keywords`}
          className="text-info-700 underline underline-offset-4 hover:no-underline"
        >
          Keyword
        </Link>{' '}
        e genera il primo.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border rounded-[var(--radius-lg)] border border-border">
      {items.map((article) => (
        <li key={article.id}>
          <Link
            href={`/${orgSlug}/products/${productId}/articles/${article.id}`}
            className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-muted"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {article.title ?? article.keywordTerm ?? 'Senza titolo'}
              </p>
              <p className="text-xs text-foreground-muted">
                {article.wordCount ? `${article.wordCount} parole · ` : ''}
                Aggiornato {formatRelativeTime(article.updatedAt)}
              </p>
            </div>
            <StatusBadge status={article.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
