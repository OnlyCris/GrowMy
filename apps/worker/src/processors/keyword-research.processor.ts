import {
  keywordResearchPrompt,
  parseJsonResponse,
  type BrandContext,
  type KeywordResearchResult,
} from '@growmy/ai';
import {
  getWorkerDb,
  keywordClusters,
  keywords,
  productBrandProfiles,
  products,
} from '@growmy/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { ProcessorContext } from './types';

/**
 * PROCESSORE DI RICERCA KEYWORD — propone CLUSTER tematici per un prodotto,
 * non una lista piatta.
 *
 * Non genera per massimizzare la copertura: `keywordResearchPrompt` chiede
 * esplicitamente long-tail coerenti con l'attività, non termini generici ad
 * altissimo volume — la stessa disciplina già applicata alla scrittura degli
 * articoli (vedi EDITOR_SYSTEM: correlazione reale col prodotto, non la
 * keyword come pretesto).
 *
 * Ogni cluster ha una keyword PILLAR e keyword di supporto: è il modello
 * hub-and-spoke che costruisce autorità tematica invece di articoli isolati
 * — `keyword_clusters` esisteva già nello schema con un campo
 * `pillarArticleId` pensato esattamente per questo, mai popolato prima
 * d'ora. `article-research.processor.ts` lo usa per far linkare ogni
 * articolo di supporto al pillar del suo cluster.
 *
 * Le keyword proposte entrano con `status: 'suggested'`: un umano le
 * approva o le scarta dalla pagina Keyword prima che possano generare un
 * articolo — stessa filosofia del cancello di revisione già in vigore per
 * bozze e brief, non un'eccezione.
 */

interface KeywordResearchPayload {
  count?: number;
}

const DEFAULT_COUNT = 8;

interface KeywordRowInput {
  term: string;
  searchIntent?: string;
  estimatedVolume?: number;
  estimatedDifficulty?: number;
  rationale?: string;
}

function toInsertValues(
  k: KeywordRowInput,
  organizationId: string,
  productId: string,
  clusterId: string | null,
  isPillar: boolean,
) {
  return {
    organizationId,
    productId,
    clusterId,
    term: k.term,
    isPillar,
    status: 'suggested' as const,
    source: 'ai_research' as const,
    searchVolume: Number.isFinite(k.estimatedVolume) ? Math.round(k.estimatedVolume!) : null,
    difficulty: Number.isFinite(k.estimatedDifficulty)
      ? String(Math.min(100, Math.max(0, k.estimatedDifficulty!)))
      : null,
    searchIntent: k.searchIntent ?? null,
    priorityRationale: k.rationale ?? null,
  };
}

export async function processKeywordResearch(ctx: ProcessorContext): Promise<void> {
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
    `Ricerca di ${count} keyword pertinenti, organizzate per cluster`,
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

  if (!Array.isArray(parsed.clusters) || parsed.clusters.length === 0) {
    throw new Error('La ricerca keyword non ha prodotto cluster utilizzabili.');
  }

  let clustersCreated = 0;
  let clustersReused = 0;
  let keywordsInserted = 0;

  for (const cluster of parsed.clusters) {
    const clusterName = cluster.name?.trim();
    if (!clusterName || !cluster.pillarKeyword?.term?.trim()) continue;

    // Riusa un cluster con lo stesso nome (case-insensitive) invece di
    // accumulare duplicati a ogni giro di ricerca — un prodotto lavora sugli
    // stessi temi nel tempo, il cluster deve rinforzarsi, non frammentarsi.
    const [existingCluster] = await db
      .select({ id: keywordClusters.id })
      .from(keywordClusters)
      .where(
        and(
          eq(keywordClusters.productId, productId),
          sql`lower(${keywordClusters.name}) = lower(${clusterName})`,
        ),
      )
      .limit(1);

    let clusterId: string;
    if (existingCluster) {
      clusterId = existingCluster.id;
      clustersReused += 1;
    } else {
      const [created] = await db
        .insert(keywordClusters)
        .values({
          organizationId: job.organizationId,
          productId,
          name: clusterName,
        })
        .returning({ id: keywordClusters.id });
      clusterId = created.id;
      clustersCreated += 1;
    }

    const pillarTerm = cluster.pillarKeyword.term.trim().toLowerCase();
    const supportingRows = (cluster.supportingKeywords ?? [])
      .map((k) => ({ ...k, term: k.term?.trim().toLowerCase() }))
      .filter((k): k is typeof k & { term: string } => Boolean(k.term));

    const values = [
      toInsertValues(
        { ...cluster.pillarKeyword, term: pillarTerm },
        job.organizationId,
        productId,
        clusterId,
        true,
      ),
      ...supportingRows.map((k) =>
        toInsertValues(k, job.organizationId, productId, clusterId, false),
      ),
    ];

    const inserted = await db
      .insert(keywords)
      .values(values)
      // Una keyword già esistente per questo prodotto (stesso termine,
      // case-insensitive) viene saltata invece di far fallire l'intero lotto:
      // `keywords_product_term_uq` la respingerebbe comunque.
      .onConflictDoNothing()
      .returning({ id: keywords.id });

    keywordsInserted += inserted.length;
  }

  await recorder.event({
    step: 'keyword_research.done',
    message: `${keywordsInserted} nuove keyword proposte in ${clustersCreated + clustersReused} cluster (${clustersCreated} nuovi), in attesa di revisione.`,
    details: {
      keywordsInserted,
      clustersCreated,
      clustersReused,
      provider: result.provider,
      costMicroUsd: result.costMicroUsd,
    },
  });

  logger.info(
    { productId, keywordsInserted, clustersCreated, clustersReused, provider: result.provider },
    'ricerca keyword completata',
  );
}
