import type { LlmRouter } from '@growmy/ai';
import type { Logger } from '@growmy/logger';

import type { JobRecorder } from '../lib/job-recorder';

/**
 * Contesto passato a ogni processore.
 *
 * Contiene tutto ciò che serve a fare il lavoro e a raccontarlo: il record del
 * job, il router LLM, il logger con contesto preapplicato, il recorder che
 * scrive la timeline visibile all'utente, e la funzione per accodare il passo
 * successivo della pipeline.
 *
 * Passare un contesto invece di importare singleton rende i processori
 * testabili: si costruisce un contesto finto e si verifica il comportamento
 * senza Redis né database.
 */

export interface JobRecord {
  id: string;
  organizationId: string;
  productId: string | null;
  type: string;
  targetId: string | null;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  traceId: string | null;
}

/** Richiesta di accodamento di un job successivo. */
export interface EnqueueRequest {
  type:
    | 'product_onboarding_analysis'
    | 'keyword_research'
    | 'article_research'
    | 'article_generate'
    | 'article_publish'
    | 'integration_health_check'
    | 'integration_connect'
    | 'gsc_sync'
    | 'planner_recalculate';
  organizationId: string;
  productId: string | null;
  targetId: string | null;
  /**
   * Tipo dell'entità puntata da `targetId` (`'article'`, `'integration'`, ...).
   * Opzionale con default `'article'`: tutti i call site esistenti puntano ad
   * articoli, solo `integration_connect`/`integration_health_check` puntano
   * altrove.
   */
  targetType?: string;
  payload: Record<string, unknown>;
  /** Discriminante della chiave di idempotenza. */
  discriminator: string;
  reserveCredit?: boolean;
  priority?: number;
  delayMs?: number;
}

export interface ProcessorContext {
  job: JobRecord;
  recorder: JobRecorder;
  llm: LlmRouter;
  logger: Logger;
  /** Accoda il passo successivo, rispettando idempotenza e riserve di credito. */
  enqueue(request: EnqueueRequest): Promise<string>;
}

export type Processor = (ctx: ProcessorContext) => Promise<void>;
