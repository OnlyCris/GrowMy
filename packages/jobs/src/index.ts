import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * CODE BULLMQ — definizioni condivise fra `web` e `worker`.
 *
 * Estratto da `apps/worker/src/queues.ts` (che prima le possedeva da solo)
 * dopo aver trovato un bug reale in produzione: le Server Action web
 * accodavano lavoro chiamando SOLO `app_enqueue_job()` (scrittura Postgres),
 * mai una `Queue.add()` — perché quel pezzo viveva solo lato worker. Il
 * worker non fa polling sulla tabella `jobs`, consuma da Redis: senza la
 * `Queue.add()`, un job restava per sempre `status = 'pending'` con
 * `attempts = 0`, invisibile a qualunque cron di recupero (che riguarda solo
 * i job rimasti `running` troppo a lungo — un caso diverso da "mai partito").
 *
 * Tenere `QUEUE_NAMES`/`queueForJobType` in un solo pacchetto condiviso,
 * invece che duplicati in due posti, è la parte che conta: un domani un nuovo
 * tipo di job aggiunto da un solo lato si romperebbe silenziosamente
 * nell'altro esattamente allo stesso modo.
 */

export const QUEUE_NAMES = {
  productOnboarding: 'product-onboarding',
  keywordResearch: 'keyword-research',
  articleResearch: 'article-research',
  articleGenerate: 'article-generate',
  articlePublish: 'article-publish',
  integrationHealth: 'integration-health',
  gscSync: 'gsc-sync',
  plannerRecalculate: 'planner-recalculate',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * `maxRetriesPerRequest: null` è OBBLIGATORIO per BullMQ: con un valore finito,
 * ioredis abbandona i comandi bloccanti (`BRPOPLPUSH`) che BullMQ usa per
 * attendere nuovi job, e il consumer smette silenziosamente di consumare.
 */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 5_000,
  },
  removeOnComplete: { age: 3_600, count: 500 },
  removeOnFail: { age: 604_800 },
};

/** Priorità: numero più basso = eseguito prima. */
export const JOB_PRIORITY = {
  /** Azione umana esplicita: l'utente sta aspettando davanti allo schermo. */
  interactive: 1,
  /** Pubblicazione: l'articolo è già approvato, va messo online. */
  publish: 10,
  /** Generazione schedulata dal cron giornaliero. */
  scheduled: 50,
  /** Manutenzione: health check, sync, planner. */
  background: 90,
} as const;

/** Mappa il tipo di job del database sulla coda che lo processa. */
export function queueForJobType(type: string): QueueName {
  switch (type) {
    case 'product_onboarding_analysis':
      return QUEUE_NAMES.productOnboarding;
    case 'keyword_research':
      return QUEUE_NAMES.keywordResearch;
    case 'article_research':
      return QUEUE_NAMES.articleResearch;
    case 'article_generate':
      return QUEUE_NAMES.articleGenerate;
    case 'article_publish':
      return QUEUE_NAMES.articlePublish;
    case 'integration_health_check':
    case 'integration_connect':
      return QUEUE_NAMES.integrationHealth;
    case 'gsc_sync':
      return QUEUE_NAMES.gscSync;
    case 'planner_recalculate':
      return QUEUE_NAMES.plannerRecalculate;
    default:
      return QUEUE_NAMES.maintenance;
  }
}

/**
 * Cache dei producer per riavvii a caldo in sviluppo (stesso pattern del pool
 * Postgres in `packages/db/src/client.ts`) e per non aprire una nuova
 * connessione Redis a ogni chiamata in produzione.
 */
const globalForJobs = globalThis as unknown as {
  __growmyJobQueues?: Map<QueueName, Queue>;
  __growmyJobConnection?: Redis;
};

function getProducerQueue(redisUrl: string, name: QueueName): Queue {
  globalForJobs.__growmyJobConnection ??= createRedisConnection(redisUrl);
  globalForJobs.__growmyJobQueues ??= new Map();

  let queue = globalForJobs.__growmyJobQueues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: globalForJobs.__growmyJobConnection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    globalForJobs.__growmyJobQueues.set(name, queue);
  }
  return queue;
}

/**
 * Spinge su BullMQ un job GIÀ scritto in Postgres da `app_enqueue_job()`.
 * `jobId` è lo stesso id della riga Postgres: `Queue.add` lo usa come id del
 * job BullMQ (`jobId` nelle opzioni), così i due restano la stessa entità
 * vista da due sistemi, non due id da tenere sincronizzati a mano.
 */
export async function pushJobToQueue(params: {
  redisUrl: string;
  jobId: string;
  type: string;
  priority?: number;
  delayMs?: number;
}): Promise<void> {
  const queueName = queueForJobType(params.type);
  const queue = getProducerQueue(params.redisUrl, queueName);

  await queue.add(
    params.type,
    { jobId: params.jobId },
    {
      jobId: params.jobId,
      priority: params.priority ?? JOB_PRIORITY.scheduled,
      delay: params.delayMs,
    },
  );
}
