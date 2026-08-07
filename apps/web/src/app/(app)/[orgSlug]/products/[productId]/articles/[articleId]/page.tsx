import { withUserContext } from '@growmy/db/context';
import { markdownToHtml } from '@growmy/integrations';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { QualityScorePanel } from '@/app/(app)/[orgSlug]/review/_components/quality-score-panel';
import { AutoRefresh } from '@/components/shared/auto-refresh';
import { StatusBadge, type ArticleStatus } from '@/components/shared/status-badge';
import { Countdown } from '@/components/shared/countdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgMembership } from '@/lib/auth/guards';
import { getArticleDetail, getLatestPipelineJob } from '@/lib/queries/articles';
import { formatRelativeTime } from '@/lib/utils';
import type { QualityScore } from '@/types/review';

import { DeleteArticleButton } from './_components/delete-article-button';
import { RetryArticleButton } from './_components/retry-article-button';

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

  const lastJob = await withUserContext(membership.userId, () =>
    getLatestPipelineJob(articleId, membership.organizationId),
  );
  const pendingRetryAt =
    lastJob?.status === 'pending' && lastJob.nextRetryAt && lastJob.nextRetryAt > new Date()
      ? lastJob.nextRetryAt
      : null;
  const isRateLimited = lastJob?.lastErrorCode === 'RATE_LIMITED';

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
          <div className="flex items-center gap-2">
            <StatusBadge status={article.status} />
            <DeleteArticleButton
              articleId={article.id}
              redirectTo={`/${orgSlug}/products/${productId}/articles`}
            />
          </div>
        </div>
        <p className="text-xs text-foreground-muted">
          {article.wordCount ? `${article.wordCount} parole · ` : ''}
          Aggiornato {formatRelativeTime(article.updatedAt)}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {article.qualityScore ? (
          <QualityScorePanel score={article.qualityScore as unknown as QualityScore} />
        ) : null}
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
          <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-danger-100 px-3 py-2.5">
            {isRateLimited ? (
              <span className="w-fit rounded-full bg-danger-200 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-danger-700">
                Limite di richieste
              </span>
            ) : null}
            <p className="text-sm text-danger-700">{article.failureReason}</p>
            {lastJob && lastJob.type !== 'article_publish' ? (
              <div className="mt-1">
                <RetryArticleButton articleId={article.id} />
              </div>
            ) : null}
          </div>
        ) : null}

        {pendingRetryAt ? (
          <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-accent-50 px-3 py-2.5">
            <AutoRefresh enabled intervalMs={5000} maxPolls={60} />
            {isRateLimited ? (
              <span className="w-fit rounded-full bg-accent-100 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-accent-900">
                Limite di richieste
              </span>
            ) : null}
            <p className="text-sm text-accent-900">
              {lastJob?.lastError ?? 'Ultimo tentativo non riuscito.'}
            </p>
            <p className="text-xs text-foreground-muted">
              Nuovo tentativo automatico tra <Countdown to={pendingRetryAt} /> (tentativo{' '}
              {lastJob?.attempts} di {lastJob?.maxAttempts}).
            </p>
          </div>
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
