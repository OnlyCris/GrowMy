import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './_shared';
import { articles, keywords } from './content';
import { organizations, users } from './identity';
import { products } from './products';

/**
 * UPGRADE #2 — CLOSED-LOOP PLANNER
 *
 * Queste tabelle chiudono il ciclo: i dati reali di Google Search Console
 * retroagiscono sulla pianificazione editoriale invece di restare un cruscotto passivo.
 */

/**
 * Connessione OAuth a Google Search Console.
 * I token seguono la stessa disciplina delle integrazioni CMS: cifrati AES-256-GCM
 * con chiave presente solo nell'ambiente del worker.
 */
export const gscConnections = pgTable(
  'gsc_connections',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    /** Property GSC selezionata (es. 'sc-domain:acme.com'). */
    siteUrl: text('site_url').notNull(),

    encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
    credentialsIv: text('credentials_iv').notNull(),
    credentialsKeyVersion: integer('credentials_key_version').notNull().default(1),

    /** Email dell'account Google collegato, mostrata in UI per chiarezza. */
    connectedEmail: text('connected_email'),

    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** Ultima data giornaliera importata: il sync riparte da qui (incrementale). */
    lastSyncedDate: date('last_synced_date'),
    lastSyncError: text('last_sync_error'),

    isActive: boolean('is_active').notNull().default(true),
    connectedBy: uuid('connected_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    // Una sola connessione attiva per prodotto.
    uniqueIndex('gsc_connections_product_uq')
      .on(t.productId)
      .where(sql`${t.isActive} = true`),
    index('gsc_connections_sync_due_idx')
      .on(t.lastSyncedAt)
      .where(sql`${t.isActive} = true`),
  ],
);

/**
 * Metriche giornaliere per (pagina, query). È la tabella più voluminosa del sistema.
 *
 * SCALA: partizionata per RANGE su `date` (partizioni mensili create dallo script
 * `scripts/db/ensure-partitions.sh`, eseguito da `update.sh`). Le partizioni più
 * vecchie di 16 mesi vengono staccate e archiviate, non cancellate.
 */
export const gscDailyMetrics = pgTable(
  'gsc_daily_metrics',
  {
    id: primaryId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Collegamento all'articolo quando l'URL corrisponde a un contenuto generato. */
    articleId: uuid('article_id').references(() => articles.id, {
      onDelete: 'set null',
    }),

    date: date('date').notNull(),
    page: text('page').notNull(),
    query: text('query').notNull(),
    country: text('country'),
    device: text('device'),

    clicks: integer('clicks').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    ctr: numeric('ctr', { precision: 6, scale: 5 }).notNull().default('0'),
    /** Posizione media. Chiave del calcolo "striking distance" (8 <= pos <= 20). */
    position: numeric('position', { precision: 6, scale: 2 }).notNull().default('0'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('gsc_daily_metrics_dimensions_uq').on(
      t.productId,
      t.date,
      t.page,
      t.query,
      t.country,
      t.device,
    ),
    // Query del planner: opportunità in striking distance nell'ultimo periodo.
    index('gsc_striking_distance_idx')
      .on(t.productId, t.date.desc(), t.position)
      .where(sql`${t.position} >= 8 and ${t.position} <= 20`),
    // Query di cannibalizzazione: stessa query, più pagine.
    index('gsc_query_page_idx').on(t.productId, t.query, t.page),
    index('gsc_article_date_idx').on(t.articleId, t.date.desc()),
  ],
);

/**
 * Cannibalizzazioni rilevate: due o più URL dello stesso sito competono sulla
 * stessa query. Il planner propone consolidamento o differenziazione dell'intento.
 */
export const cannibalizationIssues = pgTable(
  'cannibalization_issues',
  {
    id: primaryId(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    /** URL in conflitto con le rispettive metriche aggregate. */
    competingPages: jsonb('competing_pages')
      .$type<
        Array<{
          page: string;
          articleId: string | null;
          clicks: number;
          impressions: number;
          position: number;
        }>
      >()
      .notNull(),
    /** 'low' | 'medium' | 'high': in base a impressioni perse stimate. */
    severity: text('severity').notNull(),
    /** 'merge' | 'differentiate' | 'canonicalize' | 'ignore' */
    recommendedAction: text('recommended_action').notNull(),
    /** Azione presa dall'utente; NULL = non ancora gestita. */
    resolvedAction: text('resolved_action'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    detectedAt: timestamp('detected_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('cannibalization_product_query_open_uq')
      .on(t.productId, sql`lower(${t.query})`)
      .where(sql`${t.resolvedAt} is null`),
    index('cannibalization_product_idx').on(t.productId, t.severity),
  ],
);

/**
 * Registro delle decisioni del planner. Append-only.
 *
 * È il cuore della trasparenza dell'UPGRADE #2: ogni volta che il planner promuove,
 * declassa, aggiunge o marca come "da rinfrescare" una keyword, scrive QUI il perché,
 * con i numeri che hanno motivato la scelta. La UI legge da questa tabella per
 * rispondere alla domanda "perché questa keyword questa settimana?".
 */
export const plannerDecisions = pgTable(
  'planner_decisions',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Esecuzione del planner a cui appartiene la decisione (raggruppa il batch). */
    runId: uuid('run_id').notNull(),

    keywordId: uuid('keyword_id').references(() => keywords.id, {
      onDelete: 'cascade',
    }),
    articleId: uuid('article_id').references(() => articles.id, {
      onDelete: 'cascade',
    }),

    /** 'promote' | 'demote' | 'add_keyword' | 'schedule_refresh' | 'flag_cannibalization' | 'archive' */
    decision: text('decision').notNull(),

    priorityBefore: numeric('priority_before', { precision: 5, scale: 2 }),
    priorityAfter: numeric('priority_after', { precision: 5, scale: 2 }),

    /** Spiegazione in linguaggio naturale, mostrata direttamente all'utente. */
    rationale: text('rationale').notNull(),
    /** Numeri grezzi che hanno motivato la decisione: { impressions, avgPosition, ... }. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('planner_decisions_product_created_idx').on(
      t.productId,
      t.createdAt.desc(),
    ),
    index('planner_decisions_run_idx').on(t.runId),
    index('planner_decisions_keyword_idx').on(t.keywordId),
  ],
);
