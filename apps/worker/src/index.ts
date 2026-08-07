import { createLlmRouterFromEnv } from '@growmy/ai';
import { closeDatabaseConnections, getWorkerDb, jobs } from '@growmy/db';
import { createLogger, withContext } from '@growmy/logger';
import { Worker, type Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';

import { markArticleFailed } from './lib/article-failure';
import { releaseReservation, reservationIdFromPayload } from './lib/credits';
import {
  isRetryableError,
  JobRecorder,
  loadJobRecord,
  toErrorCode,
  toUserMessage,
} from './lib/job-recorder';
import { processArticleGenerate } from './processors/article-generate.processor';
import { processArticlePublish } from './processors/article-publish.processor';
import { processArticleResearch } from './processors/article-research.processor';
import { processIntegrationConnect } from './processors/integration-connect.processor';
import { processIntegrationHealth } from './processors/integration-health.processor';
import { processKeywordResearch } from './processors/keyword-research.processor';
import {
  processApprovalTimeoutSweep,
  processDailyDispatch,
  processStuckJobRecovery,
} from './processors/maintenance.processor';
import type { EnqueueRequest, Processor, ProcessorContext } from './processors/types';
import {
  createQueueRegistry,
  JOB_PRIORITY,
  QUEUE_NAMES,
  queueForJobType,
  type QueueName,
} from './queues';
import { registerScheduledJobs } from './scheduler';
import { startHealthServer } from './health';

/**
 * WORKER GROWMY
 *
 * Consuma le code BullMQ ed esegue la pipeline editoriale.
 *
 * TRE PROPRIETÀ CHE DEFINISCONO IL COMPORTAMENTO:
 *
 *  1. Postgres è la fonte di verità, Redis è la coda. Ogni job ha una riga in
 *     `jobs`; se Redis viene perso, il lavoro si ricostruisce.
 *
 *  2. Il credito si rilascia SOLO in dead-letter. Un fallimento con retry
 *     ancora disponibili non restituisce nulla, altrimenti il tentativo
 *     successivo lavorerebbe senza copertura.
 *
 *  3. Spegnimento ordinato. Una generazione dura minuti: il processo attende
 *     che i job in corso finiscano invece di ucciderli a metà, che lascerebbe
 *     articoli monchi e crediti bloccati.
 */

const logger = createLogger({ service: 'growmy-worker' });

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  logger.fatal('REDIS_URL non configurata: il worker non può avviarsi.');
  process.exit(1);
}

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 3);

const registry = createQueueRegistry(REDIS_URL);
const llm = createLlmRouterFromEnv(logger);

logger.info(
  { providers: llm.availableProviders, concurrency: CONCURRENCY },
  'router LLM inizializzato',
);

/**
 * Accoda un job passando dalla funzione SECURITY DEFINER del database.
 *
 * Anche il worker ci passa: è l'unico varco di scrittura su `jobs` e
 * `credit_ledger`, e garantisce idempotenza e riserva atomica del credito.
 */
async function enqueueJob(request: EnqueueRequest): Promise<string> {
  const db = getWorkerDb();

  const idempotencyKey = `${request.type}:${request.targetId ?? 'none'}:${request.discriminator}`;

  /**
   * Il worker non ha un utente: usa l'owner dell'organizzazione come attore.
   * La funzione verifica comunque che quel ruolo sia autorizzato — non stiamo
   * aggirando il controllo, lo stiamo soddisfacendo con un'identità reale.
   */
  const result = await db.execute(sql`
    select app_enqueue_job(
      (select owner_id from organizations where id = ${request.organizationId}::uuid),
      ${request.organizationId}::uuid,
      ${request.productId}::uuid,
      ${request.type}::job_type,
      ${request.targetType ?? 'article'},
      ${request.targetId}::uuid,
      ${JSON.stringify(request.payload)}::jsonb,
      ${idempotencyKey},
      ${request.reserveCredit ?? false},
      ${null}
    ) as job_id
  `);

  const jobId = (result.rows[0] as { job_id: string } | undefined)?.job_id;
  if (!jobId) throw new Error('Accodamento non riuscito.');

  const queueName = queueForJobType(request.type);
  await registry.get(queueName).add(
    request.type,
    { jobId },
    {
      jobId,
      priority: request.priority ?? JOB_PRIORITY.scheduled,
      delay: request.delayMs,
    },
  );

  return jobId;
}

