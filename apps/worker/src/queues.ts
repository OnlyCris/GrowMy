import { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';

import {
  createRedisConnection,
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  type QueueName,
} from '@growmy/jobs';

/**
 * `QUEUE_NAMES`/`createRedisConnection`/`DEFAULT_JOB_OPTIONS`/`JOB_PRIORITY`/
 * `queueForJobType` sono definiti in `@growmy/jobs` (condiviso con `web`,
 * che deve poter spingere un job sulla coda giusta senza duplicare questa
 * mappatura — vedi il commento in quel pacchetto). Riesportati qui perché
 * `index.ts`/`scheduler.ts` li importano da `./queues`: cambiare quei
 * percorsi non era necessario per questo fix.
 *
 * `createQueueRegistry` resta qui: è l'unico pezzo davvero specifico del
 * worker, che mantiene un pool di `Queue` per TUTTE le code (il worker deve
 * poter accodare un passo successivo su qualunque coda), mentre `web` accoda
 * al più una coda alla volta tramite `pushJobToQueue` di `@growmy/jobs`.
 */
export { QUEUE_NAMES, createRedisConnection, DEFAULT_JOB_OPTIONS };
export { JOB_PRIORITY, queueForJobType } from '@growmy/jobs';
export type { QueueName };

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
