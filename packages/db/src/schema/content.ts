import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

import { primaryId, softDelete, timestamps } from './_shared';
import {
  articleStatusEnum,
  keywordSourceEnum,
  keywordStatusEnum,
  publicationAttemptStatusEnum,
} from './enums';
import { organizations, users } from './identity';
import { integrations, products } from './products';

/**
 * PIPELINE DI CONTENUTO: Cluster -> Keyword -> Article -> Version -> Publication
 */

/**
 * Cluster tematico (topic cluster). Raggruppa keyword semanticamente vicine.
 * Serve a due cose: evitare cannibalizzazione (due articoli sullo stesso intento)
 * e costruire automaticamente il link interno fra pillar e articoli di supporto.
 */
export const keywordClusters = pgTable(
  'keyword_clusters',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Articolo "pillar" del cluster, verso cui puntano i link interni. */
    pillarArticleId: uuid('pillar_article_id'),
    ...timestamps,
  },
  (t) => [index('keyword_clusters_product_idx').on(t.productId)],
);

/**
 * KEYWORD: unità di pianificazione. Una keyword produce al massimo un articolo.
 */
export const keywords = pgTable(
  'keywords',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    clusterId: uuid('cluster_id').references(() => keywordClusters.id, {
      onDelete: 'set null',
    }),

    /** Testo della keyword, normalizzato lowercase+trim prima dell'insert. */
    term: text('term').notNull(),
    status: keywordStatusEnum('status').notNull().default('suggested'),
    source: keywordSourceEnum('source').notNull().default('ai_research'),

    /**
     * True per la keyword "testa" del cluster: quando il suo articolo viene
     * creato, diventa il pillar del cluster (`keywordClusters.pillarArticleId`)
     * — l'articolo verso cui convergono i link interni di tutti gli altri.
     * Al più una per cluster, deciso in fase di ricerca keyword (vedi
     * `keywordResearchPrompt`), non modificabile dopo.
     */
    isPillar: boolean('is_pillar').notNull().default(false),

    // --- Metriche SEO (da provider esterno o stimate) --------------------
    searchVolume: integer('search_volume'),
    /** 0-100. `numeric` e non `float` per evitare drift nei confronti/ordinamenti. */
    difficulty: numeric('difficulty', { precision: 5, scale: 2 }),
    cpc: numeric('cpc', { precision: 10, scale: 2 }),
    /** 'informational' | 'commercial' | 'transactional' | 'navigational' */
    searchIntent: text('search_intent'),

    /**
     * Punteggio di priorità calcolato dal planner (0-100).
     * È il campo su cui si ordina la coda di produzione.
     */
    priorityScore: numeric('priority_score', { precision: 5, scale: 2 })
      .notNull()
      .default('50'),
    /**
     * UPGRADE #2: motivazione leggibile della priorità, mostrata in UI
     * ("Posizione media 12 su GSC con 340 impressioni/mese: opportunità a portata").
     * Rende trasparente una decisione che nell'originale è opaca.
     */
    priorityRationale: text('priority_rationale'),

    /** Data/ora pianificata per la generazione. NULL = non schedulata. */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),

    /**
     * Embedding del termine per la deduplicazione semantica: prima di accodare
     * una nuova keyword verifichiamo che non esista già un articolo troppo vicino
     * (cosine distance < soglia), prevenendo la cannibalizzazione alla radice.
     */
    embedding: vector('embedding', { dimensions: 1536 }),

    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // Nessun duplicato esatto per prodotto.
    uniqueIndex('keywords_product_term_uq')
      .on(t.productId, sql`lower(${t.term})`)
      .where(sql`${t.deletedAt} is null`),
    // Query calda: coda di produzione ordinata per priorità.
    index('keywords_queue_idx')
      .on(t.productId, t.status, t.priorityScore.desc())
      .where(sql`${t.deletedAt} is null`),
    // Query del cron: cosa è schedulato e scaduto.
    index('keywords_scheduled_idx')
      .on(t.scheduledFor)
      .where(sql`${t.status} = 'scheduled' and ${t.deletedAt} is null`),
    index('keywords_cluster_idx').on(t.clusterId),
    // Indice HNSW per la ricerca vettoriale di similarità (richiede pgvector).
    index('keywords_embedding_hnsw_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
);

