import 'server-only';

import {
  articles,
  cannibalizationIssues,
  db,
  gscConnections,
  gscDailyMetrics,
  plannerDecisions,
  products,
} from '@growmy/db';
import {
  findStrikingDistanceOpportunities,
  type StrikingDistanceOpportunity,
} from '@growmy/core';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

/**
 * QUERY DELLE ANALITICHE.
 *
 * Stessa disciplina del resto di `lib/queries/`: `server-only`, select
 * esplicite, scope del tenant in ogni WHERE anche con RLS attivo.
 *
 * UNA NOTA SULLE MEDIE. `position` e `ctr` non si mediano con `avg()`: sono
 * già medie, e mediare medie dà un peso identico a un giorno con 5000
 * impression e a uno con 3. Ovunque qui la posizione media è
 * `sum(position * impressions) / sum(impressions)` e il CTR è
 * `sum(clicks) / sum(impressions)` — ricalcolato dai totali, non mediato.
 * È la differenza fra un numero che coincide con quello mostrato da Search
 * Console e uno che gli somiglia soltanto.
 */

/** Finestra di analisi predefinita. 28 giorni = 4 settimane intere: neutralizza
 *  la stagionalità settimanale, che su query B2B è marcata (crollo nel weekend). */
export const ANALYTICS_WINDOW_DAYS = 28;

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Connessione
// ---------------------------------------------------------------------------

export interface GscConnectionSummary {
  id: string;
  siteUrl: string;
  connectedEmail: string | null;
  lastSyncedAt: Date | null;
  lastSyncedDate: string | null;
  lastSyncError: string | null;
}

/**
 * Connessione attiva del prodotto.
 *
 * Le colonne cifrate sono deliberatamente assenti dalla select — e non per
 * pudore: `app_user` non ha nemmeno la GRANT per leggerle (vedi
 * `0001_rls_policies.sql`), quindi un `select *` qui fallirebbe. L'elenco
 * esplicito rende visibile il confine invece di lasciarlo scoprire a runtime.
 */
export async function getGscConnection(
  organizationId: string,
  productId: string,
): Promise<GscConnectionSummary | null> {
  const [row] = await db
    .select({
      id: gscConnections.id,
      siteUrl: gscConnections.siteUrl,
      connectedEmail: gscConnections.connectedEmail,
      lastSyncedAt: gscConnections.lastSyncedAt,
      lastSyncedDate: gscConnections.lastSyncedDate,
      lastSyncError: gscConnections.lastSyncError,
    })
    .from(gscConnections)
    .where(
      and(
        eq(gscConnections.productId, productId),
        eq(gscConnections.organizationId, organizationId),
        eq(gscConnections.isActive, true),
      ),
    )
    .limit(1);

  return row ?? null;
}

// ---------------------------------------------------------------------------
// Riepilogo
// ---------------------------------------------------------------------------

export interface PeriodTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface AnalyticsSummary {
  current: PeriodTotals;
  previous: PeriodTotals;
  /** Giorni distinti con dati nella finestra corrente: distingue "zero clic" da "nessun dato". */
  daysWithData: number;
}

/**
 * Totali della finestra corrente e di quella precedente di pari durata.
 *
 * Un'unica query con `FILTER` invece di due: il costo dominante è la scansione
 * dell'intervallo di date, e farla due volte per gli stessi giorni raddoppia il
 * lavoro senza aggiungere nulla.
 */
