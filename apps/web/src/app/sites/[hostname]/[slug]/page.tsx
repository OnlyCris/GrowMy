import { markdownToHtml } from '@growmy/integrations';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getProductByBlogDomain, getPublishedArticleBySlug } from '@/lib/queries/blog';

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

  const contentHtml = markdownToHtml(article.contentMarkdown);

  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <Link href="/" className="text-sm text-foreground-muted hover:underline">
        ← Blog
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        {article.title}
      </h1>

      {article.publishedAt ? (
        <p className="mt-3 text-sm text-foreground-subtle">
          {dateFormatter.format(new Date(article.publishedAt))}
          {article.wordCount ? ` · ${article.wordCount} parole` : ''}
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
    </article>
  );
}
