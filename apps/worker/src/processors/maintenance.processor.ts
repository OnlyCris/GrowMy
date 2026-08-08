import { articles, getWorkerDb, keywords, products } from '@growmy/db';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';

import type { ProcessorContext } from './types';

/**
 * JOB DI MANUTENZIONE
 *
 * Tre cron che tengono in piedi la pipeline senza intervento umano.
 */

/**
 * SWEEP DELLE APPROVAZIONI SCADUTE — la valvola di sicurezza dell'UPGRADE #1.
 *
 * Il controllo umano non deve diventare un blocco: se nessuno revisiona entro
 * `approvalTimeoutHours`, l'articolo prosegue da solo. È ciò che rende la
 * revisione un'opzione e non un obbligo — vai in ferie e l'autopilota continua.
 *
 * L'articolo viene marcato `approvedByTimeout = true`, così l'interfaccia può
 * distinguere una decisione umana da una scadenza.
 */
export async function processApprovalTimeoutSweep(
  ctx: ProcessorContext,
): Promise<void> {
  const db = getWorkerDb();
  const { recorder, logger } = ctx;

  /**
   * Il confronto avviene interamente in SQL: `updated_at + timeout ore < now()`.
   * Farlo in JavaScript richiederebbe di caricare tutti gli articoli in attesa
   * e filtrarli in memoria — inutilmente costoso e soggetto a derive di fuso.
   */
  const expired = await db
    .select({
      id: articles.id,
      organizationId: articles.organizationId,
      productId: articles.productId,
      status: articles.status,
      currentVersionId: articles.currentVersionId,
      timeoutHours: products.approvalTimeoutHours,
    })
    .from(articles)
    .innerJoin(products, eq(products.id, articles.productId))
    .where(
      and(
        sql`${articles.status} in ('brief_ready','draft_ready')`,
        isNull(articles.deletedAt),
        // NULL = attesa indefinita: quei prodotti non scadono mai.
        sql`${products.approvalTimeoutHours} is not null`,
        sql`${articles.updatedAt} + (${products.approvalTimeoutHours} * interval '1 hour') < now()`,
      ),
    )
    .limit(100);

  if (expired.length === 0) {
    await recorder.event({
      step: 'sweep.none',
      message: 'Nessuna approvazione scaduta.',
    });
    return;
  }

  let advanced = 0;

  for (const article of expired) {
    const isBrief = article.status === 'brief_ready';
    const nextStatus = isBrief ? 'generating' : 'approved';

    // Compare-and-swap: se un umano approva nello stesso istante, il suo
    // aggiornamento vince e questo non tocca nulla.
    const updated = await db
      .update(articles)
      .set({
        status: nextStatus,
        approvedByTimeout: true,
        ...(isBrief
          ? { briefApprovedAt: new Date() }
          : { draftApprovedAt: new Date() }),
        updatedAt: new Date(),
      })
      .where(
        and(eq(articles.id, article.id), eq(articles.status, article.status)),
      )
      .returning({ id: articles.id });

    if (updated.length === 0) continue;

    advanced++;

    await ctx.enqueue({
      type: isBrief ? 'article_generate' : 'article_publish',
      organizationId: article.organizationId,
      productId: article.productId,
      targetId: article.id,
      payload: {
        approvedByTimeout: true,
        ...(isBrief ? {} : { versionId: article.currentVersionId }),
      },
      discriminator: `timeout-${article.currentVersionId ?? Date.now()}`,
    });
  }

  await recorder.event({
    step: 'sweep.done',
    message: `${advanced} articoli proseguiti automaticamente per scadenza della finestra di revisione.`,
    details: { candidates: expired.length, advanced },
  });

  logger.info({ advanced }, 'sweep approvazioni completato');
}

/**
 * DISPATCH GIORNALIERO
 *
 * Gira ogni ora e accoda le generazioni la cui ora locale è arrivata. Ogni
 * prodotto ha il proprio fuso e la propria ora di pubblicazione: un cliente a
 * Roma e uno a New York non devono pubblicare nello stesso momento.
 */