export async function getAnalyticsSummary(
  productId: string,
  windowDays: number = ANALYTICS_WINDOW_DAYS,
): Promise<AnalyticsSummary> {
  const currentStart = isoDaysAgo(windowDays);
  const previousStart = isoDaysAgo(windowDays * 2);

  const [row] = await db
    .select({
      currentClicks: sql<number>`coalesce(sum(${gscDailyMetrics.clicks}) filter (where ${gscDailyMetrics.date} >= ${currentStart}), 0)::int`,
      currentImpressions: sql<number>`coalesce(sum(${gscDailyMetrics.impressions}) filter (where ${gscDailyMetrics.date} >= ${currentStart}), 0)::int`,
      currentPositionWeighted: sql<number>`coalesce(sum(${gscDailyMetrics.position} * ${gscDailyMetrics.impressions}) filter (where ${gscDailyMetrics.date} >= ${currentStart}), 0)::float`,
      previousClicks: sql<number>`coalesce(sum(${gscDailyMetrics.clicks}) filter (where ${gscDailyMetrics.date} < ${currentStart}), 0)::int`,
      previousImpressions: sql<number>`coalesce(sum(${gscDailyMetrics.impressions}) filter (where ${gscDailyMetrics.date} < ${currentStart}), 0)::int`,
      previousPositionWeighted: sql<number>`coalesce(sum(${gscDailyMetrics.position} * ${gscDailyMetrics.impressions}) filter (where ${gscDailyMetrics.date} < ${currentStart}), 0)::float`,
      daysWithData: sql<number>`count(distinct ${gscDailyMetrics.date}) filter (where ${gscDailyMetrics.date} >= ${currentStart})::int`,
    })
    .from(gscDailyMetrics)
    .where(
      and(
        eq(gscDailyMetrics.productId, productId),
        gte(gscDailyMetrics.date, previousStart),
      ),
    );

  const build = (
    clicks: number,
    impressions: number,
    positionWeighted: number,
  ): PeriodTotals => ({
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? positionWeighted / impressions : 0,
  });

  return {
    current: build(
      row?.currentClicks ?? 0,
      row?.currentImpressions ?? 0,
      row?.currentPositionWeighted ?? 0,
    ),
    previous: build(
      row?.previousClicks ?? 0,
      row?.previousImpressions ?? 0,
      row?.previousPositionWeighted ?? 0,
    ),
    daysWithData: row?.daysWithData ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Top query e top pagine
// ---------------------------------------------------------------------------

export interface TopQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function getTopQueries(
  productId: string,
  limit = 10,
  windowDays: number = ANALYTICS_WINDOW_DAYS,
): Promise<TopQueryRow[]> {
  const rows = await db
    .select({
      query: gscDailyMetrics.query,
      clicks: sql<number>`sum(${gscDailyMetrics.clicks})::int`,
      impressions: sql<number>`sum(${gscDailyMetrics.impressions})::int`,
      positionWeighted: sql<number>`sum(${gscDailyMetrics.position} * ${gscDailyMetrics.impressions})::float`,
    })
    .from(gscDailyMetrics)
    .where(
      and(
        eq(gscDailyMetrics.productId, productId),
        gte(gscDailyMetrics.date, isoDaysAgo(windowDays)),
      ),
    )
    .groupBy(gscDailyMetrics.query)
    .orderBy(desc(sql`sum(${gscDailyMetrics.clicks})`))
    .limit(limit);

  return rows.map((r) => ({
    query: r.query,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    position: r.impressions > 0 ? r.positionWeighted / r.impressions : 0,
  }));
}

export interface TopPageRow {
  page: string;
  articleId: string | null;
  articleTitle: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function getTopPages(
  productId: string,
  limit = 10,
  windowDays: number = ANALYTICS_WINDOW_DAYS,
): Promise<TopPageRow[]> {
  const rows = await db
    .select({
      page: gscDailyMetrics.page,
      // `max()` e non `min()` per una ragione pratica: `article_id` è NULL
      // finché il sync non riesce ad associare l'URL a un articolo, e in
      // Postgres gli aggregati ignorano i NULL — quindi se anche una sola riga
      // del gruppo è associata, il gruppo intero risulta associato.
      articleId: sql<string | null>`max(${gscDailyMetrics.articleId}::text)`,
      clicks: sql<number>`sum(${gscDailyMetrics.clicks})::int`,
      impressions: sql<number>`sum(${gscDailyMetrics.impressions})::int`,
      positionWeighted: sql<number>`sum(${gscDailyMetrics.position} * ${gscDailyMetrics.impressions})::float`,
    })
    .from(gscDailyMetrics)
    .where(
      and(
        eq(gscDailyMetrics.productId, productId),
        gte(gscDailyMetrics.date, isoDaysAgo(windowDays)),
      ),
    )
    .groupBy(gscDailyMetrics.page)
    .orderBy(desc(sql`sum(${gscDailyMetrics.clicks})`))
    .limit(limit);

  const articleIds = rows
    .map((r) => r.articleId)
    .filter((id): id is string => Boolean(id));

  const titles = new Map<string, string>();
  if (articleIds.length > 0) {
    const titleRows = await db
      .select({ id: articles.id, title: articles.title })
      .from(articles)
      .where(
        and(
          eq(articles.productId, productId),
          isNull(articles.deletedAt),
          inArray(articles.id, articleIds),
        ),
      );

    for (const row of titleRows) {
      if (row.title) titles.set(row.id, row.title);
    }
  }

  return rows.map((r) => ({
    page: r.page,
    articleId: r.articleId,
    articleTitle: r.articleId ? (titles.get(r.articleId) ?? null) : null,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    position: r.impressions > 0 ? r.positionWeighted / r.impressions : 0,
  }));
}

// ---------------------------------------------------------------------------
// Striking distance
// ---------------------------------------------------------------------------

/**
 * Opportunità in striking distance.
 *
 * L'aggregazione avviene in SQL (dove i dati sono) e il punteggio in
 * `@growmy/core` (dove la regola è testabile senza database). Il filtro sulla
 * fascia 8-20 è ripetuto nella clausola HAVING anche se `findStrikingDistance
 * Opportunities` lo riapplica: serve a non trascinare in memoria decine di
 * migliaia di righe che verrebbero comunque scartate.
 */
export async function getStrikingDistanceOpportunities(
  productId: string,
  limit = 20,
  windowDays: number = ANALYTICS_WINDOW_DAYS,
): Promise<StrikingDistanceOpportunity[]> {
  const weightedPosition = sql<number>`(sum(${gscDailyMetrics.position} * ${gscDailyMetrics.impressions}) / nullif(sum(${gscDailyMetrics.impressions}), 0))`;

  const rows = await db
    .select({
      query: gscDailyMetrics.query,
      page: gscDailyMetrics.page,
      articleId: sql<string | null>`max(${gscDailyMetrics.articleId}::text)`,
      clicks: sql<number>`sum(${gscDailyMetrics.clicks})::int`,
      impressions: sql<number>`sum(${gscDailyMetrics.impressions})::int`,
      position: sql<number>`${weightedPosition}::float`,
    })
    .from(gscDailyMetrics)
    .where(
      and(
        eq(gscDailyMetrics.productId, productId),
        gte(gscDailyMetrics.date, isoDaysAgo(windowDays)),
      ),
    )
    .groupBy(gscDailyMetrics.query, gscDailyMetrics.page)
    .having(sql`${weightedPosition} between 8 and 20 and sum(${gscDailyMetrics.impressions}) >= 30`)
    .orderBy(desc(sql`sum(${gscDailyMetrics.impressions})`))
    // Un margine sul limite finale: il punteggio riordina, quindi tagliare
    // esattamente a `limit` qui scarterebbe righe che il punteggio avrebbe
    // promosso in cima.
    .limit(limit * 5);

  return findStrikingDistanceOpportunities(rows, { limit });
}

// ---------------------------------------------------------------------------
// Cannibalizzazioni e decisioni del planner
// ---------------------------------------------------------------------------

export interface CannibalizationRow {
  id: string;
  query: string;
  competingPages: Array<{
    page: string;
    articleId: string | null;
    clicks: number;
    impressions: number;
    position: number;
  }>;
  severity: string;
  recommendedAction: string;
  detectedAt: Date;
}

/** Solo le aperte: le risolte restano a database per lo storico, non in UI. */
export async function getOpenCannibalizationIssues(
  productId: string,
  limit = 20,
): Promise<CannibalizationRow[]> {
  return db
    .select({
      id: cannibalizationIssues.id,
      query: cannibalizationIssues.query,
      competingPages: cannibalizationIssues.competingPages,
      severity: cannibalizationIssues.severity,
      recommendedAction: cannibalizationIssues.recommendedAction,
      detectedAt: cannibalizationIssues.detectedAt,
    })
    .from(cannibalizationIssues)
    .where(
      and(
        eq(cannibalizationIssues.productId, productId),
        isNull(cannibalizationIssues.resolvedAt),
      ),
    )
    .orderBy(desc(cannibalizationIssues.detectedAt))
    .limit(limit);
}

export interface PlannerDecisionRow {
  id: string;
  decision: string;
  rationale: string;
  evidence: Record<string, unknown>;
  keywordId: string | null;
  articleId: string | null;
  createdAt: Date;
}

/** Log delle decisioni: è la risposta alla domanda «perché questa keyword?». */
export async function getPlannerDecisions(
  productId: string,
  limit = 25,
): Promise<PlannerDecisionRow[]> {
  return db
    .select({
      id: plannerDecisions.id,
      decision: plannerDecisions.decision,
      rationale: plannerDecisions.rationale,
      evidence: plannerDecisions.evidence,
      keywordId: plannerDecisions.keywordId,
      articleId: plannerDecisions.articleId,
      createdAt: plannerDecisions.createdAt,
    })
    .from(plannerDecisions)
    .where(eq(plannerDecisions.productId, productId))
    .orderBy(desc(plannerDecisions.createdAt))
    .limit(limit);
}

/** Risale dall'id di una cannibalizzazione al tenant, per il wrapper delle azioni. */
export async function getCannibalizationOrganizationId(
  issueId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: products.organizationId })
    .from(cannibalizationIssues)
    .innerJoin(products, eq(products.id, cannibalizationIssues.productId))
    .where(eq(cannibalizationIssues.id, issueId))
    .limit(1);

  return row?.organizationId ?? null;
}
