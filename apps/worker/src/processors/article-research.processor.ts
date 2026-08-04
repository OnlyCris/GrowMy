import { parseJsonResponse, briefPrompt, type BrandContext } from '@growmy/ai';
import { stateAfterResearch } from '@growmy/core';
import {
  articles,
  getWorkerDb,
  keywords,
  productBrandProfiles,
  products,
} from '@growmy/db';
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';

import type { ProcessorContext } from './types';

/**
 * PROCESSORE DI RICERCA — produce il brief (outline) di un articolo.
 *
 * È il primo passo della pipeline e alimenta l'UPGRADE #1: se il prodotto ha
 * `autoApproveBrief = false`, l'articolo si ferma in `brief_ready` e attende
 * una decisione umana. Se è `true`, prosegue dritto alla stesura.
 *
 * La stessa funzione serve anche il RIFIUTO di un brief: il payload porta
 * `humanFeedback`, che entra nel prompt come indicazione da seguire.
 */

interface ArticleResearchPayload {
  humanFeedback?: string | null;
  rejectedBy?: string;
}

export async function processArticleResearch(
  ctx: ProcessorContext,
): Promise<void> {
  const db = getWorkerDb();
  const { recorder, llm, logger, job } = ctx;
  const articleId = job.targetId;

  if (!articleId) {
    throw new Error('Job di ricerca senza targetId: articolo non identificabile.');
  }

  const payload = (job.payload ?? {}) as ArticleResearchPayload;

  // --- Caricamento del contesto -------------------------------------------
  const [row] = await db
    .select({
      articleId: articles.id,
      articleStatus: articles.status,
      keywordTerm: keywords.term,
      productId: products.id,
      productName: products.name,
      domain: products.domain,
      contentLanguage: products.contentLanguage,
      targetWordCountMin: products.targetWordCountMin,
      targetWordCountMax: products.targetWordCountMax,
      autoApproveBrief: products.autoApproveBrief,
      businessSummary: productBrandProfiles.businessSummary,
      targetAudience: productBrandProfiles.targetAudience,
      valueProposition: productBrandProfiles.valueProposition,
      toneOfVoice: productBrandProfiles.toneOfVoice,
      forbiddenTopics: productBrandProfiles.forbiddenTopics,
    })
    .from(articles)
    .innerJoin(products, eq(products.id, articles.productId))
    .leftJoin(keywords, eq(keywords.id, articles.keywordId))
    .leftJoin(
      productBrandProfiles,
      eq(productBrandProfiles.productId, products.id),
    )
    .where(eq(articles.id, articleId))
    .limit(1);

  if (!row) {
    throw new Error(`Articolo ${articleId} non trovato.`);
  }

  if (!row.keywordTerm) {
    throw new Error('L’articolo non ha una keyword associata.');
  }

  const brand: BrandContext = {
    productName: row.productName,
    domain: row.domain,
    language: row.contentLanguage,
    businessSummary: row.businessSummary,
    targetAudience: row.targetAudience,
    valueProposition: row.valueProposition,
    toneOfVoice: row.toneOfVoice,
    forbiddenTopics: (row.forbiddenTopics as string[] | null) ?? [],
  };

  // --- Candidati per i link interni ---------------------------------------
  // Solo articoli già pubblicati dello stesso prodotto: linkare una bozza
  // produrrebbe un 404 sul sito del cliente.
  const linkCandidates = await recorder.step(
    'research.internal_links',
    'Raccolta degli articoli collegabili',
    async () =>
      db
        .select({
          articleId: articles.id,
          title: articles.title,
          slug: articles.slug,
        })
        .from(articles)
        .where(
          and(
            eq(articles.productId, row.productId),
            eq(articles.status, 'published'),
            ne(articles.id, articleId),
            isNotNull(articles.slug),
            isNull(articles.deletedAt),
          ),
        )
        .limit(20),
  );

  // --- Generazione del brief ----------------------------------------------
  const result = await recorder.step(
    'research.brief',
    `Progettazione della struttura per «${row.keywordTerm}»`,
    async () =>
      llm.complete({
        messages: briefPrompt({
          brand,
          keyword: row.keywordTerm!,
          targetWordCount: Math.round(
            (row.targetWordCountMin + row.targetWordCountMax) / 2,
          ),
          internalLinkCandidates: linkCandidates.map((c) => ({
            articleId: c.articleId,
            title: c.title ?? '',
            slug: c.slug ?? '',
          })),
          humanFeedback: payload.humanFeedback,
        }),
        jsonMode: true,
        temperature: 0.8,
      }),
  );

  const brief = parseJsonResponse<Record<string, unknown>>(result.text);

  // Validazione minima: un brief senza sezioni farebbe fallire la stesura più
  // avanti, con un errore molto meno comprensibile.
  const sections = brief.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('Il brief generato non contiene sezioni utilizzabili.');
  }

  // --- Transizione di stato ------------------------------------------------
  // Qui si decide se fermarsi per la revisione umana o proseguire: è il punto
  // in cui l'UPGRADE #1 diventa opzionale invece che obbligatorio.
  const nextStatus = stateAfterResearch(row.autoApproveBrief);

  await db
    .update(articles)
    .set({
      brief,
      status: nextStatus,
      updatedAt: new Date(),
    })
    .where(and(eq(articles.id, articleId), eq(articles.status, 'researching')));

  await recorder.event({
    step: 'research.done',
    message:
      nextStatus === 'brief_ready'
        ? 'Brief pronto: in attesa di approvazione.'
        : 'Brief approvato automaticamente: stesura in avvio.',
    details: {
      sections: sections.length,
      provider: result.provider,
      costMicroUsd: result.costMicroUsd,
    },
  });

  logger.info(
    {
      articleId,
      nextStatus,
      provider: result.provider,
      costMicroUsd: result.costMicroUsd,
    },
    'ricerca completata',
  );

  // Se l'autopilota è attivo, la stesura parte subito.
  if (nextStatus === 'generating') {
    await ctx.enqueue({
      type: 'article_generate',
      organizationId: job.organizationId,
      productId: row.productId,
      targetId: articleId,
      payload: { autoApproved: true },
      discriminator: `auto-after-research-${Date.now()}`,
    });
  }
}
