import 'server-only';

import { articles, articleVersions, db, keywordClusters, keywords, products } from '@growmy/db';
import { and, desc, eq, isNull, ne, notInArray } from 'drizzle-orm';

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
      keywordId: articles.keywordId,
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

/**
 * Articoli correlati per la navigazione a fondo pagina: compagni dello
 * stesso cluster tematico prima (link genuinamente pertinenti, non "un
 * articolo qualunque"), completati con i più recenti del prodotto se il
 * cluster non basta a riempire la lista.
 */
export async function getRelatedArticles(
  productId: string,
  articleId: string,
  keywordId: string | null,
  limit = 4,
) {
  let clusterId: string | null = null;
  if (keywordId) {
    const [kw] = await db
      .select({ clusterId: keywords.clusterId })
      .from(keywords)
      .where(eq(keywords.id, keywordId))
      .limit(1);
    clusterId = kw?.clusterId ?? null;
  }

  const clusterMates = clusterId
    ? await db
        .select({
          id: articles.id,
          title: articles.title,
          slug: articles.slug,
          excerpt: articles.excerpt,
        })
        .from(articles)
        .innerJoin(keywords, eq(keywords.id, articles.keywordId))
        .where(
          and(
            eq(keywords.clusterId, clusterId),
            eq(articles.status, 'published'),
            ne(articles.id, articleId),
            isNull(articles.deletedAt),
          ),
        )
        .orderBy(desc(articles.publishedAt))
        .limit(limit)
    : [];

  if (clusterMates.length >= limit) return clusterMates;

  const excludeIds = [articleId, ...clusterMates.map((c) => c.id)];
  const topUp = await db
    .select({
      id: articles.id,
      title: articles.title,
      slug: articles.slug,
      excerpt: articles.excerpt,
    })
    .from(articles)
    .where(
      and(
        eq(articles.productId, productId),
        eq(articles.status, 'published'),
        isNull(articles.deletedAt),
        excludeIds.length > 0 ? notInArray(articles.id, excludeIds) : undefined,
      ),
    )
    .orderBy(desc(articles.publishedAt))
    .limit(limit - clusterMates.length);

  return [...clusterMates, ...topUp];
}

/** Nome del cluster tematico a cui appartiene un articolo, se ne ha uno. */
export async function getArticleClusterName(keywordId: string | null) {
  if (!keywordId) return null;

  const [row] = await db
    .select({ clusterName: keywordClusters.name })
    .from(keywords)
    .innerJoin(keywordClusters, eq(keywordClusters.id, keywords.clusterId))
    .where(eq(keywords.id, keywordId))
    .limit(1);

  return row?.clusterName ?? null;
}
