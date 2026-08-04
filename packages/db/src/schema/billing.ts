import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './_shared';
import { creditTxnTypeEnum, subscriptionStatusEnum } from './enums';
import { articles } from './content';
import { organizations } from './identity';
import { products } from './products';

/**
 * BILLING
 *
 * Principio: Stripe è la fonte di verità per lo stato di pagamento, il database è
 * la fonte di verità per il diritto di consumo (crediti). I due sono riconciliati
 * dai webhook, che sono idempotenti per `stripe_event_id`.
 */

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id'),
    stripePriceId: text('stripe_price_id'),

    status: subscriptionStatusEnum('status').notNull().default('trialing'),

    /** Numero di prodotti (siti) inclusi. Determina lo sconto volume. */
    seats: integer('seats').notNull().default(1),
    /** Articoli inclusi per ciclo, per prodotto. */
    articlesPerCycle: integer('articles_per_cycle').notNull().default(30),

    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    // Una sola subscription per organizzazione.
    uniqueIndex('subscriptions_org_uq').on(t.organizationId),
    uniqueIndex('subscriptions_stripe_sub_uq')
      .on(t.stripeSubscriptionId)
      .where(sql`${t.stripeSubscriptionId} is not null`),
    index('subscriptions_stripe_customer_idx').on(t.stripeCustomerId),
    // Cron di rinnovo crediti: chi ha il periodo in scadenza.
    index('subscriptions_period_end_idx').on(t.currentPeriodEnd),
  ],
);

/**
 * LEDGER CREDITI — append-only, mai UPDATE, mai DELETE.
 *
 * Il saldo disponibile è `SUM(amount)` sulle righe non scadute. Il flusso è:
 *   grant_subscription (+30) -> reserve (-1) -> consume (0) | release (+1)
 *
 * UPGRADE #3: `reserve` avviene all'accodamento, `consume` SOLO a pubblicazione
 * confermata. Se il job finisce in dead-letter, un `release` restituisce il credito
 * automaticamente. Nell'originale un fallimento di pubblicazione brucia il credito.
 *
 * `reservationId` collega reserve/consume/release della stessa operazione.
 */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, {
      onDelete: 'set null',
    }),
    articleId: uuid('article_id').references(() => articles.id, {
      onDelete: 'set null',
    }),

    type: creditTxnTypeEnum('type').notNull(),
    /** Positivo per accrediti, negativo per addebiti, 0 per `consume`. */
    amount: integer('amount').notNull(),

    /** Raggruppa reserve/consume/release della stessa operazione. */
    reservationId: uuid('reservation_id'),

    /**
     * Chiave di idempotenza: impedisce doppi accrediti se un webhook Stripe
     * viene consegnato due volte, o doppie riserve se un job viene ritentato.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    /** Scadenza dei crediti concessi (fine ciclo). NULL = non scadono. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    description: text('description'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_ledger_idempotency_uq').on(t.idempotencyKey),
    // Query calda: calcolo del saldo disponibile.
    index('credit_ledger_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    index('credit_ledger_reservation_idx')
      .on(t.reservationId)
      .where(sql`${t.reservationId} is not null`),
    index('credit_ledger_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ],
);

/**
 * Webhook Stripe processati. L'unicità su `stripeEventId` è la garanzia di
 * idempotenza: Stripe consegna at-least-once, noi processiamo exactly-once.
 */
export const stripeEvents = pgTable(
  'stripe_events',
  {
    id: primaryId(),
    stripeEventId: text('stripe_event_id').notNull(),
    type: text('type').notNull(),
    /** Payload conservato per replay/debug. Escluso da qualsiasi risposta API. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** Errore di elaborazione: consente il replay manuale. */
    processingError: text('processing_error'),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('stripe_events_event_id_uq').on(t.stripeEventId),
    index('stripe_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

/**
 * Aggregati di utilizzo per ciclo, materializzati.
 * Evita di scansionare l'intero ledger per mostrare "18/30 articoli usati".
 * Aggiornati transazionalmente dagli stessi handler che scrivono sul ledger.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, {
      onDelete: 'cascade',
    }),

    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),

    articlesGenerated: integer('articles_generated').notNull().default(0),
    articlesPublished: integer('articles_published').notNull().default(0),
    articlesFailed: integer('articles_failed').notNull().default(0),
    imagesGenerated: integer('images_generated').notNull().default(0),
    /** Costo LLM accumulato in micro-dollari: unit economics per cliente. */
    llmCostMicroUsd: integer('llm_cost_micro_usd').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('usage_counters_scope_period_uq').on(
      t.organizationId,
      t.productId,
      t.periodStart,
    ),
    index('usage_counters_org_idx').on(t.organizationId, t.periodStart.desc()),
  ],
);
