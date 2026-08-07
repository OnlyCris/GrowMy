import 'server-only';

import { computeQualityScore, countWords, normalizeSlug } from '@growmy/core';
import { articleVersions, articles, db } from '@growmy/db';
import { createManualArticleSchema, deleteArticleSchema } from '@growmy/validation';
import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

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
