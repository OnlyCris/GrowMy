import type { GscQueryInsight } from '@growmy/ai';
import { getWorkerDb, gscDailyMetrics } from '@growmy/db';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

/**
 * LETTURA DEI DATI SEARCH CONSOLE PER I PROMPT.
 *
 * È il punto in cui il closed-loop si chiude davvero. Il planner produce
 * decisioni che un umano legge; queste funzioni fanno qualcosa di più diretto:
 * mettono le ricerche reali dentro il prompt, così l'articolo successivo nasce
 * già informato su cosa il pubblico cerca davvero.
 *
 * TUTTE RITORNANO UN ARRAY VUOTO SENZA DATI, e non è un dettaglio: la maggior
 * parte dei prodotti non ha Search Console collegata, e la pipeline editoriale
 * deve funzionare esattamente come prima per loro. Nessuna di queste funzioni
 * può far fallire una generazione — al massimo la lascia meno informata.
 */

/** Coerente con la finestra del planner e della pagina Analitiche. */
const WINDOW_DAYS = 28;

/** Righe passate al modello. Oltre una dozzina il segnale si diluisce e il
 *  prompt si allunga senza che le ultime righe cambino l'esito. */
const DEFAULT_LIMIT = 12;

function windowStart(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - WINDOW_DAYS);
  return date.toISOString().slice(0, 10);
}

/** Posizione media pesata sulle impression, come ovunque nel progetto. */
const weightedPosition = sql<number>`(sum(${gscDailyMetrics.position} * ${gscDailyMetrics.impressions}) / nullif(sum(${gscDailyMetrics.impressions}), 0))::float`;

/**
 * Parole significative di una keyword, per la ricerca di ricerche correlate.
 *
 * Scarta i token corti: sotto i quattro caratteri sono quasi sempre articoli e
 * preposizioni ("il", "di", "per", "con"), e un `ILIKE '%per%'` corrisponde a
 * mezzo database — restituendo come "correlate" ricerche che non c'entrano
 * nulla. Con il prompt che invita a ignorare le righe non pertinenti il danno
 * sarebbe limitato, ma occuperebbe comunque lo spazio delle righe utili.
 */
function significantTokens(term: string): string[] {
  return [
    ...new Set(
      term
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 4),
    ),
  ];
}

/**
 * Ricerche reali correlate a una keyword.
 *
 * La corrispondenza è lessicale (`ILIKE` sui token), non semantica. Uno schema
 * `embedding` esiste su `keywords` e permetterebbe di fare di meglio, ma
 * richiederebbe di calcolare un embedding per ogni riga di
 * `gsc_daily_metrics` — che è la tabella più voluminosa del sistema. La
 * corrispondenza lessicale copre il caso che conta (varianti e long-tail dello
 * stesso tema condividono quasi sempre le parole portanti) a costo zero.
 */
export async function loadGscInsightsForKeyword(
  productId: string,
  term: string,
  limit = DEFAULT_LIMIT,
): Promise<GscQueryInsight[]> {
  const tokens = significantTokens(term);
  if (tokens.length === 0) return [];

  const patterns = tokens.map((token) => `%${token}%`);
  const db = getWorkerDb();

  const rows = await db
    .select({
      query: gscDailyMetrics.query,
      clicks: sql<number>`sum(${gscDailyMetrics.clicks})::int`,
      impressions: sql<number>`sum(${gscDailyMetrics.impressions})::int`,
      position: weightedPosition,
    })
    .from(gscDailyMetrics)
    .where(
      and(
        eq(gscDailyMetrics.productId, productId),
        gte(gscDailyMetrics.date, windowStart()),
        sql`${gscDailyMetrics.query} ilike any(${patterns}::text[])`,
      ),
    )
    .groupBy(gscDailyMetrics.query)
    // Impression e non clic: una ricerca vista mille volte e mai cliccata è
    // precisamente il buco che vogliamo far coprire all'articolo. Ordinando
    // per clic mostreremmo solo ciò che già funziona.
    .orderBy(desc(sql`sum(${gscDailyMetrics.impressions})`))
    .limit(limit);

  return rows.map((row) => ({
    query: row.query,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position ?? 0,
  }));
}

/** Ricerche su cui una pagina specifica ha già impression. Per i rifacimenti. */
export async function loadGscInsightsForPage(
  productId: string,
  page: string,
  limit = DEFAULT_LIMIT,
): Promise<GscQueryInsight[]> {
  const db = getWorkerDb();

  const rows = await db
    .select({
      query: gscDailyMetrics.query,
      clicks: sql<number>`sum(${gscDailyMetrics.clicks})::int`,
      impressions: sql<number>`sum(${gscDailyMetrics.impressions})::int`,
      position: weightedPosition,
    })
    .from(gscDailyMetrics)
    .where(
      and(
        eq(gscDailyMetrics.productId, productId),
        gte(gscDailyMetrics.date, windowStart()),
        // Confronto con e senza barra finale: Search Console e i CMS non
        // concordano su quel carattere, e un mismatch azzererebbe il risultato.
        sql`rtrim(${gscDailyMetrics.page}, '/') = rtrim(${page}, '/')`,
      ),
    )
    .groupBy(gscDailyMetrics.query)
    .orderBy(desc(sql`sum(${gscDailyMetrics.impressions})`))
    .limit(limit);

  return rows.map((row) => ({
    query: row.query,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position ?? 0,
  }));
}

/**
 * Opportunità in striking distance del prodotto, per la ricerca keyword.
 *
 * Il filtro sulla fascia 8-20 sta nell'HAVING e non in JavaScript: la fascia è
 * l'unica parte del risultato che serve qui, e trascinare in memoria l'intera
 * tabella per poi scartarne il 95% sarebbe uno spreco su quella che è la
 * tabella più voluminosa del sistema.
 */
export async function loadGscOpportunities(
  productId: string,
  limit = 15,
): Promise<GscQueryInsight[]> {
  const db = getWorkerDb();

  const rows = await db
    .select({
      query: gscDailyMetrics.query,
      clicks: sql<number>`sum(${gscDailyMetrics.clicks})::int`,
      impressions: sql<number>`sum(${gscDailyMetrics.impressions})::int`,
      position: weightedPosition,
    })
    .from(gscDailyMetrics)
    .where(
      and(
        eq(gscDailyMetrics.productId, productId),
        gte(gscDailyMetrics.date, windowStart()),
      ),
    )
    .groupBy(gscDailyMetrics.query)
    .having(
      sql`(sum(${gscDailyMetrics.position} * ${gscDailyMetrics.impressions}) / nullif(sum(${gscDailyMetrics.impressions}), 0)) between 8 and 20
          and sum(${gscDailyMetrics.impressions}) >= 30`,
    )
    .orderBy(desc(sql`sum(${gscDailyMetrics.impressions})`))
    .limit(limit);

  return rows.map((row) => ({
    query: row.query,
    clicks: row.clicks,
    impressions: row.impressions,
    position: row.position ?? 0,
  }));
}