/** Processori indicizzati per tipo di job del database. */
const PROCESSORS: Record<string, Processor> = {
  keyword_research: processKeywordResearch,
  article_research: processArticleResearch,
  article_generate: processArticleGenerate,
  article_publish: processArticlePublish,
  integration_health_check: processIntegrationHealth,
  integration_connect: processIntegrationConnect,
};

/** Cron senza una riga in `jobs`: girano fuori dal ciclo di vita normale. */
const CRON_PROCESSORS: Record<string, Processor> = {
  'daily-content-dispatch': processDailyDispatch,
  'approval-timeout-sweep': processApprovalTimeoutSweep,
  'stuck-job-recovery': processStuckJobRecovery,
  'integration-health-check': processIntegrationHealth,
};

/**
 * Contesto sintetico per i cron, che non hanno un record in `jobs`.
 * Il recorder scrive su un id fittizio: gli eventi dei cron non interessano
 * all'utente finale, servono solo ai log.
 */
function createCronContext(name: string): ProcessorContext {
  const traceId = crypto.randomUUID();

  const noopRecorder = {
    trace: traceId,
    id: `cron:${name}`,
    async markRunning() {},
    async markSucceeded() {},
    async markFailed() {},
    async event(params: { step: string; message: string; level?: string }) {
      logger.debug({ cron: name, step: params.step }, params.message);
    },
    async step<T>(_step: string, message: string, fn: () => Promise<T>) {
      logger.debug({ cron: name }, message);
      return fn();
    },
  } as unknown as JobRecorder;

  return {
    job: {
      id: `cron:${name}`,
      organizationId: '',
      productId: null,
      type: name,
      targetId: null,
      payload: {},
      attempts: 0,
      maxAttempts: 1,
      traceId,
    },
    recorder: noopRecorder,
    llm,
    logger: withContext(logger, { traceId }),
    enqueue: enqueueJob,
  };
}

