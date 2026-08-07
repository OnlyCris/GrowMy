import { getWorkerDb, jobEvents, jobs } from '@growmy/db';
import { and, eq, sql } from 'drizzle-orm';

/**
 * MIRROR PERSISTENTE DEI JOB — UPGRADE #3
 *
 * BullMQ vive in Redis: volatile e non interrogabile in modo relazionale.
 * Questa classe rispecchia ogni transizione su Postgres, che serve a tre cose:
 *
 *  1. Mostrare all'utente cosa sta succedendo e PERCHÉ è fallito. Nell'originale
 *     l'utente vede "pubblicazione fallita" e basta; qui vede la timeline dei
 *     tentativi con causa leggibile.
 *  2. Ricostruire la coda se Redis viene perso. Redis è cache, Postgres verità.
 *  3. Garantire l'idempotenza tramite `idempotencyKey`.
 *
 * REGOLA: in `job_events.message` va SOLO testo destinato all'utente finale.
 * Gli stack trace vanno al logger, mai nel database — è la regola di progetto
 * sulla gestione degli errori.
 */

export type JobEventLevel = 'debug' | 'info' | 'warn' | 'error';

export class JobRecorder {
  private readonly db = getWorkerDb();

  constructor(
    private readonly jobId: string,
    private readonly traceId: string,
  ) {}

  /** Marca il job come avviato e azzera l'eventuale errore precedente. */
  async markRunning(queueJobId?: string): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: 'running',
        startedAt: new Date(),
        queueJobId: queueJobId ?? null,
        // Incrementa il contatore lato database: sotto retry concorrenti un
        // incremento letto-e-riscritto in JavaScript perderebbe conteggi.
        attempts: sql`${jobs.attempts} + 1`,
        lastError: null,
        lastErrorCode: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, this.jobId));
  }

  async markSucceeded(): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: 'succeeded',
        finishedAt: new Date(),
        nextRetryAt: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, this.jobId));
  }

  /**
   * Marca il fallimento.
   *
   * `willRetry` distingue un tentativo fallito da una resa definitiva: nel
   * secondo caso lo stato diventa `dead_lettered`, che è ciò che la UI mostra
   * come "richiede attenzione" e che il cron di alert notifica agli admin.
   */
  async markFailed(params: {
    userMessage: string;
    errorCode?: string;
    willRetry: boolean;
    nextRetryAt?: Date | null;
  }): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: params.willRetry ? 'pending' : 'dead_lettered',
        finishedAt: params.willRetry ? null : new Date(),
        nextRetryAt: params.nextRetryAt ?? null,
        lastError: params.userMessage,
        lastErrorCode: params.errorCode ?? null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, this.jobId));
  }

  /**
   * Registra un passo della pipeline.
   * È ciò che l'utente vede espandendo un articolo: una timeline leggibile,
   * non uno stack trace.
   */
  async event(params: {
    step: string;
    message: string;
    level?: JobEventLevel;
    details?: Record<string, unknown>;
    durationMs?: number;
  }): Promise<void> {
    await this.db.insert(jobEvents).values({
      jobId: this.jobId,
      level: params.level ?? 'info',
      step: params.step,
      message: params.message,
      details: params.details ?? null,
      durationMs: params.durationMs ?? null,
    });
  }

  /**
   * Esegue uno step misurandone la durata e registrandone l'esito.
   * Incapsulare il pattern qui evita che ogni processor ripeta try/catch e
   * cronometro, e garantisce che nessuno step resti senza traccia.
   */
  async step<T>(
    stepName: string,
    startMessage: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    await this.event({ step: stepName, message: startMessage });

    try {
      const result = await fn();
      await this.event({
        step: stepName,
        message: `${startMessage} — completato`,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      await this.event({
        step: stepName,
        level: 'error',
        message: toUserMessage(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  get trace(): string {
    return this.traceId;
  }

  get id(): string {
    return this.jobId;
  }
}

/**
 * Traduce un'eccezione in un messaggio per l'utente.
 *
 * Gli errori tipizzati (`PublishError`, `ProviderError`) portano già un
 * messaggio scritto per un umano. Tutto il resto diventa un messaggio generico:
 * esporre `error.message` grezzo può rivelare nomi di tabelle, percorsi e
 * struttura interna.
 */
export function toUserMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { userMessage?: unknown; name?: unknown };
    if (typeof candidate.userMessage === 'string') return candidate.userMessage;

    // Gli errori dei provider LLM hanno messaggi già sicuri e utili.
    if (candidate.name === 'ProviderError' && error instanceof Error) {
      return `Il modello non ha risposto correttamente: ${error.message}`;
    }
    if (candidate.name === 'SsrfBlockedError') {
      return 'L’indirizzo di destinazione non è consentito o punta a una rete privata.';
    }
    if (candidate.name === 'CryptoError') {
      return 'Impossibile decifrare le credenziali dell’integrazione. Riconnettila dalle impostazioni.';
    }
    // Ogni provider LLM configurato ha rifiutato la richiesta. Distinto dal
    // caso generico perché è l'unico per cui ha senso mostrare un'attesa
    // concreta invece di un errore muto — vedi `nextRetryAt` in `markFailed`.
    if (candidate.name === 'AllProvidersFailedError') {
      const c = candidate as { rateLimited?: unknown; failures?: unknown };
      if (c.rateLimited) {
        return 'Limite di richieste raggiunto su tutti i provider AI configurati. Nuovo tentativo automatico appena la quota si libera.';
      }
      const failures = Array.isArray(c.failures)
        ? (c.failures as Array<{ provider?: unknown; message?: unknown }>)
        : [];
      const summary = failures
        .map((f) => (typeof f.provider === 'string' ? f.provider : '?'))
        .join(', ');
      return `Nessun provider AI ha risposto correttamente (${summary || 'nessuno configurato'}).`;
    }
  }

  return 'Si è verificato un errore imprevisto durante l’elaborazione.';
}

/** Codice macchina dell'errore, se disponibile: alimenta i filtri in UI. */
export function toErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; name?: unknown; rateLimited?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    if (candidate.name === 'AllProvidersFailedError') {
      return candidate.rateLimited ? 'RATE_LIMITED' : 'ALL_PROVIDERS_FAILED';
    }
  }
  return undefined;
}

/** Vero se l'errore è transitorio e vale la pena ritentare. */
export function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const candidate = error as { retryable?: unknown };
    if (typeof candidate.retryable === 'boolean') return candidate.retryable;
  }
  // In dubbio ritentiamo: un falso positivo costa un tentativo, un falso
  // negativo manda in dead-letter un job che sarebbe riuscito.
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Carica il record del job dal database.
 * Il worker riceve da BullMQ solo l'id: tutto il resto (scope, payload,
 * tentativi) sta in Postgres, che è la fonte di verità.
 *
 * RITENTA brevemente se non trova nulla, invece di arrendersi al primo giro.
 *
 * Le Server Action web accodano dentro `withUserContext`: la riga Postgres e
 * la push su Redis avvengono nella STESSA transazione, che committa solo
 * quando l'intera action ritorna — ma Redis consegna il job al worker subito,
 * prima del commit. Se il worker è più veloce del commit (capita, non è raro
 * su un job semplice), questa select non vedeva ancora la riga: tornava
 * `null`, `handleJob` usciva pulito senza toccare nulla, e BullMQ segnava il
 * job "completato" — nessun errore, quindi nessun retry automatico, e la riga
 * Postgres restava `pending` per sempre. Scoperto in produzione su articoli
 * bloccati "in lavorazione" che non venivano mai ripresi.
 *
 * Il worker che accoda per sé stesso (`apps/worker/src/index.ts`, fuori da
 * qualunque transazione con commit differito) non ha questa corsa: la
 * retry qui è innocua e quasi sempre a costo zero in quel caso, si attiva
 * solo quando serve davvero.
 */
