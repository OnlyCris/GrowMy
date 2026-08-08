import {
  detectCannibalization,
  findRefreshCandidates,
  findStrikingDistanceOpportunities,
  type AggregatedQueryMetrics,
  type ArticlePeriodMetrics,
} from '@growmy/core';
import {
  cannibalizationIssues,
  getWorkerDb,
  gscConnections,
  gscDailyMetrics,
  keywords,
  plannerDecisions,
  products,
} from '@growmy/db';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';

import type { ProcessorContext } from './types';

/**
 * CLOSED-LOOP PLANNER (UPGRADE #2).
 *
 * È il processore che chiude il ciclo: i dati reali di Search Console tornano
 * indietro e cambiano cosa la piattaforma scriverà la settimana prossima.
 * Senza di lui `gsc_daily_metrics` sarebbe un archivio con una pagina di
 * grafici davanti — che è esattamente ciò che fa la concorrenza.
 *
 * TRE ANALISI, TRE ESITI DIVERSI:
 *
 *  1. Striking distance → nuove keyword proposte (`suggested`).
 *  2. Cannibalizzazione → segnalazioni da chiudere a mano.
 *  3. Calo di rendimento → articoli da aggiornare.
 *
 * OGNI ESITO SCRIVE UNA RIGA IN `planner_decisions` con il perché in italiano e
 * i numeri che l'hanno prodotto. Non è telemetria: è la risposta alla domanda
 * «perché questa keyword questa settimana?», che l'utente può leggere in UI.
 *
 * LE KEYWORD ENTRANO COME PROPOSTE, MAI SCHEDULATE. Un dato reale è più solido
 * di una proposta generata, ma resta una proposta: la decisione di spendere un
 * credito è dell'utente. Stessa porta di revisione già in vigore per keyword
 * AI, brief e bozze — non un'eccezione perché "questi dati sono affidabili".
 */

/** Finestra di analisi. Coerente con `ANALYTICS_WINDOW_DAYS` lato web. */
const WINDOW_DAYS = 28;

/** Quante opportunità diventano keyword proposte per esecuzione. */
const MAX_NEW_KEYWORDS_PER_RUN = 5;

interface PlannerPayload {
  mode?: string;
}

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Aggregazioni
// ---------------------------------------------------------------------------

/**
 * Metriche per (query, pagina) sulla finestra corrente.
 *
 * La posizione media è pesata sulle impression, non aritmetica: mediare le
 * medie giornaliere darebbe lo stesso peso a un giorno da 2000 impression e a
 * uno da 3, e produrrebbe un numero che non coincide con quello di Search
 * Console — il primo confronto che farà chiunque guardi la pagina.
 */
async function loadQueryMetrics(
  productId: string,
  windowDays: number,
): Promise<AggregatedQueryMetrics[]> {
  const db = getWorkerDb();

  const rows = await db
    .select({
      query: gscDailyMetrics.query,
      page: gscDailyMetrics.page,
      articleId: sql<string | null>`max(${gscDailyMetrics.articleId}::text)`,
      clicks: sql<number>`sum(${gscDailyMetrics.clicks})::int`,
      impressions: sql<number>`sum(${gscDailyMetrics.impressions})::int`,
      position: sql<number>`(sum(${gscDailyMetrics.position} * ${gscDailyMetrics.impressions}) / nullif(sum(${gscDailyMetrics.impressions}), 0))::float`,
    })
    .from(gscDailyMetrics)
    .where(
      and(
        eq(gscDailyMetrics.productId, productId),
        gte(gscDailyMetrics.date, isoDaysAgo(windowDays)),
      ),
    )
    .groupBy(gscDailyMetrics.query, gscDailyMetrics.page);

  return rows.map((row) => ({
    query: row.query,
    page: row.page,
    articleId: row.articleId,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position ?? 0,
  }));
}

/** Metriche per articolo su una finestra delimitata da due date. */
async function loadArticleMetrics(
  productId: string,
  startDate: string,
  endDateExclusive: string,
): Promise<ArticlePeriodMetrics[]> {
  const db = getWorkerDb();

  const rows = await db
    .select({
      articleId: gscDailyMetrics.articleId,
      page: sql<string>`min(${gscDailyMetrics.page})`,
      clicks: sql<number>`sum(${gscDailyMetrics.clicks})::int`,
      impressions: sql<number>`sum(${gscDailyMetrics.impressions})::int`,
      position: sql<number>`(sum(${gscDailyMetrics.position} * ${gscDailyMetrics.impressions}) / nullif(sum(${gscDailyMetrics.impressions}), 0))::float`,
    })
    .from(gscDailyMetrics)
    .where(
      and(
        eq(gscDailyMetrics.productId, productId),
        gte(gscDailyMetrics.date, startDate),
        lt(gscDailyMetrics.date, endDateExclusive),
        // Solo le righe già associate a un articolo: l'analisi di refresh
        // riguarda contenuti che possiamo effettivamente aggiornare.
        sql`${gscDailyMetrics.articleId} is not null`,
      ),
    )
    .groupBy(gscDailyMetrics.articleId);

  return rows
    .filter((row): row is typeof row & { articleId: string } => row.articleId !== null)
    .map((row) => ({
      articleId: row.articleId,
      page: row.page,
      clicks: row.clicks,
      impressions: row.impressions,
      position: row.position ?? 0,
    }));
}