/** Elabora un job della coda. */
async function handleJob(bullJob: Job): Promise<void> {
  // --- Cron ----------------------------------------------------------------
  const cronProcessor = CRON_PROCESSORS[bullJob.name];
  if (cronProcessor && bullJob.data?.scheduled === true) {
    const ctx = createCronContext(bullJob.name);
    ctx.logger.info({ cron: bullJob.name }, 'cron avviato');
    await cronProcessor(ctx);
    return;
  }

  // --- Job applicativo -----------------------------------------------------
  const jobId = (bullJob.data?.jobId ?? bullJob.id) as string;
  const record = await loadJobRecord(jobId);

  if (!record) {
    // Il job è stato cancellato mentre era in coda: uscire pulito è corretto,
    // rilanciare produrrebbe retry inutili.
    logger.warn({ jobId }, 'record del job non trovato: ignorato');
    return;
  }

  const traceId = record.traceId ?? crypto.randomUUID();
  const jobLogger = withContext(logger, {
    traceId,
    jobId: record.id,
    organizationId: record.organizationId,
    productId: record.productId ?? undefined,
  });

  const recorder = new JobRecorder(record.id, traceId);
  const processor = PROCESSORS[record.type];

  if (!processor) {
    await recorder.markFailed({
      userMessage: `Tipo di lavoro non supportato: ${record.type}`,
      errorCode: 'UNKNOWN_JOB_TYPE',
      willRetry: false,
    });
    return;
  }

  await recorder.markRunning(bullJob.id);
  jobLogger.info({ type: record.type }, 'job avviato');

  const ctx: ProcessorContext = {
    job: record,
    recorder,
    llm,
    logger: jobLogger,
    enqueue: enqueueJob,
  };

  try {
    await processor(ctx);
    await recorder.markSucceeded();
    jobLogger.info({ type: record.type }, 'job completato');
  } catch (error) {
    const retryable = isRetryableError(error);
    const attemptsMade = (bullJob.attemptsMade ?? 0) + 1;
    const maxAttempts = bullJob.opts.attempts ?? 5;
    const willRetry = retryable && attemptsMade < maxAttempts;

    await recorder.markFailed({
      userMessage: toUserMessage(error),
      errorCode: toErrorCode(error),
      willRetry,
      nextRetryAt: willRetry
        ? new Date(Date.now() + Math.min(5_000 * 2 ** attemptsMade, 300_000))
        : null,
    });

    jobLogger.error(
      {
        type: record.type,
        attemptsMade,
        willRetry,
        err: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      },
      'job fallito',
    );

    /**
     * DEAD-LETTER: il credito torna indietro.
     *
     * Solo qui, e non a ogni tentativo fallito: se ci sono ancora retry, il
     * lavoro potrebbe riuscire e il credito deve restare impegnato.
     */
    if (!willRetry) {
      const reservationId = reservationIdFromPayload(record.payload);

      if (reservationId) {
        await releaseReservation({
          organizationId: record.organizationId,
          productId: record.productId,
          articleId: record.targetId,
          reservationId,
          reason: toUserMessage(error),
        });

        jobLogger.warn(
          { reservationId },
          'credito restituito dopo fallimento definitivo',
        );
      }

      // Vedi il commento in `lib/article-failure.ts`: senza questo,
      // l'articolo resta fermo nel suo stato precedente (es. "generating")
      // con nessuna causa visibile in UI.
      if (
        record.targetId &&
        (record.type === 'article_research' ||
          record.type === 'article_generate' ||
          record.type === 'article_publish')
      ) {
        await markArticleFailed(record.targetId, toUserMessage(error));
      }
    }

    // Rilancia: BullMQ decide retry o fallimento definitivo.
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Avvio dei worker
// ---------------------------------------------------------------------------

const workers: Worker[] = [];

/**
 * Concorrenza per coda, calibrata sul costo del lavoro.
 * La pubblicazione è I/O leggero e può correre; la generazione tiene memoria e
 * consuma quota LLM, quindi resta al valore configurato.
 */
const CONCURRENCY_BY_QUEUE: Partial<Record<QueueName, number>> = {
  [QUEUE_NAMES.articleGenerate]: CONCURRENCY,
  [QUEUE_NAMES.articleResearch]: CONCURRENCY,
  [QUEUE_NAMES.articlePublish]: Math.max(2, CONCURRENCY * 2),
  [QUEUE_NAMES.integrationHealth]: 2,
  [QUEUE_NAMES.maintenance]: 1,
};

for (const queueName of Object.values(QUEUE_NAMES)) {
  const worker = new Worker(queueName, handleJob, {
    connection: registry.connection,
    concurrency: CONCURRENCY_BY_QUEUE[queueName] ?? 2,
    // Un job di generazione può durare a lungo: lo stallo si dichiara solo
    // oltre i 10 minuti, altrimenti BullMQ lo riaccoderebbe mentre lavora.
    stalledInterval: 600_000,
    maxStalledCount: 2,
  });

  worker.on('failed', (job, error) => {
    logger.warn(
      { queue: queueName, jobId: job?.id, err: error.message },
      'job fallito nella coda',
    );
  });

  worker.on('error', (error) => {
    // Errore del worker stesso (connessione Redis, non un singolo job).
    logger.error({ queue: queueName, err: error.message }, 'errore del worker');
  });

  workers.push(worker);
}

logger.info(
  { queues: Object.values(QUEUE_NAMES).length, concurrency: CONCURRENCY },
  'worker in ascolto',
);

// ---------------------------------------------------------------------------
// Cron e health check
// ---------------------------------------------------------------------------

await registerScheduledJobs(registry, logger);
const healthServer = startHealthServer(logger);

// ---------------------------------------------------------------------------
// Spegnimento ordinato
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'spegnimento avviato: attendo i job in corso');

  // `close()` senza argomenti attende che i job attivi finiscano. Una
  // generazione a metà lascerebbe un articolo monco e un credito bloccato.
  const timeout = setTimeout(() => {
    logger.warn('timeout di spegnimento: uscita forzata');
    process.exit(1);
  }, 110_000); // sotto i 120s di stop_grace_period del compose

  try {
    await Promise.allSettled(workers.map((w) => w.close()));
    await registry.closeAll();
    await closeDatabaseConnections();
    healthServer.close();

    clearTimeout(timeout);
    logger.info('spegnimento completato');
    process.exit(0);
  } catch (error) {
    clearTimeout(timeout);
    logger.error({ err: String(error) }, 'errore durante lo spegnimento');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'promise rifiutata non gestita');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error.message, stack: error.stack }, 'eccezione non catturata');
  void shutdown('uncaughtException');
});

/** Marca i job già `running` all'avvio come pendenti: erano di un'istanza morta. */
async function recoverOnBoot(): Promise<void> {
  const db = getWorkerDb();

  const recovered = await db
    .update(jobs)
    .set({ status: 'pending', startedAt: null, updatedAt: new Date() })
    .where(eq(jobs.status, 'running'))
    .returning({ id: jobs.id });

  if (recovered.length > 0) {
    logger.warn(
      { count: recovered.length },
      'job in stato running all’avvio: rimessi in coda',
    );
  }
}

await recoverOnBoot();