export async function loadJobRecord(jobId: string) {
  const db = getWorkerDb();
  const delaysMs = [50, 100, 200, 400, 800];

  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    const [record] = await db
      .select({
        id: jobs.id,
        organizationId: jobs.organizationId,
        productId: jobs.productId,
        type: jobs.type,
        status: jobs.status,
        targetId: jobs.targetId,
        payload: jobs.payload,
        attempts: jobs.attempts,
        maxAttempts: jobs.maxAttempts,
        traceId: jobs.traceId,
      })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    if (record) return record;
    if (attempt < delaysMs.length) await sleep(delaysMs[attempt]);
  }

  return null;
}

/**
 * Job rimasti appesi in `running` oltre la soglia.
 *
 * Succede quando il worker viene ucciso a metà elaborazione: il job resta
 * `running` per sempre e nessuno lo riprende. Il recovery all'avvio li rimette
 * in coda — è ciò che rende la pipeline resistente ai riavvii.
 */
export async function findStaleRunningJobs(olderThanMinutes: number) {
  const db = getWorkerDb();
  const threshold = new Date(Date.now() - olderThanMinutes * 60_000);

  return db
    .select({
      id: jobs.id,
      type: jobs.type,
      organizationId: jobs.organizationId,
      productId: jobs.productId,
      targetId: jobs.targetId,
      payload: jobs.payload,
      traceId: jobs.traceId,
    })
    .from(jobs)
    .where(and(eq(jobs.status, 'running'), sql`${jobs.startedAt} < ${threshold}`))
    .limit(100);
}
