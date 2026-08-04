import { sql } from 'drizzle-orm';
import {
  boolean,
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

import { primaryId, softDelete, timestamps } from './_shared';
import {
  healthCheckResultEnum,
  integrationProviderEnum,
  integrationStatusEnum,
  productStatusEnum,
} from './enums';
import { organizations, users } from './identity';

/**
 * PRODUCTS = i siti web gestiti. È l'unità di sottoscrizione e di configurazione.
 */

export const products = pgTable(
  'products',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** Dominio normalizzato senza schema né www (es. 'acme.com'). Validato con Zod. */
    domain: text('domain').notNull(),
    /** URL completo con schema, usato per crawling e link assoluti. */
    websiteUrl: text('website_url').notNull(),

    status: productStatusEnum('status').notNull().default('onboarding'),

    // --- Configurazione editoriale --------------------------------------
    /** BCP-47 (es. 'it-IT'). Determina la lingua di generazione. */
    contentLanguage: text('content_language').notNull().default('en-US'),
    /** IANA timezone: le pubblicazioni sono schedulate nell'orario locale del cliente. */
    timezone: text('timezone').notNull().default('UTC'),
    /** Ora locale di pubblicazione giornaliera, 0-23. */
    publishHour: smallint('publish_hour').notNull().default(9),
    /** Giorni della settimana attivi, 0=domenica. Default: tutti. */
    activeWeekdays: jsonb('active_weekdays')
      .$type<number[]>()
      .notNull()
      .default(sql`'[0,1,2,3,4,5,6]'::jsonb`),
    targetWordCountMin: integer('target_word_count_min').notNull().default(1200),
    targetWordCountMax: integer('target_word_count_max').notNull().default(1700),

    // --- UPGRADE #1: human-in-the-loop ----------------------------------
    /**
     * Se true la pipeline salta gli stati di attesa (`brief_ready`, `draft_ready`)
     * e procede in autopilota puro. Se false l'articolo si ferma e attende un umano.
     */
    autoApproveBrief: boolean('auto_approve_brief').notNull().default(true),
    autoApproveDraft: boolean('auto_approve_draft').notNull().default(true),
    /**
     * Fallback anti-stallo: se nessuno approva entro N ore, la pipeline procede
     * comunque. NULL = attende indefinitamente. Evita che un utente in ferie
     * blocchi la produzione e sprechi il piano mensile.
     */
    approvalTimeoutHours: integer('approval_timeout_hours').default(48),

    // --- UPGRADE #2: closed-loop planner --------------------------------
    /** Abilita il ricalcolo settimanale del piano editoriale sui dati GSC reali. */
    closedLoopPlannerEnabled: boolean('closed_loop_planner_enabled')
      .notNull()
      .default(true),
    lastPlannerRunAt: timestamp('last_planner_run_at', { withTimezone: true }),

    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** Motivo leggibile della pausa ('user_request' | 'subscription_past_due' | ...). */
    pausedReason: text('paused_reason'),

    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // Lo stesso dominio non può essere registrato due volte nella stessa org
    // (ma org diverse possono gestire lo stesso dominio: caso agenzia/cliente).
    uniqueIndex('products_org_domain_uq')
      .on(t.organizationId, sql`lower(${t.domain})`)
      .where(sql`${t.deletedAt} is null`),
    index('products_org_status_idx').on(t.organizationId, t.status),
    // Query calda del cron giornaliero: "quali prodotti attivi devo processare?"
    index('products_active_scheduling_idx')
      .on(t.status, t.publishHour)
      .where(sql`${t.status} = 'active' and ${t.deletedAt} is null`),
  ],
);

/**
 * Profilo di brand generato in onboarding dall'analisi del sito e poi editabile.
 * Separato da `products` perché è un blob pesante letto solo dai worker di
 * generazione, non dalle liste in UI: tenerlo fuori mantiene `products` compatto.
 */
