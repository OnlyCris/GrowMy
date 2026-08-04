import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * CODE BULLMQ
 *
 * Una coda per tipo di lavoro invece di una sola coda condivisa. Il motivo è
 * l'isolamento: una raffica di pubblicazioni non deve ritardare la generazione,
 * e un health check che si blocca non deve occupare uno slot destinato agli
 * articoli.
 *
 * Redis è la coda; Postgres (`jobs`, `job_events`) è la fonte di verità. Se
 * Redis viene perso, i job si ricostruiscono dalle righe pendenti.
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
 * Connessione Redis condivisa.
 *
 * `maxRetriesPerRequest: null` è OBBLIGATORIO per BullMQ: con un valore finito,
 * ioredis abbandona i comandi bloccanti (`BRPOPLPUSH`) che BullMQ usa per
 * attendere nuovi job, e il worker smette silenziosamente di consumare la coda.
 */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Il worker deve sopravvivere a un riavvio di Redis senza morire.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

/** Opzioni di default per ogni job accodato. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: {
    // Esponenziale con base 5s: 5s, 10s, 20s, 40s, 80s. Copre le indisponibilità
    // brevi dei provider LLM e dei CMS senza tenere il job in coda per ore.
    type: 'exponential',
    delay: 5_000,
  },
  /**
   * I job riusciti si rimuovono da Redis dopo un'ora: lo storico permanente sta
   * in Postgres, tenere tutto in memoria fa solo crescere il consumo.
   */
  removeOnComplete: { age: 3_600, count: 500 },
  /**
   * I falliti restano una settimana: servono a ispezionare la dead-letter queue
   * dall'interfaccia prima che scadano.
   */
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

export interface QueueRegistry {
  queues: Map<QueueName, Queue>;
  events: Map<QueueName, QueueEvents>;
  connection: Redis;
  get(name: QueueName): Queue;
  closeAll(): Promise<void>;
}

export function createQueueRegistry(redisUrl: string): QueueRegistry {
  const connection = createRedisConnection(redisUrl);
  const queues = new Map<QueueName, Queue>();
  const events = new Map<QueueName, QueueEvents>();

  for (const name of Object.values(QUEUE_NAMES)) {
    queues.set(
      name,
      new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    );
  }

  return {
    queues,
    events,
    connection,

    get(name: QueueName): Queue {
      const queue = queues.get(name);
      if (!queue) throw new Error(`Coda non registrata: ${name}`);
      return queue;
    },

    async closeAll(): Promise<void> {
      await Promise.allSettled([
        ...[...queues.values()].map((q) => q.close()),
        ...[...events.values()].map((e) => e.close()),
      ]);
      await connection.quit();
    },
  };
}

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
      return QUEUE_NAMES.integrationHealth;
    case 'gsc_sync':
      return QUEUE_NAMES.gscSync;
    case 'planner_recalculate':
      return QUEUE_NAMES.plannerRecalculate;
    default:
      return QUEUE_NAMES.maintenance;
  }
}
