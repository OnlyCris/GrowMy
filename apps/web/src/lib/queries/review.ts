import 'server-only';

import {
  articleVersions,
  articles,
  db,
  keywords,
  products,
} from '@growmy/db';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import { hoursUntilAutoApproval } from '@/lib/utils';
import type {
  ArticleBrief,
  QualityScore,
  ReviewQueueItem,
} from '@/types/review';

/**
 * QUERY DELLA CODA DI REVISIONE
 *
 * `import 'server-only'` in cima: se un componente client importa questo modulo
 * per errore, il build fallisce invece di far finire una stringa di connessione
 * nel bundle. È una riga che costa nulla e chiude un'intera classe di incidenti.
 *
 * Disciplina applicata in tutte le query:
 *
 *  1. SELECT ESPLICITE, mai `select()` senza proiezione. Aggiungere domani una
 *     colonna sensibile allo schema non deve farla comparire in una risposta.
 *  2. `organizationId` in OGNI where, anche con RLS attivo. La difesa in
 *     profondità funziona solo se entrambi gli strati fanno il loro lavoro.
 *  3. Nessun N+1: le versioni degli articoli si caricano con una sola query
 *     `inArray`, non una per articolo dentro un ciclo.
 */

/** Colonne del prodotto necessarie per la coda. Nulla di più. */
const productColumns = {
  productId: products.id,
  productName: products.name,
  productDomain: products.domain,
  approvalTimeoutHours: products.approvalTimeoutHours,
};

/**
 * Carica gli articoli che stanno bloccando la pipeline in attesa di una
 * decisione umana — gli unici due stati che lo fanno.
 *
 * Ordinamento: prima chi ha aspettato di più. È l'ordine che riduce il rischio
 * che qualcosa venga auto-approvato per timeout senza che nessuno l'abbia visto.
 */
export async function getReviewQueue(
  organizationId: string,
): Promise<ReviewQueueItem[]> {
  const rows = await db
    .select({
      articleId: articles.id,
      status: articles.status,
      title: articles.title,
      brief: articles.brief,
      qualityScore: articles.qualityScore,
      currentVersionId: articles.currentVersionId,
      featuredImageUrl: articles.featuredImageUrl,
      metaDescription: articles.metaDescription,
      wordCount: articles.wordCount,
      waitingSince: articles.updatedAt,
      targetKeyword: keywords.term,
      ...productColumns,
    })
    .from(articles)
    .innerJoin(products, eq(products.id, articles.productId))
    .leftJoin(keywords, eq(keywords.id, articles.keywordId))
    .where(
      and(
        eq(articles.organizationId, organizationId),
        isNull(articles.deletedAt),
        or(
          eq(articles.status, 'brief_ready'),
          eq(articles.status, 'draft_ready'),
        ),
      ),
    )
    .orderBy(articles.updatedAt)
    .limit(100);

  if (rows.length === 0) return [];

  /**
   * Versioni correnti caricate in un colpo solo.
   * Una query dentro il `map` sarebbe un N+1 da 100 round-trip su una coda piena.
   */
  const versionIds = rows
    .map((row) => row.currentVersionId)
    .filter((id): id is string => id !== null);

  const versions = versionIds.length
    ? await db
        .select({
          id: articleVersions.id,
          articleId: articleVersions.articleId,
          versionNumber: articleVersions.versionNumber,
          title: articleVersions.title,
          metaDescription: articleVersions.metaDescription,
          contentMarkdown: articleVersions.contentMarkdown,
          llmModel: articleVersions.llmModel,
        })
        .from(articleVersions)
        .where(inArray(articleVersions.id, versionIds))
    : [];

  const versionByArticle = new Map(versions.map((v) => [v.articleId, v]));

  /**
   * Numero della versione precedente, per abilitare la vista diff.
   * Anche questa in una sola query: prendiamo tutte le versioni degli articoli
   * in coda e teniamo, per ciascuno, quella immediatamente precedente.
   */
  const articleIds = rows.map((row) => row.articleId);
  const allVersions = await db
    .select({
      id: articleVersions.id,
      articleId: articleVersions.articleId,
      versionNumber: articleVersions.versionNumber,
    })
    .from(articleVersions)
    .where(inArray(articleVersions.articleId, articleIds))
    .orderBy(desc(articleVersions.versionNumber));

  const previousVersionByArticle = new Map<string, string>();
  const seenCurrent = new Set<string>();
  for (const version of allVersions) {
    if (!seenCurrent.has(version.articleId)) {
      // La prima occorrenza (numero più alto) è la versione corrente.
      seenCurrent.add(version.articleId);
      continue;
    }
    if (!previousVersionByArticle.has(version.articleId)) {
      previousVersionByArticle.set(version.articleId, version.id);
    }
  }

  return rows.map((row): ReviewQueueItem => {
    const version = versionByArticle.get(row.articleId);
    const isBrief = row.status === 'brief_ready';

    return {
      articleId: row.articleId,
      productId: row.productId,
      productName: row.productName,
      productDomain: row.productDomain,
      status: row.status as 'brief_ready' | 'draft_ready',
      title: row.title,
      targetKeyword: row.targetKeyword ?? '',
      waitingSince: row.waitingSince.toISOString(),
      hoursUntilAutoApproval: hoursUntilAutoApproval(
        row.waitingSince,
        row.approvalTimeoutHours,
      ),
      brief: isBrief ? ((row.brief as ArticleBrief | null) ?? null) : null,
      draft:
        !isBrief && version
          ? {
              versionId: version.id,
              versionNumber: version.versionNumber,
              title: version.title ?? row.title ?? '',
              metaDescription:
                version.metaDescription ?? row.metaDescription ?? '',
              contentMarkdown: version.contentMarkdown,
              wordCount: row.wordCount ?? 0,
              featuredImageUrl: row.featuredImageUrl,
              previousVersionId:
                previousVersionByArticle.get(row.articleId) ?? null,
              llmModel: version.llmModel,
            }
          : null,
      qualityScore: isBrief
        ? null
        : ((row.qualityScore as QualityScore | null) ?? null),
      // L'outline si rigenera gratis; l'articolo completo costa un credito.
      regenerationCost: isBrief ? 0 : 1,
    };
  });
}

