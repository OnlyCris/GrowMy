import { markdownToHtml } from '@growmy/integrations';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  getArticleClusterName,
  getProductByBlogDomain,
  getPublishedArticleBySlug,
  getRelatedArticles,
} from '@/lib/queries/blog';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ hostname: string; slug: string }>;
}): Promise<Metadata> {
  const { hostname, slug } = await params;
  const product = await getProductByBlogDomain(hostname);
  if (!product) return {};

  const article = await getPublishedArticleBySlug(product.id, slug);
  if (!article) return {};

  const canonical = `https://${hostname}/${article.slug}`;

  return {
    title: article.title ?? undefined,
    description: article.metaDescription ?? article.excerpt ?? undefined,
    alternates: { canonical },
    openGraph: {
      title: article.title ?? undefined,
      description: article.metaDescription ?? article.excerpt ?? undefined,
      url: canonical,
      type: 'article',
      publishedTime: article.publishedAt?.toISOString(),
      images: article.featuredImageUrl ? [article.featuredImageUrl] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title: article.title ?? undefined,
      description: article.metaDescription ?? article.excerpt ?? undefined,
    },
  };
}

const dateFormatter = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export default async function BlogArticlePage({
  params,
}: {
  params: Promise<{ hostname: string; slug: string }>;
}) {
  const { hostname, slug } = await params;
  const product = await getProductByBlogDomain(hostname);
  if (!product) notFound();

  const article = await getPublishedArticleBySlug(product.id, slug);
  if (!article) notFound();

  const [related, clusterName] = await Promise.all([
    getRelatedArticles(product.id, article.id, article.keywordId),
    getArticleClusterName(article.keywordId),
  ]);

  const contentHtml = markdownToHtml(article.contentMarkdown);
  // ~200 parole al minuto: stima standard, comunica in due secondi "quanto
  // costa" leggere l'articolo — un segnale di navigazione, non decorazione.
  const readingMinutes = article.wordCount ? Math.max(1, Math.round(article.wordCount / 200)) : null;

  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <nav aria-label="Percorso" className="flex items-center gap-1.5 text-sm text-foreground-muted">
        <Link href="/" className="hover:text-foreground hover:underline">
          Blog
        </Link>
        {clusterName ? (
          <>
            <span aria-hidden="true">/</span>
            <span>{clusterName}</span>
          </>
        ) : null}
      </nav>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        {article.title}
      </h1>

      {article.publishedAt ? (
        <p className="mt-3 text-sm text-foreground-subtle">
          {dateFormatter.format(new Date(article.publishedAt))}
          {readingMinutes ? ` · ${readingMinutes} min di lettura` : ''}
        </p>
      ) : null}

      {/* `markdownToHtml` (packages/integrations) esegue già l'escape di ogni
          carattere non riconosciuto ed è la stessa funzione usata per il
          payload di pubblicazione verso i CMS dei clienti: già trattata come
          sicura per l'esposizione pubblica, non solo per uso interno. */}
      <div
        className="prose-article mt-8"
        dangerouslySetInnerHTML={{ __html: contentHtml }}
      />

      {product.websiteUrl ? (
        <div className="mt-12 flex flex-col items-start gap-3 rounded-[var(--radius-lg)] border border-border bg-surface-muted p-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-foreground">
            Gestisci il tuo locale con {product.name}.
          </p>
          <a
            href={product.websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-[var(--radius-md)] bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
          >
            Scopri {product.name} →
          </a>
        </div>
      ) : null}

      {related.length > 0 ? (
        <nav aria-label="Articoli correlati" className="mt-16 border-t border-border pt-8">
          <h2 className="text-sm font-semibold text-foreground">Continua a leggere</h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2">
            {related.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/${item.slug}`}
                  className="block rounded-[var(--radius-lg)] border border-border p-4 hover:border-border-strong hover:bg-surface-muted"
                >
                  <p className="text-sm font-medium text-foreground">{item.title}</p>
                  {item.excerpt ? (
                    <p className="mt-1.5 line-clamp-2 text-xs text-foreground-muted">
                      {item.excerpt}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </article>
  );
}
