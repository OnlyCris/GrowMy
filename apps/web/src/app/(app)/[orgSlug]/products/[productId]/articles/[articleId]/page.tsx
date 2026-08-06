import { withUserContext } from '@growmy/db/context';
import { markdownToHtml } from '@growmy/integrations';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { StatusBadge, type ArticleStatus } from '@/components/shared/status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgMembership } from '@/lib/auth/guards';
import { getArticleDetail } from '@/lib/queries/articles';
import { formatRelativeTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Articolo',
  robots: { index: false, follow: false },
};

const HUMAN_GATE_STATUSES: ArticleStatus[] = ['brief_ready', 'draft_ready'];

export default async function ArticleDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; productId: string; articleId: string }>;
}) {
  const { orgSlug, productId, articleId } = await params;

  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  const article = await withUserContext(membership.userId, () =>
    getArticleDetail(articleId, membership.organizationId),
  );
  if (!article) notFound();

  const title = article.versionTitle ?? article.title ?? article.keywordTerm ?? 'Senza titolo';
  const metaDescription = article.versionMetaDescription ?? article.metaDescription;
  const html = article.versionContentMarkdown
    ? markdownToHtml(article.versionContentMarkdown)
    : null;

  return (
    <Card>
      <CardHeader>
        <Link
          href={`/${orgSlug}/products/${productId}/articles`}
          className="text-xs text-foreground-muted underline underline-offset-4 hover:no-underline"
        >
          ← Torna agli articoli
        </Link>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{title}</CardTitle>
          <StatusBadge status={article.status} />
        </div>
        <p className="text-xs text-foreground-muted">
          {article.wordCount ? `${article.wordCount} parole · ` : ''}
          Aggiornato {formatRelativeTime(article.updatedAt)}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {HUMAN_GATE_STATUSES.includes(article.status) ? (
          <p className="rounded-[var(--radius-md)] bg-info-100 px-3 py-2 text-sm text-info-700">
            In attesa della tua decisione —{' '}
            <Link
              href={`/${orgSlug}/review`}
              className="underline underline-offset-4 hover:no-underline"
            >
              vai alla coda di revisione
            </Link>
            .
          </p>
        ) : null}

        {article.status === 'failed' && article.failureReason ? (
          <p className="rounded-[var(--radius-md)] bg-danger-100 px-3 py-2 text-sm text-danger-700">
            {article.failureReason}
          </p>
        ) : null}

        {article.publishedUrl ? (
          <p className="text-sm text-foreground-muted">
            Pubblicato su{' '}
            <a
              href={article.publishedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-info-700 underline underline-offset-4 hover:no-underline"
            >
              {article.publishedUrl}
            </a>
          </p>
        ) : null}

        {metaDescription ? (
          <p className="text-sm italic text-foreground-muted">{metaDescription}</p>
        ) : null}

        {html ? (
          <div className="prose-article" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <p className="text-sm text-foreground-muted">
            Nessun contenuto ancora — la ricerca è ancora in corso.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
