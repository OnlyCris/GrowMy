import {
  articles,
  getWorkerDb,
  gscConnections,
  gscDailyMetrics,
  products,
} from '@growmy/db';
import {
  createCipherFromEnv,
  fetchGscMetrics,
  GscError,
  latestAvailableGscDate,
  refreshGscAccessToken,
  shiftIsoDate,
  type GscMetricRow,
} from '@growmy/integrations';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { ProcessorContext } from './types';

/**
 * PROCESSORE DI SINCRONIZZAZIONE SEARCH CONSOLE.
 *
 * Due modalità nello stesso processore, e non è pigrizia: la connessione È la
 * prima sincronizzazione. Separarle avrebbe richiesto un nuovo valore
 * nell'enum `job_type` (migrazione) per ottenere due processori che
 * condividono il 90% del corpo, con il secondo che accoda il primo.
 *
 *  - `mode: 'connect'` — il refresh token arriva in chiaro nel payload (la
 *    Server Action web non può cifrarlo, la chiave vive solo qui: stesso
 *    compromesso documentato in `integration-connect.processor.ts`). Lo
 *    verifichiamo, lo cifriamo, scriviamo la riga e proseguiamo con l'import.
 *  - `mode: 'sync'` — import incrementale dalla connessione già esistente.
 *
 * PERCHÉ L'IMPORT RIPARTE INDIETRO DI QUALCHE GIORNO
 * Google rivede i dati dei giorni recenti anche dopo averli pubblicati. Un
 * import che ripartisse esattamente dal giorno dopo l'ultimo salvato
 * fisserebbe per sempre i valori provvisori. Ripartire indietro e sovrascrivere
 * costa poche migliaia di righe e tiene i numeri allineati a quelli che
 * l'utente vede su Search Console — che è l'unico confronto che farà.
 */

interface GscSyncPayload {
  mode?: 'connect' | 'sync';
  siteUrl?: string;
  refreshToken?: string;
  connectedEmail?: string | null;
  connectedBy?: string;
}

/** Giorni di storico al primo import. Search Console ne conserva 16 mesi, ma
 *  tre mesi bastano a far partire il planner e non saturano la quota API. */
const INITIAL_HISTORY_DAYS = 90;

/** Giorni rifatti a ogni sync per assorbire le revisioni di Google. */
const REVISION_OVERLAP_DAYS = 3;

/** Righe per INSERT. Oltre, la query supera i limiti di parametri di node-postgres. */
const UPSERT_CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// Associazione URL → articolo
// ---------------------------------------------------------------------------

/**
 * Costruisce la mappa URL → articolo del prodotto.
 *
 * Due chiavi per articolo perché i due valori mancano in momenti diversi:
 * `publishedUrl` è l'URL reale restituito dal CMS ed è il confronto affidabile,
 * ma esiste solo dopo una pubblicazione riuscita; lo slug copre gli articoli
 * pubblicati prima che l'adapter iniziasse a restituire l'URL, e i CMS che non
 * lo restituiscono affatto.
 *
 * L'associazione è ciò che permette di legare le metriche all'articolo che le
 * ha generate — senza, l'analisi di refresh non avrebbe modo di sapere quale
 * contenuto sta calando.
 */
async function buildArticleUrlMap(
  productId: string,
): Promise<{ byUrl: Map<string, string>; bySlug: Map<string, string> }> {
  const db = getWorkerDb();

  const rows = await db
    .select({
      id: articles.id,
      slug: articles.slug,
      publishedUrl: articles.publishedUrl,
    })
    .from(articles)
    .where(and(eq(articles.productId, productId), isNull(articles.deletedAt)));

  const byUrl = new Map<string, string>();
  const bySlug = new Map<string, string>();

  for (const row of rows) {
    // Normalizza la barra finale: Search Console e i CMS non concordano, e un
    // disallineamento su quel singolo carattere azzererebbe l'associazione.
    if (row.publishedUrl) {
      byUrl.set(row.publishedUrl.replace(/\/$/, ''), row.id);
    }
    if (row.slug) {
      bySlug.set(row.slug.replace(/^\/|\/$/g, ''), row.id);
    }
  }

  return { byUrl, bySlug };
}

function resolveArticleId(
  page: string,
  maps: { byUrl: Map<string, string>; bySlug: Map<string, string> },
): string | null {
  const normalized = page.replace(/\/$/, '');

  const byUrl = maps.byUrl.get(normalized);
  if (byUrl) return byUrl;

  /**
   * Ripiego sullo slug: l'ultimo segmento del percorso. Deliberatamente
   * l'ULTIMO e non una ricerca per contenimento — `indexOf(slug)` produrrebbe
   * falsi positivi fra slug che sono prefissi l'uno dell'altro
   * (`/menu-digitale` associato erroneamente a `/menu-digitale-gratis`).
   */
  try {
    const path = new URL(normalized).pathname.replace(/^\/|\/$/g, '');
    const lastSegment = path.split('/').pop();
    if (lastSegment) return maps.bySlug.get(lastSegment) ?? null;
  } catch {
    // `page` non è un URL assoluto: non è un caso previsto da Search Console,
    // ma non è una ragione per far fallire l'intero import.
  }

  return null;
}

