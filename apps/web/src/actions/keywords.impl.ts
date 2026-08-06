import 'server-only';

import { articles, db, keywords } from '@growmy/db';
import { createKeywordSchema, generateArticleSchema } from '@growmy/validation';
import { eq } from 'drizzle-orm';

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
