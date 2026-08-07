import {
  keywordResearchPrompt,
  parseJsonResponse,
  type BrandContext,
  type KeywordResearchResult,
} from '@growmy/ai';
import { getWorkerDb, keywords, productBrandProfiles, products } from '@growmy/db';
import { and, eq, isNull } from 'drizzle-orm';

import type { ProcessorContext } from './types';

/**
 * PROCESSORE DI RICERCA KEYWORD — propone keyword nuove per un prodotto.
 *
 * Non genera per massimizzare la copertura: `keywordResearchPrompt` chiede
 * esplicitamente long-tail coerenti con l'attività, non termini generici ad
 * altissimo volume — la stessa disciplina già applicata alla scrittura degli
 * articoli (vedi EDITOR_SYSTEM: correlazione reale col prodotto, non la
 * keyword come pretesto).
 *
 * Le keyword proposte entrano con `status: 'suggested'`: un umano le
 * approva o le scarta dalla pagina Keyword prima che possano generare un
 * articolo — stessa filosofia del cancello di revisione appena introdotto
 * per bozze e brief, non un'eccezione.
 */

interface KeywordResearchPayload {
  count?: number;
}

const DEFAULT_COUNT = 8;

export async function processKeywordResearch(
  ctx: ProcessorContext,
): Promise<void> {
  const db = getWorkerDb();
  const { recorder, llm, logger, job } = ctx;
  const productId = job.targetId;

  if (!productId) {
    throw new Error('Job di ricerca keyword senza targetId: prodotto non identificabile.');
  }

  const payload = (job.payload ?? {}) as KeywordResearchPayload;
  const count = payload.count ?? DEFAULT_COUNT;

  const [row] = await db
    .select({
      productName: products.name,
      domain: products.domain,
      websiteUrl: products.websiteUrl,
      contentLanguage: products.contentLanguage,
      businessSummary: productBrandProfiles.businessSummary,
      targetAudience: productBrandProfiles.targetAudience,
      valueProposition: productBrandProfiles.valueProposition,
      toneOfVoice: productBrandProfiles.toneOfVoice,
      forbiddenTopics: productBrandProfiles.forbiddenTopics,
    })
    .from(products)
    .leftJoin(productBrandProfiles, eq(productBrandProfiles.productId, products.id))
    .where(eq(products.id, productId))
    .limit(1);

  if (!row) {
    throw new Error(`Prodotto ${productId} non trovato.`);
  }

  const brand: BrandContext = {
    productName: row.productName,
    domain: row.domain,
    websiteUrl: row.websiteUrl,
    language: row.contentLanguage,
    businessSummary: row.businessSummary,
    targetAudience: row.targetAudience,
    valueProposition: row.valueProposition,
    toneOfVoice: row.toneOfVoice,
    forbiddenTopics: (row.forbiddenTopics as string[] | null) ?? [],
  };

  // Evita di riproporre keyword già esistenti (di qualunque stato: anche una
  // scartata non va riproposta identica, l'umano ha già deciso).
  const existing = await recorder.step(
    'keyword_research.existing',
    'Raccolta delle keyword già presenti',
    async () =>
      db
        .select({ term: keywords.term })
        .from(keywords)
        .where(and(eq(keywords.productId, productId), isNull(keywords.deletedAt))),
  );

  const result = await recorder.step(
    'keyword_research.propose',
    `Ricerca di ${count} keyword pertinenti`,
    async () =>
      llm.complete({
        messages: keywordResearchPrompt({
          brand,
          count,
          existingKeywords: existing.map((k) => k.term),
        }),
        jsonMode: true,
        temperature: 0.8,
      }),
  );

  const parsed = parseJsonResponse<KeywordResearchResult>(result.text);

  if (!Array.isArray(parsed.keywords) || parsed.keywords.length === 0) {
    throw new Error('La ricerca keyword non ha prodotto proposte utilizzabili.');
  }

  const rows = parsed.keywords
    .map((k) => ({
      term: k.term?.trim().toLowerCase(),
      searchIntent: k.searchIntent,
      estimatedVolume: k.estimatedVolume,
      estimatedDifficulty: k.estimatedDifficulty,
      rationale: k.rationale,
    }))
    .filter((k): k is typeof k & { term: string } => Boolean(k.term));

  const inserted = rows.length
    ? await db
        .insert(keywords)
        .values(
          rows.map((k) => ({
            organizationId: job.organizationId,
            productId,
            term: k.term,
            status: 'suggested' as const,
            source: 'ai_research' as const,
            searchVolume: Number.isFinite(k.estimatedVolume) ? Math.round(k.estimatedVolume) : null,
            difficulty: Number.isFinite(k.estimatedDifficulty)
              ? String(Math.min(100, Math.max(0, k.estimatedDifficulty)))
              : null,
            searchIntent: k.searchIntent ?? null,
            priorityRationale: k.rationale ?? null,
          })),
        )
        // Una keyword già esistente per questo prodotto (stesso termine,
        // case-insensitive) viene saltata invece di far fallire l'intero lotto:
        // `keywords_product_term_uq` la respingerebbe comunque.
        .onConflictDoNothing()
        .returning({ id: keywords.id })
    : [];

  await recorder.event({
    step: 'keyword_research.done',
    message: `${inserted.length} nuove keyword proposte, in attesa di revisione.`,
    details: {
      proposed: rows.length,
      inserted: inserted.length,
      provider: result.provider,
      costMicroUsd: result.costMicroUsd,
    },
  });

  logger.info(
    { productId, proposed: rows.length, inserted: inserted.length, provider: result.provider },
    'ricerca keyword completata',
  );
}
