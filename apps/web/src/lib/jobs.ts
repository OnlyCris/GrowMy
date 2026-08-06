import 'server-only';

import { db } from '@growmy/db';
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
 */

export interface EnqueueJobParams {
  userId: string;
  organizationId: string;
  productId: string;
  type: 'article_research' | 'article_generate' | 'article_publish' | 'integration_connect';
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
