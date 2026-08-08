import { env } from '@growmy/env';
import { Redis } from 'ioredis';

/**
 * CONNESSIONE REDIS CONDIVISA DEL PROCESSO WEB.
 *
 * Estratta da `rate-limit.ts`, che la possedeva da sola, quando il flusso OAuth
 * di Search Console ha avuto bisogno dello stesso client. Il global cache non è
 * un vezzo: in sviluppo Next.js ricarica i moduli a ogni salvataggio e, senza,
 * ogni ricompilazione lascerebbe dietro una connessione TCP aperta finché il
 * server non esaurisce i descrittori — lo stesso motivo per cui il pool
 * Postgres in `packages/db/src/client.ts` fa la stessa cosa.
 *
 * `enableOfflineQueue: false` è deliberato: se Redis è giù vogliamo un errore
 * immediato, non comandi che si accumulano in memoria e vengono eseguiti tutti
 * insieme al ripristino. Chi chiama decide come degradare — il rate limiter
 * fail-open, il flusso OAuth fallisce e lo dice.
 */

const globalForRedis = globalThis as unknown as { __growmyRedis?: Redis };

export function getRedis(): Redis {
  globalForRedis.__growmyRedis ??= new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  return globalForRedis.__growmyRedis;
}
