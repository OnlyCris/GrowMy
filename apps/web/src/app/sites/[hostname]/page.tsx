import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getProductByBlogDomain, getPublishedArticlesForBlog } from '@/lib/queries/blog';

import { BlogArticleList } from './_components/blog-article-list';

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
        <BlogArticleList articles={articles} />
      )}
    </div>
  );
}
