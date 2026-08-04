import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './_shared';
import { jobEventLevelEnum, jobStatusEnum, jobTypeEnum } from './enums';
import { organizations } from './identity';
import { products } from './products';

/**
 * UPGRADE #3 — OSSERVABILITÀ DEI JOB
 *
 * BullMQ vive in Redis, che è volatile e non interrogabile dalla UI in modo
 * relazionale. Questa tabella è il *mirror persistente* dello stato dei job:
 * il worker la aggiorna a ogni transizione. Serve a tre cose:
 *  1. Mostrare all'utente cosa sta succedendo e perché è fallito.
 *  2. Ricostruire la coda se Redis viene perso (Redis è cache, Postgres è verità).
 *  3. Garantire l'idempotenza tramite `idempotencyKey`.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, {
      onDelete: 'cascade',
    }),

    type: jobTypeEnum('type').notNull(),
    status: jobStatusEnum('status').notNull().default('pending'),

    /**
     * IDEMPOTENZA. Formato: `{type}:{entityId}:{discriminator}`.
     * Es. 'article_publish:9f3a...:attempt-of-2026-07-21'.
     * L'unique index impedisce che due invocazioni concorrenti (cron doppio,
     * click ripetuto, retry di rete) accodino due volte lo stesso lavoro.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    /** ID del job in BullMQ, per correlare i log del worker. */
    queueJobId: text('queue_job_id'),

    /** Entità su cui opera il job (articolo, keyword, integrazione...). */
    targetType: text('target_type'),
    targetId: uuid('target_id'),

    /** Input del job. Non contiene MAI credenziali: solo id da risolvere a runtime. */
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),

    /** Priorità BullMQ: numero più basso = eseguito prima. */
    priority: smallint('priority').notNull().default(50),

    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),

    /** Errore già tradotto per l'utente. Lo stack trace va solo al logger, mai qui. */
    lastError: text('last_error'),
    lastErrorCode: text('last_error_code'),

    /** ID di correlazione end-to-end (request -> job -> sub-job) per il tracing. */
    traceId: text('trace_id'),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('jobs_idempotency_uq').on(t.idempotencyKey),
    // Query calda della UI: attività recente per prodotto.
    index('jobs_product_created_idx').on(t.productId, t.createdAt.desc()),
    // Query del recovery: job da riaccodare se Redis è stato perso.
    index('jobs_pending_scheduled_idx')
      .on(t.status, t.scheduledFor)
      .where(sql`${t.status} in ('pending','running')`),
    // Query della dead-letter queue mostrata agli admin.
    index('jobs_dead_letter_idx')
      .on(t.organizationId, t.finishedAt.desc())
      .where(sql`${t.status} = 'dead_lettered'`),
    index('jobs_target_idx').on(t.targetType, t.targetId),
  ],
);

/**
 * Log strutturato per-step del job. È ciò che l'utente vede espandendo
 * un articolo fallito: una timeline leggibile, non uno stack trace.
 */
export const jobEvents = pgTable(
  'job_events',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    level: jobEventLevelEnum('level').notNull().default('info'),
    /** Step della pipeline: 'research' | 'outline' | 'draft' | 'images' | 'publish'. */
    step: text('step').notNull(),
    /** Messaggio destinato all'utente finale, già sanificato e localizzabile. */
    message: text('message').notNull(),
    /** Dettagli tecnici non sensibili. Nessun token, nessuna PII. */
    details: jsonb('details').$type<Record<string, unknown>>(),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('job_events_job_created_idx').on(t.jobId, t.createdAt)],
);

/**
 * Consegne webhook in uscita (integrazione 'webhook' e notifiche verso terzi).
 * Ogni consegna è firmata HMAC-SHA256; qui persistiamo l'esito per il retry
 * e per la pagina di debug lato utente.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Endpoint di destinazione. Validato contro SSRF prima di ogni chiamata. */
    targetUrl: text('target_url').notNull(),
    eventType: text('event_type').notNull(),

    /** Corpo inviato. Il segreto di firma NON è persistito qui. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    attemptNumber: smallint('attempt_number').notNull().default(1),
    httpStatus: smallint('http_status'),
    responseBodySnippet: text('response_body_snippet'), // troncato a 1KB
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),

    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('webhook_deliveries_org_created_idx').on(
      t.organizationId,
      t.createdAt.desc(),
    ),
    index('webhook_deliveries_retry_idx')
      .on(t.nextRetryAt)
      .where(sql`${t.deliveredAt} is null and ${t.nextRetryAt} is not null`),
  ],
);

/**
 * Rate limiting persistente (finestra scorrevole) per gli endpoint costosi e
 * per l'autenticazione. Redis resta il percorso caldo; questa tabella è il
 * fallback durevole e la fonte per i blocchi prolungati anti brute-force,
 * che devono sopravvivere a un riavvio di Redis.
 */
export const rateLimitViolations = pgTable(
  'rate_limit_violations',
  {
    id: primaryId(),
    /** Identificatore soggetto: 'ip:1.2.3.0' | 'user:<uuid>' | 'apikey:<uuid>'. */
    subject: text('subject').notNull(),
    scope: text('scope').notNull(), // 'auth.signin' | 'articles.generate' | ...
    violations: integer('violations').notNull().default(1),
    /** Blocco attivo fino a questo istante. */
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('rate_limit_subject_scope_uq').on(t.subject, t.scope),
    index('rate_limit_blocked_idx')
      .on(t.blockedUntil)
      .where(sql`${t.blockedUntil} is not null`),
  ],
);