/**
 * ARTICLE: entità centrale. La riga rappresenta lo *stato corrente*; il contenuto
 * vive in `article_versions` (append-only) così ogni rigenerazione è reversibile.
 */
export const articles = pgTable(
  'articles',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    keywordId: uuid('keyword_id').references(() => keywords.id, {
      onDelete: 'set null',
    }),

    status: articleStatusEnum('status').notNull().default('queued'),

    title: text('title'),
    slug: text('slug'),
    metaDescription: text('meta_description'),
    excerpt: text('excerpt'),

    /** Puntatore alla versione attualmente "corrente". */
    currentVersionId: uuid('current_version_id'),

    /**
     * UPGRADE #1: il brief è editabile PRIMA della stesura.
     * Struttura: { angle, outline: [{h2, h3[], intent}], sourcesToCite[], cta }.
     */
    brief: jsonb('brief').$type<Record<string, unknown>>(),
    briefApprovedAt: timestamp('brief_approved_at', { withTimezone: true }),
    briefApprovedBy: uuid('brief_approved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    draftApprovedAt: timestamp('draft_approved_at', { withTimezone: true }),
    draftApprovedBy: uuid('draft_approved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** True se l'approvazione è avvenuta per timeout e non per azione umana. */
    approvedByTimeout: boolean('approved_by_timeout').notNull().default(false),

    /**
     * UPGRADE #1: quality score calcolato prima di mostrare la bozza.
     * { readability, keywordDensity, originality, factDensity, internalLinks }.
     * Se una metrica è sotto soglia l'articolo viene rigenerato automaticamente
     * una volta prima di finire in review, senza consumare un credito aggiuntivo.
     */
    qualityScore: jsonb('quality_score').$type<Record<string, number>>(),

    wordCount: integer('word_count'),
    /** URL dell'immagine di copertina su storage. */
    featuredImageUrl: text('featured_image_url'),

    /** URL pubblico dell'articolo dopo la pubblicazione. */
    publishedUrl: text('published_url'),
    /** ID della risorsa sul CMS remoto: serve per gli update successivi. */
    externalId: text('external_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    /** Se questo articolo è un refresh di uno precedente. */
    refreshOfArticleId: uuid('refresh_of_article_id'),

    /** Messaggio d'errore utente-friendly in caso di stato `failed`. */
    failureReason: text('failure_reason'),

    /** Embedding del contenuto: alimenta il link interno automatico e l'anti-duplicazione. */
    embedding: vector('embedding', { dimensions: 1536 }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // Slug unico per prodotto fra gli articoli non cancellati.
    uniqueIndex('articles_product_slug_uq')
      .on(t.productId, t.slug)
      .where(sql`${t.slug} is not null and ${t.deletedAt} is null`),
    // Una keyword genera un solo articolo vivo.
    uniqueIndex('articles_keyword_uq')
      .on(t.keywordId)
      .where(sql`${t.keywordId} is not null and ${t.deletedAt} is null`),
    // Query calda della dashboard: lista articoli per prodotto, per data.
    index('articles_product_created_idx').on(t.productId, t.createdAt.desc()),
    // Query calda della review queue (UPGRADE #1).
    index('articles_review_queue_idx')
      .on(t.organizationId, t.status, t.updatedAt.desc())
      .where(sql`${t.status} in ('brief_ready','draft_ready')`),
    // Query del cron di auto-approve per timeout.
    index('articles_awaiting_approval_idx')
      .on(t.status, t.updatedAt)
      .where(sql`${t.status} in ('brief_ready','draft_ready')`),
    index('articles_embedding_hnsw_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
);

/**
 * Versioni del contenuto. Append-only: ogni rigenerazione, ogni edit umano e ogni
 * rewrite AI crea una nuova riga. Permette il diff in UI e il rollback istantaneo.
 */
export const articleVersions = pgTable(
  'article_versions',
  {
    id: primaryId(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    /** Progressivo per articolo, 1-based. */
    versionNumber: integer('version_number').notNull(),

    /** Sorgente canonica del contenuto: Markdown. L'HTML è derivato al publish. */
    contentMarkdown: text('content_markdown').notNull(),
    /** JSON dell'editor Tiptap, per una riapertura fedele in UI. */
    contentJson: jsonb('content_json').$type<Record<string, unknown>>(),

    title: text('title'),
    metaDescription: text('meta_description'),

    /** 'ai_generation' | 'ai_rewrite' | 'human_edit' | 'refresh' */
    createdVia: text('created_via').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    /** Provider e modello usati: essenziale per debug qualità e cost tracking. */
    llmProvider: text('llm_provider'),
    llmModel: text('llm_model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** Costo in micro-dollari (intero): niente float sul denaro. */
    costMicroUsd: integer('cost_micro_usd'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('article_versions_article_number_uq').on(
      t.articleId,
      t.versionNumber,
    ),
    index('article_versions_article_idx').on(t.articleId, t.createdAt.desc()),
  ],
);

/**
 * UPGRADE #3: log per-tentativo di pubblicazione.
 * Nell'originale l'utente vede solo "pubblicazione fallita". Qui vede
 * ogni tentativo, con causa leggibile, codice HTTP e prossimo retry.
 */
export const articlePublications = pgTable(
  'article_publications',
  {
    id: primaryId(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),

    attemptNumber: smallint('attempt_number').notNull(),
    status: publicationAttemptStatusEnum('status').notNull(),

    httpStatus: smallint('http_status'),
    /** Messaggio già tradotto per l'utente. MAI raw stack trace (regola progetto). */
    errorMessage: text('error_message'),
    /** Codice macchina per la UI ('WP_401_INVALID_APP_PASSWORD'). */
    errorCode: text('error_code'),

    externalId: text('external_id'),
    publishedUrl: text('published_url'),

    durationMs: integer('duration_ms'),
    /** Quando è previsto il prossimo tentativo (backoff esponenziale). */
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),

    attemptedAt: timestamp('attempted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('article_publications_attempt_uq').on(
      t.articleId,
      t.integrationId,
      t.attemptNumber,
    ),
    index('article_publications_article_idx').on(t.articleId, t.attemptedAt.desc()),
  ],
);

/**
 * Asset generati (immagini AI, copertine). Il binario vive su object storage,
 * qui restano solo metadati e URL.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id').references(() => articles.id, {
      onDelete: 'cascade',
    }),

    /** Percorso nel bucket. L'URL pubblico è derivato, non persistito. */
    storagePath: text('storage_path').notNull(),
    mimeType: text('mime_type').notNull(),
    width: integer('width'),
    height: integer('height'),
    sizeBytes: integer('size_bytes'),
    /** Alt text: obbligatorio per accessibilità e SEO. */
    altText: text('alt_text'),
    /** Prompt usato per la generazione, per rigenerare varianti coerenti. */
    generationPrompt: text('generation_prompt'),

    ...timestamps,
  },
  (t) => [
    index('media_assets_article_idx').on(t.articleId),
    index('media_assets_product_idx').on(t.productId),
  ],
);

/**
 * Link interni suggeriti/inseriti fra articoli. Materializzare la relazione
 * permette di ricostruire il grafo dei link e di riparare i link rotti quando
 * un articolo viene depubblicato.
 */
export const internalLinks = pgTable(
  'internal_links',
  {
    id: primaryId(),
    sourceArticleId: uuid('source_article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    targetArticleId: uuid('target_article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    anchorText: text('anchor_text').notNull(),
    /** Similarità semantica che ha motivato il link (0-1). */
    relevanceScore: numeric('relevance_score', { precision: 4, scale: 3 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('internal_links_pair_uq').on(t.sourceArticleId, t.targetArticleId),
    index('internal_links_target_idx').on(t.targetArticleId),
  ],
);
