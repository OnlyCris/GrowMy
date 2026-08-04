import { env, isProduction } from '@growmy/env';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

/**
 * CLIENT DATABASE
 *
 * Due pool distinti, deliberatamente non intercambiabili:
 *
 *   `db`       -> ruolo `app_user`.   RLS ATTIVO E FORZATO.
 *                 È il client che usa tutto il codice che risponde a una
 *                 richiesta HTTP. Anche se una query dimentica il filtro su
 *                 organization_id, il database restituisce zero righe.
 *
 *   `workerDb` -> ruolo `app_worker`. BYPASSRLS.
 *                 Disponibile SOLO nel processo worker. Se qualcuno prova a
 *                 importarlo dall'app web senza la variabile d'ambiente
 *                 corrispondente, l'accesso lancia immediatamente.
 *
 * La separazione è a livello di credenziali di connessione, non di convenzione:
 * non è aggirabile per distrazione.
 */

/** In sviluppo Next.js ricarica i moduli a ogni salvataggio: senza cache
 *  globale si esaurirebbero le connessione di Postgres in pochi minuti. */
const globalForDb = globalThis as unknown as {
  __growmyPool?: Pool;
  __growmyWorkerPool?: Pool;
};

function createPool(connectionString: string, max: number): Pool {
  const pool = new Pool({
    connectionString,
    max,
    // Chiude le connessioni inattive: evita di tenere occupati slot del server.
    idleTimeoutMillis: 30_000,
    // Fallisce in fretta se il database non risponde, invece di accumulare
    // richieste in attesa fino al timeout del load balancer.
    connectionTimeoutMillis: 5_000,
    // In produzione la connessione è cifrata. `rejectUnauthorized: false` è
    // necessario con i certificati auto-firmati dei provider gestiti.
    ssl: isProduction ? { rejectUnauthorized: false } : undefined,
  });

  /**
   * Un errore su una connessione inattiva del pool non deve terminare il
   * processo. Lo logghiamo e lasciamo che il pool sostituisca la connessione.
   */
  pool.on('error', (error) => {
    // eslint-disable-next-line no-console -- il logger strutturato dipende da questo modulo.
    console.error('[db] errore su connessione inattiva del pool', {
      message: error.message,
    });
  });

  return pool;
}

const pool =
  globalForDb.__growmyPool ??
  createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);

if (!isProduction) globalForDb.__growmyPool = pool;

/**
 * Client applicativo. Passare `schema` è ciò che abilita l'inferenza dei tipi
 * su ogni query e la Relational Query API (`db.query.articles.findMany`).
 */
export const db = drizzle(pool, {
  schema,
  // In sviluppo logga l'SQL generato: rende immediato accorgersi di un N+1.
  logger: !isProduction,
});

export type Database = typeof db;

/**
 * Client del worker. Accessibile solo se `DATABASE_WORKER_URL` è configurata,
 * cosa che nell'ambiente dell'app web non accade.
 */
let workerPool: Pool | null = null;

export function getWorkerDb() {
  if (!env.DATABASE_WORKER_URL) {
    throw new Error(
      'workerDb non è disponibile in questo processo: DATABASE_WORKER_URL non è configurata. ' +
        'Se stai chiamando questo client dall’app web, è un errore: usa `db`, che rispetta RLS.',
    );
  }

  workerPool ??=
    globalForDb.__growmyWorkerPool ??
    createPool(env.DATABASE_WORKER_URL, env.DATABASE_POOL_MAX);

  if (!isProduction) globalForDb.__growmyWorkerPool = workerPool;

  return drizzle(workerPool, { schema, logger: false });
}

/**
 * Chiusura ordinata. Chiamata dagli handler di SIGTERM/SIGINT del worker: senza
 * questa, un deploy interromperebbe le transazioni a metà invece di lasciarle
 * completare.
 */
export async function closeDatabaseConnections(): Promise<void> {
  await Promise.allSettled([pool.end(), workerPool?.end()]);
}

/**
 * Health check usato da `/api/ready`. Deliberatamente banale: verifica che una
 * connessione sia ottenibile e che il server risponda, niente di più.
 * Un check pesante qui renderebbe il readiness probe una fonte di carico.
 */
export async function checkDatabaseHealth(): Promise<{
  healthy: boolean;
  latencyMs: number;
}> {
  const startedAt = performance.now();
  try {
    await pool.query('select 1');
    return { healthy: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { healthy: false, latencyMs: Math.round(performance.now() - startedAt) };
  }
}

export * from './schema';
export { schema };
