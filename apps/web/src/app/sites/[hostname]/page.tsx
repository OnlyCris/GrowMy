import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getProductByBlogDomain, getPublishedArticlesForBlog } from '@/lib/queries/blog';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ hostname: string }>;
}): Promise<Metadata> {
  const { hostname } = await params;
  const product = await getProductByBlogDomain(hostname);
  if (!product) return {};

  return {
    title: `Blog · ${product.name}`,
    alternates: { canonical: `https://${hostname}/` },
  };
}

const dateFormatter = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export default async function BlogIndexPage({
  params,
}: {
  params: Promise<{ hostname: string }>;
}) {
  const { hostname } = await params;
  const product = await getProductByBlogDomain(hostname);
  if (!product) notFound();

  const articles = await getPublishedArticlesForBlog(product.id);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        Blog
      </h1>

      {articles.length === 0 ? (
        <p className="mt-8 text-sm text-foreground-muted">
          Non ci sono ancora articoli pubblicati.
        </p>
      ) : (
        <ul className="mt-8 flex flex-col divide-y divide-border">
          {articles.map((article) => (
            <li key={article.id} className="py-6 first:pt-0">
              <Link
                href={`/${article.slug}`}
                className="text-lg font-semibold text-foreground hover:underline"
              >
                {article.title}
              </Link>
              {article.excerpt ? (
                <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
                  {article.excerpt}
                </p>
              ) : null}
              {article.publishedAt ? (
                <p className="mt-2 text-xs text-foreground-subtle">
                  {dateFormatter.format(new Date(article.publishedAt))}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
