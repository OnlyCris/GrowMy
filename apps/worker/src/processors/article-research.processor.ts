import { parseJsonResponse, briefPrompt, type BrandContext } from '@growmy/ai';
import { stateAfterResearch } from '@growmy/core';
import {
  articles,
  getWorkerDb,
  keywordClusters,
  keywords,
  productBrandProfiles,
  products,
} from '@growmy/db';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import {
  loadGscInsightsForKeyword,
  loadGscInsightsForPage,
} from '../lib/gsc-insights';
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
      // Serve solo al caso rigenerazione: se l'articolo è già stato pubblicato
      // una volta, Search Console ha dati sulla sua pagina.
      articlePublishedUrl: articles.publishedUrl,
      keywordTerm: keywords.term,
      keywordIsPillar: keywords.isPillar,
      clusterId: keywords.clusterId,
      productId: products.id,
      productName: products.name,
      domain: products.domain,
      websiteUrl: products.websiteUrl,
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
    websiteUrl: row.websiteUrl,
    language: row.contentLanguage,
    businessSummary: row.businessSummary,
    targetAudience: row.targetAudience,
    valueProposition: row.valueProposition,
    toneOfVoice: row.toneOfVoice,
    forbiddenTopics: (row.forbiddenTopics as string[] | null) ?? [],
  };

  // --- Cluster tematico: pillar e compagni ---------------------------------
  // Se la keyword appartiene a un cluster (vedi `keyword-research.processor`),
  // il modello hub-and-spoke richiede due cose distinte da un generico elenco
  // di "altri articoli": SAPERE chi è il pillar (per linkarlo obbligatoriamente
  // se questo articolo non lo è) e dare PRIORITÀ ai compagni dello stesso
  // cluster nell'elenco generico di link interni, non un peso uguale a
  // qualunque altro articolo del prodotto.
  let clusterName: string | null = null;
  let pillarArticle: { articleId: string; title: string; slug: string } | null = null;

  if (row.clusterId) {
    const [cluster] = await db
      .select({ name: keywordClusters.name, pillarArticleId: keywordClusters.pillarArticleId })
      .from(keywordClusters)
      .where(eq(keywordClusters.id, row.clusterId))
      .limit(1);

    clusterName = cluster?.name ?? null;

    if (cluster?.pillarArticleId && cluster.pillarArticleId !== articleId) {
      const [pillar] = await db
        .select({ id: articles.id, title: articles.title, slug: articles.slug })
        .from(articles)
        .where(
          and(
            eq(articles.id, cluster.pillarArticleId),
            inArray(articles.status, ['published', 'approved']),
            isNotNull(articles.slug),
            isNull(articles.deletedAt),
          ),
        )
        .limit(1);

      if (pillar) {
        pillarArticle = { articleId: pillar.id, title: pillar.title ?? '', slug: pillar.slug ?? '' };
      }
    }
  }

  // --- Candidati per i link interni ---------------------------------------
  // Pubblicati O approvati: un articolo `approved` è già in coda di
  // pubblicazione (stessa infornata editoriale) e avrà uno slug stabile prima
  // che questo venga letto — restringere a solo `published` significa che il
  // primissimo lotto di articoli di un prodotto non riesce mai a linkarsi a
  // vicenda, perché nessuno dei fratelli è ancora `published` quando la
  // ricerca di ciascuno parte. `draft_ready`/`brief_ready` restano esclusi:
  // potrebbero ancora essere rifiutati, e lo slug non è definitivo.
  //
  // Compagni dello stesso cluster PRIMA, il resto del prodotto dopo: è quello
  // che rende i link davvero pertinenti invece che "un articolo qualunque che
  // esisteva già" — la lamentela che ha motivato questo intero giro di lavoro.
  const linkCandidates = await recorder.step(
    'research.internal_links',
    'Raccolta degli articoli collegabili',
    async () => {
      const excludeIds = new Set([articleId, ...(pillarArticle ? [pillarArticle.articleId] : [])]);

      const clusterMates = row.clusterId
        ? await db
            .select({ articleId: articles.id, title: articles.title, slug: articles.slug })
            .from(articles)
            .innerJoin(keywords, eq(keywords.id, articles.keywordId))
            .where(
              and(
                eq(keywords.clusterId, row.clusterId),
                inArray(articles.status, ['published', 'approved']),
                isNotNull(articles.slug),
                isNull(articles.deletedAt),
              ),
            )
            .limit(20)
        : [];

      const productWide = await db
        .select({ articleId: articles.id, title: articles.title, slug: articles.slug })
        .from(articles)
        .where(
          and(
            eq(articles.productId, row.productId),
            inArray(articles.status, ['published', 'approved']),
            isNotNull(articles.slug),
            isNull(articles.deletedAt),
          ),
        )
        .limit(20);

      // Compagni di cluster prima (ordine preservato), il resto del prodotto
      // dopo — dedup su prima occorrenza, così i compagni vincono sempre.
      const seen = new Set<string>();
      const deduped: typeof clusterMates = [];
      for (const candidate of [...clusterMates, ...productWide]) {
        if (excludeIds.has(candidate.articleId) || seen.has(candidate.articleId)) continue;
        seen.add(candidate.articleId);
        deduped.push(candidate);
      }
      return deduped.slice(0, 20);
    },
  );

  /**
   * --- Dati reali di Search Console (UPGRADE #2, lato generazione) ---------
   *
   * Il resto del brief è costruito su ciò che il modello immagina cerchi il
   * lettore. Queste righe sono l'unica parte che glielo dice: ricerche che
   * hanno davvero portato questo sito in SERP nelle ultime quattro settimane.
   *
   * Entrambe vuote quando il prodotto non ha Search Console collegata, ed è la
   * condizione normale per la maggior parte dei prodotti: il brief si genera
   * esattamente come prima, solo con meno contesto. Nessuna generazione può
   * fallire per la mancanza di questi dati.
   */
  const [gscInsights, gscPageInsights] = await recorder.step(
    'research.gsc',
    'Lettura delle ricerche reali da Search Console',
    async () =>
      Promise.all([
        loadGscInsightsForKeyword(row.productId, row.keywordTerm!),
        row.articlePublishedUrl
          ? loadGscInsightsForPage(row.productId, row.articlePublishedUrl)
          : Promise.resolve([]),
      ]),
  );

  // --- Generazione del brief ----------------------------------------------
  const result = await recorder.step(
    'research.brief',
    gscInsights.length > 0
      ? `Progettazione della struttura per «${row.keywordTerm}», su ${gscInsights.length} ricerche reali`
      : `Progettazione della struttura per «${row.keywordTerm}»`,
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
          isPillar: row.keywordIsPillar ?? false,
          clusterName,
          pillarArticle,
          humanFeedback: payload.humanFeedback,
          gscInsights,
          gscPageInsights,
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

  // Filtra internalLinkTargets sui SOLI candidati realmente offerti: nulla
  // vieta al modello di restituire un articleId/slug mai proposto, e quel
  // valore finirebbe fidato ciecamente dalla stesura più avanti — è la stessa
  // disciplina applicata al markdown finale in article-generate.processor.ts,
  // qui applicata alla fonte prima che l'errore possa propagarsi.
  const offeredArticleIds = new Set([
    ...linkCandidates.map((c) => c.articleId),
    ...(pillarArticle ? [pillarArticle.articleId] : []),
  ]);
  if (Array.isArray(brief.internalLinkTargets)) {
    brief.internalLinkTargets = (
      brief.internalLinkTargets as Array<Record<string, unknown>>
    ).filter(
      (t) => typeof t.articleId === 'string' && offeredArticleIds.has(t.articleId),
    );
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
