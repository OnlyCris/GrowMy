import 'server-only';

import { canTransition, computeQualityScore, countWords, normalizeSlug, type ArticleStatus } from '@growmy/core';
import { articleVersions, articles, db } from '@growmy/db';
import { createManualArticleSchema, deleteArticleSchema, retryArticleSchema } from '@growmy/validation';
import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { enqueueJob, mapDatabaseError } from '@/lib/jobs';
import { getLatestPipelineJob } from '@/lib/queries/articles';
import { getArticleOrganizationId } from '@/lib/queries/review';
import { getProductOrganizationId } from '@/lib/queries/products';

import { ActionError, createSafeAction } from './_safe-action';

/**
 * `server-only`, non `'use server'` — stesso confine di `keywords.impl.ts`.
 */

/**
 * Crea un articolo scritto interamente a mano. Entra in `draft_ready`,
 * NON `approved`: passa dalla stessa coda di revisione degli articoli
 * generati dall'AI, con lo stesso quality score calcolato allo stesso modo —
 * "sempre con rating scores" vale anche per il testo umano, la qualità non fa
 * sconti a chi l'ha scritto. Non crea una riga `keywords`: un articolo scritto
 * a mano non nasce da un ciclo di ricerca keyword, la parola chiave serve solo
 * al calcolo del punteggio, non ha senso finta di "pianificazione" nello schema.
 */
export const createManualArticle = createSafeAction(
  {
    name: 'articles.create-manual',
    schema: createManualArticleSchema,
    rateLimit: 'articles.manage',
    minimumRole: 'editor',
    resolveTenant: (input) => getProductOrganizationId(input.productId),
  },
  async ({ input, membership }) => {
    const slug = normalizeSlug(input.title);

    let articleId: string;
    try {
      const [created] = await db
        .insert(articles)
        .values({
          organizationId: membership.organizationId,
          productId: input.productId,
          status: 'draft_ready',
          title: input.title,
          slug,
          metaDescription: input.metaDescription,
          excerpt: input.excerpt ?? null,
          wordCount: countWords(input.contentMarkdown),
        })
        .returning({ id: articles.id });
      articleId = created.id;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new ActionError(
          'CONFLICT',
          'Esiste già un articolo con uno slug equivalente per questo prodotto. Cambia titolo.',
        );
      }
      throw error;
    }

    const quality = computeQualityScore({
      markdown: input.contentMarkdown,
      targetKeyword: input.targetKeyword,
      // Nessun brief: la copertura attesa di link interni scende al minimo
      // pratico (2, vedi computeQualityScore) invece che scalare su sezioni
      // che per un articolo scritto a mano non esistono come dato strutturato.
      briefSectionCount: 0,
    });

    const [version] = await db
      .insert(articleVersions)
      .values({
        articleId,
        versionNumber: 1,
        contentMarkdown: input.contentMarkdown,
        title: input.title,
        metaDescription: input.metaDescription,
        createdVia: 'human_edit',
        createdByUserId: membership.userId,
      })
      .returning({ id: articleVersions.id });

    await db
      .update(articles)
      .set({ currentVersionId: version.id, qualityScore: quality })
      .where(eq(articles.id, articleId));

    revalidatePath(`/${membership.organizationSlug}/products/${input.productId}/articles`);
    revalidatePath(`/${membership.organizationSlug}/review`);

    return { articleId };
  },
);

/**
 * Elimina un articolo. Soft delete (`deletedAt`), come ogni altra riga
 * cancellabile nello schema — mai un DELETE reale, la cronologia resta
 * ricostruibile e nessun vincolo di unicità (slug, keyword) sbatte contro
 * righe morte.
 */
export const deleteArticle = createSafeAction(
  {
    name: 'articles.delete',
    schema: deleteArticleSchema,
    rateLimit: 'articles.manage',
    minimumRole: 'editor',
    resolveTenant: (input) => getArticleOrganizationId(input.articleId),
  },
  async ({ input, membership }) => {
    const updated = await db
      .update(articles)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(articles.id, input.articleId),
          eq(articles.organizationId, membership.organizationId),
          isNull(articles.deletedAt),
        ),
      )
      .returning({ id: articles.id, productId: articles.productId });

    if (updated.length === 0) {
      throw new ActionError('NOT_FOUND', 'Articolo non trovato.');
    }

    revalidatePath(`/${membership.organizationSlug}/products/${updated[0].productId}/articles`);
    revalidatePath(`/${membership.organizationSlug}/products`);
    revalidatePath(`/${membership.organizationSlug}/review`);

    return { id: input.articleId };
  },
);

/**
 * Ritenta la ricerca o la stesura di un articolo finito in `failed` — lo
 * stesso stage che è fallito, non necessariamente da zero: la ricerca
 * riparte se era quella a fallire, la stesura se il brief esisteva già.
 *
 * `reserveCredit: false`: si tratta di recuperare un tentativo già pagato
 * (o mai davvero addebitato, il primo tentativo è gratuito per design — vedi
 * `lib/jobs.ts`), non di venderne uno nuovo.
 *
 * I fallimenti in pubblicazione restano fuori da questo pulsante: rigenerare
 * i contenuti butterebbe via una bozza già buona per un problema che quasi
 * sempre sta nell'integrazione di destinazione, non nel testo — quella si
 * ripara dalla pagina Integrazione, non riscrivendo l'articolo.
 */
export const retryArticle = createSafeAction(
  {
    name: 'articles.retry',
    schema: retryArticleSchema,
    rateLimit: 'articles.manage',
    minimumRole: 'editor',
    resolveTenant: (input) => getArticleOrganizationId(input.articleId),
  },
  async ({ input, membership, traceId }) => {
    const [row] = await db
      .select({ status: articles.status, productId: articles.productId })
      .from(articles)
      .where(
        and(
          eq(articles.id, input.articleId),
          eq(articles.organizationId, membership.organizationId),
          isNull(articles.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new ActionError('NOT_FOUND', 'Articolo non trovato.');
    if (row.status !== 'failed') {
      throw new ActionError('CONFLICT', 'Questo articolo non è in stato di errore.');
    }

    const lastJob = await getLatestPipelineJob(input.articleId, membership.organizationId);

    if (lastJob?.type === 'article_publish') {
      throw new ActionError(
        'CONFLICT',
        'Il fallimento è in pubblicazione, non in stesura: controlla l’integrazione collegata.',
      );
    }

    const retryType = lastJob?.type === 'article_research' ? 'article_research' : 'article_generate';
    const nextStatus = retryType === 'article_research' ? 'researching' : 'generating';

    if (!canTransition(row.status as ArticleStatus, nextStatus)) {
      throw new ActionError('CONFLICT', 'Impossibile ritentare questo articolo ora.');
    }

    await db
      .update(articles)
      .set({ status: nextStatus, failureReason: null, updatedAt: new Date() })
      .where(eq(articles.id, input.articleId));

    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: row.productId,
        type: retryType,
        targetType: 'article',
        targetId: input.articleId,
        payload: {},
        discriminator: `retry-${Date.now()}`,
        reserveCredit: false,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    revalidatePath(`/${membership.organizationSlug}/products/${row.productId}/articles`);
    revalidatePath(
      `/${membership.organizationSlug}/products/${row.productId}/articles/${input.articleId}`,
    );
    revalidatePath(`/${membership.organizationSlug}/review`);

    return { articleId: input.articleId };
  },
);