// ---------------------------------------------------------------------------
// Scrittura delle metriche
// ---------------------------------------------------------------------------

async function upsertMetrics(
  productId: string,
  rows: GscMetricRow[],
  maps: { byUrl: Map<string, string>; bySlug: Map<string, string> },
): Promise<number> {
  const db = getWorkerDb();
  let written = 0;

  for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + UPSERT_CHUNK_SIZE);

    await db
      .insert(gscDailyMetrics)
      .values(
        chunk.map((row) => ({
          productId,
          articleId: resolveArticleId(row.page, maps),
          date: row.date,
          page: row.page,
          query: row.query,
          country: row.country,
          device: row.device,
          clicks: row.clicks,
          impressions: row.impressions,
          // `numeric` in Drizzle si passa come stringa: un float perderebbe
          // precisione proprio sulle colonne su cui il planner fa i confronti.
          ctr: row.ctr.toFixed(5),
          position: row.position.toFixed(2),
        })),
      )
      /**
       * Sovrascrive i valori esistenti invece di ignorare il conflitto: è
       * l'intero motivo per cui rifacciamo gli ultimi giorni. Un
       * `onConflictDoNothing` lascerebbe a database i numeri provvisori.
       */
      .onConflictDoUpdate({
        target: [
          gscDailyMetrics.productId,
          gscDailyMetrics.date,
          gscDailyMetrics.page,
          gscDailyMetrics.query,
          gscDailyMetrics.country,
          gscDailyMetrics.device,
        ],
        /**
         * `excluded.<colonna>` è la riga che Postgres stava per inserire: nel
         * ramo di conflitto contiene i valori nuovi, mentre il nome nudo della
         * colonna si riferirebbe a quelli già a database — cioè scriverebbe il
         * vecchio valore sopra sé stesso, senza errore che lo segnali.
         */
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          ctr: sql`excluded.ctr`,
          position: sql`excluded.position`,
          articleId: sql`excluded.article_id`,
        },
      });

    written += chunk.length;
  }

  return written;
}

// ---------------------------------------------------------------------------
// Processore
// ---------------------------------------------------------------------------

