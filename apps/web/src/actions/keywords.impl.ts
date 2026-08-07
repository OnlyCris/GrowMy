import 'server-only';

import { articles, db, keywordClusters, keywords } from '@growmy/db';
import {
  createKeywordSchema,
  generateArticleSchema,
  generateKeywordsSchema,
  reviewKeywordSchema,
} from '@growmy/validation';
import { and, eq, isNull } from 'drizzle-orm';

import { enqueueJob, mapDatabaseError } from '@/lib/jobs';
import { getKeywordById, getKeywordOrganizationId } from '@/lib/queries/keywords';
import { getProductOrganizationId } from '@/lib/queries/products';

import { ActionError, createSafeAction } from './_safe-action';

/**
 * `server-only`, non `'use server'` — stesso confine sottile di
 * `products.impl.ts`/`review.impl.ts`.
 */

export const addKeyword = createSafeAction(
  {
    name: 'keywords.add',
    schema: createKeywordSchema,
    rateLimit: 'keywords.manage',
    minimumRole: 'editor',
    resolveTenant: (input) => getProductOrganizationId(input.productId),
  },
  async ({ input, membership }) => {
    try {
      const [created] = await db
        .insert(keywords)
        .values({
          organizationId: membership.organizationId,
          productId: input.productId,
          term: input.term,
          status: 'approved',
          source: 'user_manual',
          createdBy: membership.userId,
        })
        .returning({ id: keywords.id, term: keywords.term });

      return created;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new ActionError('CONFLICT', 'Questa keyword esiste già per questo prodotto.');
      }
      throw error;
    }
  },
);

/**
 * Crea il primissimo articolo per una keyword e accoda la ricerca.
 * `reserveCredit: false`: il primo tentativo di ogni articolo è gratuito
 * per design (vedi `lib/jobs.ts` e i call site analoghi in
 * `review.impl.ts` — solo la rigenerazione completa dopo un rifiuto
 * riserva un credito).
 */
export const generateArticleFromKeyword = createSafeAction(
  {
    name: 'keywords.generate-article',
    schema: generateArticleSchema,
    rateLimit: 'articles.generate',
    minimumRole: 'editor',
    resolveTenant: (input) => getKeywordOrganizationId(input.keywordId),
  },
  async ({ input, membership, traceId }) => {
    const keyword = await getKeywordById(input.keywordId, membership.organizationId);
    if (!keyword) throw new ActionError('NOT_FOUND', 'Keyword non trovata.');

    if (keyword.status === 'processing' || keyword.status === 'done') {
      throw new ActionError(
        'CONFLICT',
        'C’è già un articolo in corso o pubblicato per questa keyword.',
      );
    }

    let articleId: string;
    try {
      const [created] = await db
        .insert(articles)
        .values({
          organizationId: membership.organizationId,
          productId: keyword.productId,
          keywordId: keyword.id,
          status: 'researching',
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
          'C’è già un articolo collegato a questa keyword.',
        );
      }
      throw error;
    }

    // Se questa è la keyword pillar del suo cluster, questo articolo DIVENTA
    // il pillar: è verso di lui che gli articoli di supporto linkeranno,
    // deciso una sola volta qui, non modificabile in seguito.
    if (keyword.isPillar && keyword.clusterId) {
      await db
        .update(keywordClusters)
        .set({ pillarArticleId: articleId })
        .where(eq(keywordClusters.id, keyword.clusterId));
    }

    await db.update(keywords).set({ status: 'processing' }).where(eq(keywords.id, keyword.id));

    try {
      await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: keyword.productId,
        type: 'article_research',
        targetType: 'article',
        targetId: articleId,
        payload: {},
        discriminator: `manual-${Date.now()}`,
        reserveCredit: false,
        traceId,
      });
    } catch (error) {
      mapDatabaseError(error);
    }

    return { articleId };
  },
);

/**
 * Accoda una ricerca keyword AI per il prodotto. `targetType: 'product'`:
 * a differenza degli altri job non punta a un articolo ma al prodotto
 * stesso — stesso pattern libero già usato da `integration_connect` per
 * `'integration'`. `reserveCredit: false`: nessuna fatturazione attiva,
 * stessa scelta di tutto il resto della pipeline in questo momento.
 */
export const generateKeywords = createSafeAction(
  {
    name: 'keywords.generate',
    schema: generateKeywordsSchema,
    rateLimit: 'keywords.generate',
    minimumRole: 'editor',
    resolveTenant: (input) => getProductOrganizationId(input.productId),
  },
  async ({ input, membership, traceId }) => {
    try {
      const jobId = await enqueueJob({
        userId: membership.userId,
        organizationId: membership.organizationId,
        productId: input.productId,
        type: 'keyword_research',
        targetType: 'product',
        targetId: input.productId,
        payload: {},
        discriminator: `manual-${Date.now()}`,
        reserveCredit: false,
        traceId,
      });
      return { jobId };
    } catch (error) {
      mapDatabaseError(error);
    }
  },
);

/**
 * Approva o scarta una keyword `suggested`. Un umano decide quali proposte
 * dell'AI meritano di diventare articoli — non serve accodare nulla, è una
 * semplice transizione di stato.
 */
export const reviewKeyword = createSafeAction(
  {
    name: 'keywords.review',
    schema: reviewKeywordSchema,
    rateLimit: 'keywords.manage',
    minimumRole: 'editor',
    resolveTenant: (input) => getKeywordOrganizationId(input.keywordId),
  },
  async ({ input, membership }) => {
    const keyword = await getKeywordById(input.keywordId, membership.organizationId);
    if (!keyword) throw new ActionError('NOT_FOUND', 'Keyword non trovata.');

    if (keyword.status !== 'suggested') {
      throw new ActionError(
        'CONFLICT',
        'Questa keyword non è più in attesa di revisione.',
      );
    }

    await db
      .update(keywords)
      .set({ status: input.decision === 'approve' ? 'approved' : 'rejected' })
      .where(
        and(
          eq(keywords.id, input.keywordId),
          eq(keywords.status, 'suggested'),
          isNull(keywords.deletedAt),
        ),
      );

    const status: 'approved' | 'rejected' =
      input.decision === 'approve' ? 'approved' : 'rejected';
    return { status };
  },
);