export const productBrandProfiles = pgTable('product_brand_profiles', {
  productId: uuid('product_id')
    .primaryKey()
    .references(() => products.id, { onDelete: 'cascade' }),

  /** Descrizione sintetica del business, dedotta dal crawling. */
  businessSummary: text('business_summary'),
  /** Buyer persona in linguaggio naturale. */
  targetAudience: text('target_audience'),
  /** Proposta di valore / differenziatori, usata per i CTA in articolo. */
  valueProposition: text('value_proposition'),
  /** Istruzioni di tono di voce. Iniettate nel prompt di generazione. */
  toneOfVoice: text('tone_of_voice'),
  /** Argomenti/termini vietati. Guardrail applicato in post-generazione. */
  forbiddenTopics: jsonb('forbidden_topics')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** URL di articoli esistenti dati in pasto al style-matching. */
  styleReferenceUrls: jsonb('style_reference_urls')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** Competitor identificati: input per la gap analysis. */
  competitorDomains: jsonb('competitor_domains')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** Palette esadecimale per le immagini on-brand. */
  brandColors: jsonb('brand_colors')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** Stile immagini: 'photorealistic' | 'illustration' | 'isometric' | ... */
  imageStyle: text('image_style').notNull().default('illustration'),
  /** Snapshot del crawling di onboarding, per rieseguire l'analisi senza ricrawlare. */
  crawlSnapshot: jsonb('crawl_snapshot').$type<Record<string, unknown>>(),

  ...timestamps,
});

/**
 * INTEGRAZIONI CMS.
 *
 * SICUREZZA CREDENZIALI: `encryptedCredentials` contiene un payload cifrato
 * AES-256-GCM con una chiave che vive SOLO nell'ambiente del worker
 * (`CREDENTIALS_ENCRYPTION_KEY`), mai nel bundle Next.js e mai nel database.
 * Nessuna Server Action restituisce mai questo campo al client: le query di lettura
 * usano select espliciti che lo escludono (vedi `packages/db/src/queries/integrations.ts`).
 */
export const integrations = pgTable(
  'integrations',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    provider: integrationProviderEnum('provider').notNull(),
    status: integrationStatusEnum('status').notNull().default('pending'),

    /** Etichetta scelta dall'utente ("Blog principale"). */
    label: text('label'),

    /** Payload cifrato: token, chiavi applicative, refresh token. */
    encryptedCredentials: text('encrypted_credentials').notNull(),
    /** IV/nonce del cifrario, per-riga. */
    credentialsIv: text('credentials_iv').notNull(),
    /** Versione della chiave di cifratura: consente la rotazione senza downtime. */
    credentialsKeyVersion: smallint('credentials_key_version').notNull().default(1),

    /** Config NON sensibile: id collezione Webflow, post type WP, mapping campi. */
    config: jsonb('config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    /** Se true pubblica come bozza sul CMS invece che live. */
    publishAsDraft: boolean('publish_as_draft').notNull().default(true),
    /** Se false l'integrazione è configurata ma esclusa dalla pubblicazione automatica. */
    isPrimary: boolean('is_primary').notNull().default(true),

    // --- UPGRADE #3: osservabilità preventiva ---------------------------
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    lastHealthCheckResult: healthCheckResultEnum('last_health_check_result'),
    /** Messaggio d'errore già tradotto per l'utente. MAI uno stack trace. */
    lastErrorMessage: text('last_error_message'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),

    /** OAuth: scadenza del token, per rinnovarlo prima che scada. */
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),

    connectedBy: uuid('connected_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // Una sola integrazione primaria per prodotto: garantito dall'indice parziale.
    uniqueIndex('integrations_product_primary_uq')
      .on(t.productId)
      .where(sql`${t.isPrimary} = true and ${t.deletedAt} is null`),
    index('integrations_product_idx').on(t.productId),
    index('integrations_org_idx').on(t.organizationId),
    // Query del cron di health-check: integrazioni da ricontrollare.
    index('integrations_health_due_idx')
      .on(t.lastHealthCheckAt)
      .where(sql`${t.deletedAt} is null and ${t.status} <> 'disabled'`),
  ],
);

/**
 * Storico degli health-check. Append-only.
 * Alimenta la pagina "Stato integrazioni" e permette all'utente di vedere
 * *quando* si è rotto qualcosa, non solo *che* è rotto.
 */
export const integrationHealthChecks = pgTable(
  'integration_health_checks',
  {
    id: primaryId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    result: healthCheckResultEnum('result').notNull(),
    /** Latenza della chiamata di verifica in ms. */
    durationMs: integer('duration_ms'),
    /** Codice HTTP restituito dal CMS, se applicabile. */
    httpStatus: smallint('http_status'),
    /** Messaggio sanificato: nessun token, nessun header di autorizzazione. */
    message: text('message'),
    checkedAt: timestamp('checked_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('integration_health_checks_int_idx').on(
      t.integrationId,
      t.checkedAt.desc(),
    ),
  ],
);
