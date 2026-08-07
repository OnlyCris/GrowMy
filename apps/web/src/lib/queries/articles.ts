import 'server-only';

import { articleVersions, articles, db, jobs, keywords } from '@growmy/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

/**
 * QUERY DEGLI ARTICOLI PER LA VISTA "TUTTI GLI ARTICOLI" DI UN PRODOTTO.
 *
 * Distinta da `lib/queries/review.ts`, che serve SOLO `brief_ready`/
 * `draft_ready` (i due stati che fermano la pipeline). Qui serve l'elenco
 * completo, qualunque stato — è il posto dove un contenuto generato in
 * autopilota (nessun gate umano) diventa comunque visibile.
 */

export async function getArticlesForProduct(productId: string) {
  return db
    .select({
      id: articles.id,
      title: articles.title,
      status: articles.status,
      wordCount: articles.wordCount,
      keywordTerm: keywords.term,
      updatedAt: articles.updatedAt,
    })
    .from(articles)
    .leftJoin(keywords, eq(keywords.id, articles.keywordId))
    .where(and(eq(articles.productId, productId), isNull(articles.deletedAt)))
    .orderBy(desc(articles.updatedAt));
}

/**
 * Riga completa + la versione corrente (se esiste già — niente prima che la
 * ricerca sia passata). `null` se l'articolo non esiste o non appartiene
 * all'organizzazione: `organizationId` nel WHERE anche con RLS attivo,
 * stessa difesa in profondità di `lib/queries/review.ts`.
 */
export async function getArticleDetail(articleId: string, organizationId: string) {
  const [row] = await db
    .select({
      id: articles.id,
      status: articles.status,
      title: articles.title,
      metaDescription: articles.metaDescription,
      wordCount: articles.wordCount,
      qualityScore: articles.qualityScore,
      failureReason: articles.failureReason,
      publishedUrl: articles.publishedUrl,
      keywordTerm: keywords.term,
      updatedAt: articles.updatedAt,
      versionContentMarkdown: articleVersions.contentMarkdown,
      versionTitle: articleVersions.title,
      versionMetaDescription: articleVersions.metaDescription,
    })
    .from(articles)
    .leftJoin(keywords, eq(keywords.id, articles.keywordId))
    .leftJoin(articleVersions, eq(articleVersions.id, articles.currentVersionId))
    .where(
      and(
        eq(articles.id, articleId),
        eq(articles.organizationId, organizationId),
        isNull(articles.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * L'ultimo job di pipeline (ricerca, stesura, pubblicazione) su questo
 * articolo — usato per mostrare PERCHÉ un articolo è fermo, non solo CHE è
 * fermo. `jobs.last_error` è già il testo tradotto per l'utente (mai lo
 * stack trace, vedi `job-recorder.ts` nel worker); `next_retry_at`, quando
 * presente, è il momento reale in cui il worker riproverà da solo — non una
 * stima, è il valore che BullMQ userà davvero.
 */
export async function getLatestPipelineJob(articleId: string, organizationId: string) {
  const [row] = await db
    .select({
      type: jobs.type,
      status: jobs.status,
      lastError: jobs.lastError,
      lastErrorCode: jobs.lastErrorCode,
      nextRetryAt: jobs.nextRetryAt,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.targetId, articleId),
        eq(jobs.organizationId, organizationId),
        inArray(jobs.type, ['article_research', 'article_generate', 'article_publish']),
      ),
    )
    .orderBy(desc(jobs.updatedAt))
    .limit(1);

  return row ?? null;
}