// ---------------------------------------------------------------------------
// Processore
// ---------------------------------------------------------------------------

export async function processPlannerRecalculate(
  ctx: ProcessorContext,
): Promise<void> {
  const db = getWorkerDb();
  const { recorder, logger, job } = ctx;
  const productId = job.productId ?? job.targetId;

  if (!productId) {
    throw new Error('Job del planner senza productId.');
  }

  const payload = (job.payload ?? {}) as PlannerPayload;

  /** Raggruppa tutte le decisioni di questa esecuzione: la UI può mostrarle insieme. */
  const runId = crypto.randomUUID();

  const queryMetrics = await recorder.step(
    'planner.load',
    'Lettura delle metriche di Search Console',
    () => loadQueryMetrics(productId, WINDOW_DAYS),
  );

  if (queryMetrics.length === 0) {
    await recorder.event({
      step: 'planner.no_data',
      message:
        'Nessun dato di Search Console nella finestra analizzata: niente da ricalcolare.',
    });
    return;
  }

  // --- 1. Striking distance → nuove keyword proposte -----------------------
  const opportunities = findStrikingDistanceOpportunities(queryMetrics, {
    limit: 50,
  });

  /**
   * Le keyword già presenti (in QUALUNQUE stato, comprese le scartate) non
   * vanno riproposte: se l'utente ne ha rifiutata una, ripresentargliela ogni
   * settimana perché i numeri non sono cambiati trasformerebbe il planner in
   * un assillo. Stessa logica già applicata in `keyword-research.processor.ts`.
   */
  const existingTerms = new Set(
    (
      await db
        .select({ term: keywords.term })
        .from(keywords)
        .where(and(eq(keywords.productId, productId), isNull(keywords.deletedAt)))
    ).map((row) => row.term.toLowerCase()),
  );

  const decisions: Array<typeof plannerDecisions.$inferInsert> = [];
  let keywordsCreated = 0;

  for (const opportunity of opportunities) {
    if (keywordsCreated >= MAX_NEW_KEYWORDS_PER_RUN) break;

    const term = opportunity.query.trim().toLowerCase();
    if (existingTerms.has(term)) continue;

    const [created] = await db
      .insert(keywords)
      .values({
        organizationId: job.organizationId,
        productId,
        term,
        status: 'suggested',
        source: 'gsc_striking_distance',
        searchVolume: opportunity.impressions,
        // Il punteggio dell'analisi diventa la priorità: le opportunità più
        // vicine e più remunerative salgono in cima alla coda di produzione.
        priorityScore: opportunity.score.toFixed(2),
        priorityRationale: opportunity.rationale,
      })
      .onConflictDoNothing()
      .returning({ id: keywords.id });

    if (!created) continue;

    existingTerms.add(term);
    keywordsCreated += 1;

    decisions.push({
      organizationId: job.organizationId,
      productId,
      runId,
      keywordId: created.id,
      decision: 'add_keyword',
      priorityAfter: opportunity.score.toFixed(2),
      rationale: opportunity.rationale,
      evidence: {
        query: opportunity.query,
        page: opportunity.page,
        impressions: opportunity.impressions,
        clicks: opportunity.clicks,
        position: Number(opportunity.position.toFixed(2)),
        estimatedClickGain: opportunity.estimatedClickGain,
        windowDays: WINDOW_DAYS,
      },
    });
  }

  // --- 2. Cannibalizzazione ------------------------------------------------
  const conflicts = detectCannibalization(queryMetrics);
  let conflictsRecorded = 0;

  for (const conflict of conflicts) {
    const [issue] = await db
      .insert(cannibalizationIssues)
      .values({
        productId,
        query: conflict.query,
        competingPages: conflict.competingPages.map((page) => ({
          page: page.page,
          articleId: page.articleId,
          clicks: page.clicks,
          impressions: page.impressions,
          position: Number(page.position.toFixed(2)),
        })),
        severity: conflict.severity,
        recommendedAction: conflict.recommendedAction,
      })
      /**
       * `cannibalization_product_query_open_uq` è un indice parziale su
       * `resolved_at is null`: una segnalazione ancora aperta sulla stessa
       * query non viene duplicata a ogni esecuzione settimanale. Una già
       * risolta invece può ricomparire, ed è corretto — significa che il
       * problema si è ripresentato dopo l'intervento.
       */
      .onConflictDoNothing()
      .returning({ id: cannibalizationIssues.id });

    if (!issue) continue;
    conflictsRecorded += 1;

    decisions.push({
      organizationId: job.organizationId,
      productId,
      runId,
      decision: 'flag_cannibalization',
      rationale: conflict.rationale,
      evidence: {
        query: conflict.query,
        severity: conflict.severity,
        wastedImpressions: conflict.wastedImpressions,
        competingPages: conflict.competingPages.length,
        windowDays: WINDOW_DAYS,
      },
    });
  }

  // --- 3. Articoli in calo -------------------------------------------------
  const currentStart = isoDaysAgo(WINDOW_DAYS);
  const previousStart = isoDaysAgo(WINDOW_DAYS * 2);
  // Estremo superiore esclusivo della finestra corrente: domani, così l'intera
  // giornata di oggi rientra. Le due finestre condividono `currentStart` come
  // confine — una esclusiva, l'altra inclusiva — quindi nessun giorno viene
  // contato due volte, che falserebbe il confronto in entrambe le direzioni.
  const currentEndExclusive = isoDaysAgo(-1);

  const [currentArticles, previousArticles] = await Promise.all([
    loadArticleMetrics(productId, currentStart, currentEndExclusive),
    loadArticleMetrics(productId, previousStart, currentStart),
  ]);

  const refreshCandidates = findRefreshCandidates(currentArticles, previousArticles);

  for (const candidate of refreshCandidates) {
    decisions.push({
      organizationId: job.organizationId,
      productId,
      runId,
      articleId: candidate.articleId,
      decision: 'schedule_refresh',
      priorityAfter: candidate.score.toFixed(2),
      rationale: candidate.rationale,
      evidence: {
        page: candidate.page,
        previousClicks: candidate.previousClicks,
        currentClicks: candidate.currentClicks,
        clicksChange: Number(candidate.clicksChange.toFixed(3)),
        positionChange: Number(candidate.positionChange.toFixed(2)),
        position: Number(candidate.currentPosition.toFixed(2)),
        windowDays: WINDOW_DAYS,
      },
    });
  }

  // --- Scrittura del registro ----------------------------------------------
  if (decisions.length > 0) {
    await db.insert(plannerDecisions).values(decisions);
  }

  await recorder.event({
    step: 'planner.done',
    message:
      `Ricalcolo completato: ${keywordsCreated} nuove keyword proposte, ` +
      `${conflictsRecorded} conflitti segnalati, ${refreshCandidates.length} articoli da aggiornare.`,
    details: {
      runId,
      keywordsCreated,
      conflictsRecorded,
      refreshCandidates: refreshCandidates.length,
      opportunitiesAnalysed: opportunities.length,
      mode: payload.mode ?? 'scheduled',
    },
  });

  logger.info(
    {
      productId,
      runId,
      keywordsCreated,
      conflictsRecorded,
      refreshCandidates: refreshCandidates.length,
    },
    'planner completato',
  );
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

/**
 * Cron settimanale: accoda un ricalcolo per ogni prodotto con Search Console
 * collegata. Stessa struttura del cron di sync, e per la stessa ragione — il
 * fallimento su un cliente non deve privare gli altri del ricalcolo.
 */
export async function processPlannerRecalculateCron(
  ctx: ProcessorContext,
): Promise<void> {
  const db = getWorkerDb();
  const { logger } = ctx;

  const connections = await db
    .select({
      productId: gscConnections.productId,
      organizationId: gscConnections.organizationId,
    })
    .from(gscConnections)
    .innerJoin(products, eq(products.id, gscConnections.productId))
    .where(
      and(
        eq(gscConnections.isActive, true),
        isNull(products.deletedAt),
        eq(products.status, 'active'),
      ),
    );

  let queued = 0;
  const week = new Date().toISOString().slice(0, 10);

  for (const connection of connections) {
    try {
      await ctx.enqueue({
        type: 'planner_recalculate',
        organizationId: connection.organizationId,
        productId: connection.productId,
        targetType: 'product',
        targetId: connection.productId,
        payload: { mode: 'scheduled' },
        discriminator: `weekly-${week}`,
        reserveCredit: false,
      });
      queued += 1;
    } catch (error) {
      logger.warn(
        {
          productId: connection.productId,
          err: error instanceof Error ? error.message : String(error),
        },
        'accodamento planner fallito per un prodotto',
      );
    }
  }

  logger.info({ queued, total: connections.length }, 'cron planner completato');
}
