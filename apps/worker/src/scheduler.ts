import type { Logger } from '@growmy/logger';

import { JOB_PRIORITY, QUEUE_NAMES, type QueueRegistry } from './queues';

/**
 * JOB RICORRENTI
 *
 * BullMQ gestisce i cron con i "repeatable job": li registra in Redis e li
 * accoda da solo. Vantaggio rispetto a un cron di sistema: sopravvivono ai
 * riavvii, non richiedono crontab e sono visibili dalla stessa dashboard degli
 * altri job.
 *
 * IDEMPOTENZA DELLA REGISTRAZIONE: `jobId` fisso su ogni scheduler. BullMQ
 * sostituisce la definizione invece di aggiungerne una seconda, quindi
 * riavviare il worker dieci volte non produce dieci cron paralleli — che è
 * esattamente il bug che si scopre in produzione quando gli articoli iniziano
 * a uscire in decuplo.
 */

export interface ScheduledJobDefinition {
  name: string;
  queue: string;
  cron: string;
  description: string;
  priority: number;
}

export const SCHEDULED_JOBS: ScheduledJobDefinition[] = [
  {
    name: 'daily-content-dispatch',
    queue: QUEUE_NAMES.maintenance,
    // Ogni ora al minuto 5: ogni prodotto pubblica nella propria ora locale,
    // quindi dobbiamo controllare tutte le fasce orarie.
    cron: '5 * * * *',
    description: 'Accoda le generazioni la cui ora locale è arrivata',
    priority: JOB_PRIORITY.scheduled,
  },
  {
    name: 'approval-timeout-sweep',
    queue: QUEUE_NAMES.maintenance,
    // Ogni 15 minuti: la finestra di revisione è in ore, un controllo più
    // frequente non aggiunge precisione utile.
    cron: '*/15 * * * *',
    description: 'Fa proseguire gli articoli non revisionati entro la finestra',
    priority: JOB_PRIORITY.background,
  },
  {
    name: 'stuck-job-recovery',
    queue: QUEUE_NAMES.maintenance,
    cron: '*/10 * * * *',
    description: 'Rimette in coda i job lasciati appesi da un riavvio',
    priority: JOB_PRIORITY.background,
  },
  {
    name: 'integration-health-check',
    queue: QUEUE_NAMES.integrationHealth,
    // Ogni giorno alle 4:20 UTC: fascia di traffico minimo, e il risultato è
    // pronto prima che inizino le pubblicazioni della mattina europea.
    cron: '20 4 * * *',
    description: 'Verifica le integrazioni prima che una pubblicazione fallisca',
    priority: JOB_PRIORITY.background,
  },
  {
    name: 'gsc-sync',
    queue: QUEUE_NAMES.gscSync,
    // GSC pubblica i dati con 2-3 giorni di ritardo: sincronizzare più spesso
    // di una volta al giorno non porta dati nuovi.
    cron: '40 5 * * *',
    description: 'Importa le metriche di Search Console',
    priority: JOB_PRIORITY.background,
  },
  {
    name: 'planner-recalculate',
    queue: QUEUE_NAMES.plannerRecalculate,
    // Lunedì alle 6:00 UTC: il planner ricalcola le priorità sui dati della
    // settimana appena chiusa.
    cron: '0 6 * * 1',
    description: 'Ricalcola le priorità editoriali sui dati reali',
    priority: JOB_PRIORITY.background,
  },
];

/**
 * Registra tutti i cron. Va chiamato a ogni avvio: le definizioni vengono
 * sostituite, non duplicate.
 */
export async function registerScheduledJobs(
  registry: QueueRegistry,
  logger: Logger,
): Promise<void> {
  for (const definition of SCHEDULED_JOBS) {
    const queue = registry.get(definition.queue as never);

    /**
     * Rimuove eventuali definizioni precedenti con lo stesso nome ma cron
     * diverso. Senza questo, cambiare l'orario di un cron lascerebbe attiva
     * anche la vecchia pianificazione.
     */
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      if (job.name === definition.name && job.pattern !== definition.cron) {
        await queue.removeRepeatableByKey(job.key);
        logger.info(
          { job: definition.name, oldCron: job.pattern, newCron: definition.cron },
          'pianificazione aggiornata',
        );
      }
    }

    await queue.add(
      definition.name,
      { scheduled: true },
      {
        repeat: { pattern: definition.cron, tz: 'UTC' },
        // `jobId` fisso: è la chiave dell'idempotenza.
        jobId: `cron:${definition.name}`,
        priority: definition.priority,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
      },
    );

    logger.debug(
      { job: definition.name, cron: definition.cron },
      'cron registrato',
    );
  }

  logger.info(
    { count: SCHEDULED_JOBS.length },
    'job ricorrenti registrati',
  );
}

/**
 * Rimuove tutti i cron. Usato allo spegnimento controllato in ambienti di
 * sviluppo, dove più istanze potrebbero registrare gli stessi job.
 */
export async function unregisterScheduledJobs(
  registry: QueueRegistry,
): Promise<void> {
  for (const definition of SCHEDULED_JOBS) {
    const queue = registry.get(definition.queue as never);
    const jobs = await queue.getRepeatableJobs();

    for (const job of jobs) {
      if (job.name === definition.name) {
        await queue.removeRepeatableByKey(job.key);
      }
    }
  }
}