export async function processGscSync(ctx: ProcessorContext): Promise<void> {
  const db = getWorkerDb();
  const { recorder, logger, job } = ctx;
  const productId = job.productId ?? job.targetId;

  if (!productId) {
    throw new Error('Job di sincronizzazione senza productId.');
  }

  const payload = (job.payload ?? {}) as GscSyncPayload;
  const isConnect = payload.mode === 'connect';

  // --- Modalità connessione -------------------------------------------------
  if (isConnect) {
    if (!payload.siteUrl || !payload.refreshToken) {
      throw new Error('Payload di connessione Search Console incompleto.');
    }

    /**
     * Verifica il refresh token PRIMA di scrivere la riga. Salvare una
     * connessione che non funziona produce l'esperienza peggiore possibile:
     * la UI mostra "collegata" e i dati non arrivano mai, senza che nulla
     * spieghi perché.
     */
    await recorder.step(
      'gsc.verify',
      'Verifica dell’accesso a Search Console',
      () =>
        refreshGscAccessToken({
          refreshToken: payload.refreshToken!,
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        }),
    );

    const cipher = createCipherFromEnv();
    const encrypted = cipher.encrypt({ refreshToken: payload.refreshToken });

    await db.insert(gscConnections).values({
      organizationId: job.organizationId,
      productId,
      siteUrl: payload.siteUrl,
      encryptedRefreshToken: encrypted.ciphertext,
      credentialsIv: encrypted.iv,
      credentialsKeyVersion: encrypted.keyVersion,
      connectedEmail: payload.connectedEmail ?? null,
      connectedBy: payload.connectedBy ?? null,
      isActive: true,
    });

    await recorder.event({
      step: 'gsc.connected',
      message: `Property ${payload.siteUrl} collegata: primo import in corso.`,
    });

    logger.info({ productId, siteUrl: payload.siteUrl }, 'connessione GSC creata');
  }

  // --- Caricamento della connessione ---------------------------------------
  const [connection] = await db
    .select({
      id: gscConnections.id,
      siteUrl: gscConnections.siteUrl,
      encryptedRefreshToken: gscConnections.encryptedRefreshToken,
      credentialsIv: gscConnections.credentialsIv,
      credentialsKeyVersion: gscConnections.credentialsKeyVersion,
      lastSyncedDate: gscConnections.lastSyncedDate,
    })
    .from(gscConnections)
    .where(
      and(eq(gscConnections.productId, productId), eq(gscConnections.isActive, true)),
    )
    .limit(1);

  if (!connection) {
    throw new Error(
      'Nessuna property Search Console collegata a questo prodotto.',
    );
  }

  try {
    const cipher = createCipherFromEnv();
    const { refreshToken } = cipher.decrypt<{ refreshToken: string }>({
      ciphertext: connection.encryptedRefreshToken,
      iv: connection.credentialsIv,
      keyVersion: connection.credentialsKeyVersion,
    });

    const { accessToken } = await refreshGscAccessToken({
      refreshToken,
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    });

    // --- Intervallo da importare -------------------------------------------
    const endDate = latestAvailableGscDate();
    const startDate = connection.lastSyncedDate
      ? shiftIsoDate(connection.lastSyncedDate, -REVISION_OVERLAP_DAYS)
      : shiftIsoDate(endDate, -INITIAL_HISTORY_DAYS);

    if (startDate > endDate) {
      await recorder.event({
        step: 'gsc.up_to_date',
        message: 'Nessun dato nuovo: Search Console non ha ancora pubblicato giorni successivi.',
      });
      return;
    }

    const maps = await buildArticleUrlMap(productId);
    let totalRows = 0;

    await recorder.step(
      'gsc.import',
      `Import delle metriche dal ${startDate} al ${endDate}`,
      async () => {
        await fetchGscMetrics({
          accessToken,
          siteUrl: connection.siteUrl,
          startDate,
          endDate,
          // Scrive pagina per pagina invece di accumulare tutto in memoria: un
          // sito grande su tre mesi supera facilmente le centinaia di migliaia
          // di righe, e il worker gira in un container con memoria limitata.
          onPage: async (rows) => {
            totalRows += await upsertMetrics(productId, rows, maps);
          },
        });
      },
    );

    await db
      .update(gscConnections)
      .set({
        lastSyncedAt: new Date(),
        lastSyncedDate: endDate,
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(gscConnections.id, connection.id));

    await recorder.event({
      step: 'gsc.done',
      message: `${totalRows.toLocaleString('it-IT')} righe importate fino al ${endDate}.`,
      details: { rows: totalRows, startDate, endDate },
    });

    logger.info({ productId, rows: totalRows, startDate, endDate }, 'sync GSC completato');

    /**
     * Dopo la PRIMA sincronizzazione il planner gira subito: aspettare il cron
     * settimanale significherebbe mostrare una pagina Analitiche senza nessuna
     * raccomandazione per giorni, proprio nel momento in cui l'utente ha appena
     * collegato la property e sta guardando il risultato.
     */
    if (isConnect && totalRows > 0) {
      await ctx.enqueue({
        type: 'planner_recalculate',
        organizationId: job.organizationId,
        productId,
        targetType: 'product',
        targetId: productId,
        payload: { mode: 'after-connect' },
        discriminator: `after-connect-${Date.now()}`,
        reserveCredit: false,
      });
    }
  } catch (error) {
    /**
     * L'errore viene registrato sulla connessione PRIMA di essere rilanciato:
     * la pagina Analitiche lo legge da lì e lo mostra. Senza, un sync che
     * fallisce di notte resta visibile solo nei log del server — cioè,
     * per l'utente, invisibile.
     */
    const message =
      error instanceof GscError
        ? error.userMessage
        : 'Sincronizzazione non riuscita. Riproveremo automaticamente.';

    await db
      .update(gscConnections)
      .set({ lastSyncError: message, updatedAt: new Date() })
      .where(eq(gscConnections.id, connection.id));

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

/**
 * Cron giornaliero: accoda una sincronizzazione per ogni property collegata.
 *
 * Non importa nulla direttamente. Un solo job che sincronizza tutti i prodotti
 * in sequenza fallirebbe per intero al primo cliente con il token revocato, e
 * gli altri resterebbero senza dati per una ragione che non li riguarda.
 */
export async function processGscSyncCron(ctx: ProcessorContext): Promise<void> {
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
        // I prodotti archiviati non producono più contenuti: importarne le
        // metriche consuma quota API per dati che nessuno guarderà.
        eq(products.status, 'active'),
      ),
    );

  let queued = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const connection of connections) {
    try {
      await ctx.enqueue({
        type: 'gsc_sync',
        organizationId: connection.organizationId,
        productId: connection.productId,
        targetType: 'product',
        targetId: connection.productId,
        payload: { mode: 'sync' },
        // Un solo sync automatico al giorno per prodotto, garantito
        // dall'idempotenza di `app_enqueue_job` sulla chiave.
        discriminator: `daily-${today}`,
        reserveCredit: false,
      });
      queued += 1;
    } catch (error) {
      // Un prodotto che non si accoda non deve fermare gli altri.
      logger.warn(
        {
          productId: connection.productId,
          err: error instanceof Error ? error.message : String(error),
        },
        'accodamento sync GSC fallito per un prodotto',
      );
    }
  }

  logger.info({ queued, total: connections.length }, 'cron gsc-sync completato');
}