export async function processDailyDispatch(
  ctx: ProcessorContext,
): Promise<void> {
  const db = getWorkerDb();
  const { recorder, logger } = ctx;

  /**
   * `extract(hour from now() at time zone products.timezone)` fa fare a
   * Postgres la conversione di fuso, che conosce le regole dell'ora legale
   * meglio di qualunque calcolo manuale.
   */
  const due = await db
    .select({
      keywordId: keywords.id,
      organizationId: keywords.organizationId,
      productId: keywords.productId,
      term: keywords.term,
    })
    .from(keywords)
    .innerJoin(products, eq(products.id, keywords.productId))
    .where(
      and(
        eq(keywords.status, 'scheduled'),
        lte(keywords.scheduledFor, new Date()),
        eq(products.status, 'active'),
        isNull(products.deletedAt),
        isNull(keywords.deletedAt),
        sql`extract(hour from now() at time zone ${products.timezone}) = ${products.publishHour}`,
        // Il giorno della settimana deve essere fra quelli attivi.
        sql`${products.activeWeekdays}::jsonb @> to_jsonb(extract(dow from now() at time zone ${products.timezone})::int)`,
      ),
    )
    .limit(50);

  if (due.length === 0) {
    await recorder.event({
      step: 'dispatch.none',
      message: 'Nessuna keyword da processare in questa fascia oraria.',
    });
    return;
  }

  let enqueued = 0;

  for (const keyword of due) {
    // Marca la keyword come in lavorazione prima di accodare: se il cron
    // scattasse due volte, la seconda non troverebbe più `scheduled`.
    const claimed = await db
      .update(keywords)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(and(eq(keywords.id, keyword.keywordId), eq(keywords.status, 'scheduled')))
      .returning({ id: keywords.id });

    if (claimed.length === 0) continue;

    const [article] = await db
      .insert(articles)
      .values({
        organizationId: keyword.organizationId,
        productId: keyword.productId,
        keywordId: keyword.keywordId,
        status: 'researching',
      })
      .returning({ id: articles.id });

    await ctx.enqueue({
      type: 'article_research',
      organizationId: keyword.organizationId,
      productId: keyword.productId,
      targetId: article.id,
      payload: { scheduled: true },
      discriminator: `daily-${new Date().toISOString().slice(0, 10)}`,
      // La riserva avviene qui: è il punto in cui il lavoro diventa impegnativo.
      reserveCredit: true,
    });

    enqueued++;
  }

  await recorder.event({
    step: 'dispatch.done',
    message: `${enqueued} articoli accodati per la generazione.`,
    details: { due: due.length, enqueued },
  });

  logger.info({ enqueued }, 'dispatch giornaliero completato');
}

/**
 * RECUPERO DEI JOB APPESI
 *
 * Un worker ucciso a metà lavoro lascia il job in `running` per sempre.
 * Questo cron li rimette in coda: è ciò che rende la pipeline resistente ai
 * riavvii e ai deploy.
 */
export async function processStuckJobRecovery(
  ctx: ProcessorContext,
): Promise<void> {
  const { recorder, logger } = ctx;
  const db = getWorkerDb();

  // 30 minuti: più lungo della generazione più lenta (~8 min) con margine
  // abbondante, così non riaccodiamo lavoro ancora in corso.
  const threshold = new Date(Date.now() - 30 * 60_000);

  const stale = await db.execute(sql`
    update jobs
    set status = 'pending', started_at = null, updated_at = now()
    where status = 'running' and started_at < ${threshold}
    returning id, type, organization_id, product_id, target_id, payload
  `);

  const rows = stale.rows as Array<{
    id: string;
    type: string;
    organization_id: string;
    product_id: string | null;
    target_id: string | null;
  }>;

  if (rows.length === 0) {
    await recorder.event({
      step: 'recovery.none',
      message: 'Nessun job appeso.',
    });
    return;
  }

  await recorder.event({
    step: 'recovery.done',
    level: 'warn',
    message: `${rows.length} job rimasti appesi sono stati rimessi in coda.`,
    details: { jobIds: rows.map((r) => r.id).slice(0, 20) },
  });

  logger.warn({ count: rows.length }, 'job appesi recuperati');
}

