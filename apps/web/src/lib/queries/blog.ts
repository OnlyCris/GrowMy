import 'server-only';

import { articles, articleVersions, db, products } from '@growmy/db';
import { and, desc, eq, isNull } from 'drizzle-orm';

/**
 * QUERY DELLA VETRINA BLOG PUBBLICA.
 *
 * A differenza di ogni altra query in `lib/queries/`, queste girano SENZA
 * `withUserContext`: chi legge un articolo pubblicato su blog.[dominio] non
 * ha una sessione autenticata. `db` fuori da `withUserContext` si comporta
 * come il client Postgres diretto (vedi `packages/db/src/client.ts`), quindi
 * la visibilità delle righe dipende dalle policy RLS pubbliche aggiunte in
 * `0004_public_blog_read.sql` — non da un controllo qui.
 */

export async function getProductByBlogDomain(hostname: string) {
  const [row] = await db
    .select({ id: products.id, name: products.name, websiteUrl: products.websiteUrl })
    .from(products)
    .where(and(eq(products.blogDomain, hostname.toLowerCase()), isNull(products.deletedAt)))
    .limit(1);

  return row ?? null;
}

export async function getPublishedArticlesForBlog(productId: string) {
  return db
    .select({
      id: articles.id,
      title: articles.title,
      slug: articles.slug,
      excerpt: articles.excerpt,
      publishedAt: articles.publishedAt,
      wordCount: articles.wordCount,
      featuredImageUrl: articles.featuredImageUrl,
    })
    .from(articles)
    .where(
      and(
        eq(articles.productId, productId),
        eq(articles.status, 'published'),
        isNull(articles.deletedAt),
      ),
    )
    .orderBy(desc(articles.publishedAt));
}

export async function getPublishedArticleBySlug(productId: string, slug: string) {
  const [row] = await db
    .select({
      id: articles.id,
      title: articles.title,
      slug: articles.slug,
      metaDescription: articles.metaDescription,
      excerpt: articles.excerpt,
      publishedAt: articles.publishedAt,
      wordCount: articles.wordCount,
      featuredImageUrl: articles.featuredImageUrl,
      contentMarkdown: articleVersions.contentMarkdown,
    })
    .from(articles)
    .innerJoin(articleVersions, eq(articleVersions.id, articles.currentVersionId))
    .where(
      and(
        eq(articles.productId, productId),
        eq(articles.slug, slug),
        eq(articles.status, 'published'),
        isNull(articles.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}