/**
 * Carica il markdown delle versioni precedenti per la vista diff.
 *
 * Riceve coppie esplicite (articleId, versionId) già filtrate dal chiamante:
 * accettare una lista di soli versionId consentirebbe a un client malevolo di
 * chiedere il contenuto di una versione qualsiasi. Qui l'input viene dal server,
 * ma il vincolo di scope su `organizationId` è comunque riapplicato.
 */
export async function getPreviousVersionsMarkdown(
  pairs: Array<{ articleId: string; versionId: string }>,
): Promise<Record<string, string | null>> {
  if (pairs.length === 0) return {};

  const rows = await db
    .select({
      id: articleVersions.id,
      articleId: articleVersions.articleId,
      contentMarkdown: articleVersions.contentMarkdown,
    })
    .from(articleVersions)
    .where(
      inArray(
        articleVersions.id,
        pairs.map((pair) => pair.versionId),
      ),
    );

  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: Record<string, string | null> = {};

  for (const pair of pairs) {
    const row = byId.get(pair.versionId);
    // Verifica di coerenza: la versione deve appartenere all'articolo dichiarato.
    result[pair.articleId] =
      row && row.articleId === pair.articleId ? row.contentMarkdown : null;
  }

  return result;
}

/**
 * Risolve l'organizzazione proprietaria di un articolo.
 * È la funzione che il wrapper `safe-action` usa come `resolveTenant`: impedisce
 * che un utente operi su un articolo di un'altra organizzazione passandone l'id.
 */
export async function getArticleOrganizationId(
  articleId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: articles.organizationId })
    .from(articles)
    .where(and(eq(articles.id, articleId), isNull(articles.deletedAt)))
    .limit(1);

  return row?.organizationId ?? null;
}

/** Stato corrente dell'articolo, per validare la transizione richiesta. */
export async function getArticleState(
  articleId: string,
  organizationId: string,
): Promise<{
  status: string;
  productId: string;
  currentVersionId: string | null;
} | null> {
  const [row] = await db
    .select({
      status: articles.status,
      productId: articles.productId,
      currentVersionId: articles.currentVersionId,
    })
    .from(articles)
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
