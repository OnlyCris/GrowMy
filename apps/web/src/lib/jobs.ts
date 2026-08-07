import 'server-only';

import { db } from '@growmy/db';
import { env } from '@growmy/env';
import { JOB_PRIORITY, pushJobToQueue } from '@growmy/jobs';
import { sql } from 'drizzle-orm';

import { ActionError } from '@/actions/_action-result';

/**
 * ACCODAMENTO CONDIVISO — unico varco di scrittura su `jobs`/`credit_ledger`.
 *
 * Estratto da `review.impl.ts` (dove viveva come funzione privata) perché
 * ogni azione che accoda lavoro per il worker ne ha bisogno identica — prima
 * solo la coda di revisione, ora anche keyword/articoli e connessione
 * integrazioni. Stesso corpo, stessa firma concettuale: generalizzata da
 * `articleId`/`'article'` fisso a `targetType`/`targetId`, così serve
 * qualunque entità (articolo, integrazione, ...) invece di una sola.
 *
 * `userId` è ricavato dal wrapper `safe-action` a partire da
 * `supabase.auth.getUser()` — una verifica di firma lato server — e mai
 * dall'input del client. `app_enqueue_job()` (`0003_enqueue_job.sql`) lo
 * riverifica comunque contro `organization_members`: un id arbitrario non
 * basta ad accodare lavoro.
 *
 * BUG CORRETTO IN QUESTA VERSIONE: `app_enqueue_job()` scrive SOLO la riga
 * Postgres — è una funzione SQL, non parla con Redis. Prima di
 * `pushJobToQueue`, questa funzione si fermava lì: il job restava
 * `status = 'pending'`/`attempts = 0` per sempre, perché il worker consuma da
 * Redis e non fa polling sulla tabella `jobs`. Nessun cron di recupero lo
 * intercettava: `stuck-job-recovery` riguarda solo i job rimasti `running`
 * troppo a lungo, un caso diverso da "mai partito". Scoperto in produzione
 * (tre keyword ferme in `processing` per due ore) dopo che questa era
 * l'unica funzione ad accodare lavoro dal lato web — `apps/worker/src/
 * index.ts` ha sempre avuto il proprio `enqueueJob` che fa ENTRAMBE le cose,
 * perché il worker ha accesso diretto al registro delle code.
 */

export interface EnqueueJobParams {
  userId: string;
  organizationId: string;
  productId: string;
  type:
    | 'keyword_research'
    | 'article_research'
    | 'article_generate'
    | 'article_publish'
    | 'integration_connect';
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  /** Discriminante della chiave di idempotenza: distingue i tentativi legittimi. */
  discriminator: string;
  reserveCredit: boolean;
  traceId: string;
}

export async function enqueueJob(params: EnqueueJobParams): Promise<string> {
  const idempotencyKey = `${params.type}:${params.targetId}:${params.discriminator}`;

  const result = await db.execute(sql`
    select app_enqueue_job(
      ${params.userId}::uuid,
      ${params.organizationId}::uuid,
      ${params.productId}::uuid,
      ${params.type}::job_type,
      ${params.targetType},
      ${params.targetId}::uuid,
      ${JSON.stringify(params.payload)}::jsonb,
      ${idempotencyKey},
      ${params.reserveCredit},
      ${params.traceId}
    ) as job_id
  `);

  const jobId = (result.rows[0] as { job_id: string } | undefined)?.job_id;
  if (!jobId) {
    throw new ActionError('INTERNAL_ERROR', 'Accodamento del lavoro non riuscito.');
  }

  /**
   * `jobId` è anche l'id del job BullMQ (`pushJobToQueue` lo passa come
   * `jobId` nelle opzioni di `Queue.add`): un retry dopo un fallimento qui
   * — rete Redis giù, deploy a metà — chiama di nuovo `enqueueJob` con la
   * stessa `idempotencyKey`, `app_enqueue_job` restituisce lo STESSO
   * `jobId` esistente, e BullMQ deduplica su quell'id invece di
   * duplicare il lavoro. Per questo l'errore qui sotto risale (niente
   * try/catch silenzioso): l'utente deve vedere che l'azione non è
   * riuscita, non un successo che in realtà è rimasto fermo in Postgres.
   */
  await pushJobToQueue({
    redisUrl: env.REDIS_URL,
    jobId,
    type: params.type,
    priority: JOB_PRIORITY.interactive,
  });

  return jobId;
}

/**
 * Traduce gli errori sollevati da `app_enqueue_job` in errori di dominio.
 * Postgres li restituisce come messaggi di eccezione; qui diventano codici
 * che la UI sa gestire.
 */
export function mapDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';

  if (message.includes('INSUFFICIENT_CREDITS')) {
    throw new ActionError(
      'INSUFFICIENT_CREDITS',
      'Crediti esauriti per questo ciclo. Aggiorna il piano per continuare a generare.',
    );
  }
  if (message.includes('FORBIDDEN') || message.includes('PRODUCT_ORG_MISMATCH')) {
    throw new ActionError('FORBIDDEN', 'Operazione non consentita.');
  }
  throw error;
}