/**
 * RICARICA DELLE KEYWORD
 *
 * Rifornisce la scorta di keyword lavorabili di ogni prodotto attivo, così la
 * pipeline editoriale non si ferma perché nessuno si è ricordato di premere
 * "Genera keyword".
 *
 * NON GENERA A CADENZA FISSA, E LA DIFFERENZA È IL PUNTO DI TUTTO IL JOB.
 * Un cron che produce otto proposte a settimana comunque vada, dopo due mesi
 * lascia settanta keyword non revisionate in coda: la revisione umana diventa
 * un muro, l'utente smette di guardarla, e il cancello di qualità che
 * giustifica l'intera architettura si trasforma in una casella di posta
 * ignorata. Qui il tempo è solo l'intervallo di CONTROLLO; la condizione è il
 * livello della scorta.
 *
 * La scorta conta anche le keyword `suggested`, cioè quelle ancora da
 * approvare. È deliberato: se ce ne sono già dieci in attesa di un umano, il
 * problema non è la mancanza di proposte e generarne altre lo peggiora.
 */

/** Sotto questa soglia di keyword lavorabili il prodotto viene rifornito. */
const KEYWORD_POOL_THRESHOLD = 8;

/** Quante proporne per volta. Un lotto piccolo si revisiona in una seduta. */
const REPLENISH_BATCH = 6;

export async function processKeywordReplenish(
  ctx: ProcessorContext,
): Promise<void> {
  const db = getWorkerDb();
  const { recorder, logger } = ctx;

  /**
   * Un solo giro in SQL invece di una query per prodotto: il conteggio della
   * scorta è una sottoquery correlata, e `having`/`where` filtrano i prodotti
   * già riforniti prima che tocchino la rete.
   */
  const lowStock = await db
    .select({
      productId: products.id,
      organizationId: products.organizationId,
      pool: sql<number>`(
        select count(*)::int from ${keywords}
        where ${keywords.productId} = ${sql.raw('"products"."id"')}
          and ${keywords.status} in ('suggested','approved','scheduled')
          and ${keywords.deletedAt} is null
      )`,
    })
    .from(products)
    .where(and(eq(products.status, 'active'), isNull(products.deletedAt)))
    .limit(200);

  const needing = lowStock.filter((row) => row.pool < KEYWORD_POOL_THRESHOLD);

  if (needing.length === 0) {
    await recorder.event({
      step: 'replenish.none',
      message: 'Tutti i prodotti attivi hanno keyword a sufficienza.',
    });
    return;
  }

  let enqueued = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const row of needing) {
    try {
      await ctx.enqueue({
        type: 'keyword_research',
        organizationId: row.organizationId,
        productId: row.productId,
        targetType: 'product',
        targetId: row.productId,
        payload: { count: REPLENISH_BATCH, source: 'replenish' },
        // Una sola ricarica automatica al giorno per prodotto, garantita
        // dall'idempotenza di `app_enqueue_job` sulla chiave.
        discriminator: `replenish-${today}`,
        reserveCredit: false,
      });
      enqueued += 1;
    } catch (error) {
      // Un prodotto che non si accoda non deve fermare gli altri.
      logger.warn(
        {
          productId: row.productId,
          err: error instanceof Error ? error.message : String(error),
        },
        'ricarica keyword non accodata per un prodotto',
      );
    }
  }

  await recorder.event({
    step: 'replenish.done',
    message: `${enqueued} prodotti sotto scorta: nuove keyword in arrivo, da revisionare.`,
    details: { candidates: needing.length, enqueued, threshold: KEYWORD_POOL_THRESHOLD },
  });

  logger.info(
    { enqueued, candidates: needing.length },
    'ricarica keyword completata',
  );
}
