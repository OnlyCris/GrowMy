import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Tutti gli enum sono definiti a livello di Postgres (non come CHECK o stringhe libere)
 * per due motivi:
 *  1. Drizzle ne inferisce union types letterali in TypeScript -> nessuna stringa magica nel codice.
 *  2. Un valore non previsto viene rifiutato dal database, non solo dall'applicazione (difesa in profondità).
 *
 * NOTA MIGRAZIONI: aggiungere un valore a un enum Postgres è non-distruttivo (`ALTER TYPE ... ADD VALUE`).
 * RIMUOVERE un valore NON lo è: in quel caso si crea un nuovo tipo e si migra in due deploy separati.
 * Aggiungere sempre i nuovi valori IN CODA per non rompere l'ordinamento.
 */

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------

/** Ruoli RBAC all'interno di un'organizzazione, dal più al meno privilegiato. */
export const orgRoleEnum = pgEnum('org_role', [
  'owner', // Unico. Può eliminare l'org e gestire la fatturazione.
  'admin', // Può invitare membri, gestire integrazioni e API key.
  'editor', // Può creare/approvare contenuti ma non toccare billing o membri.
  'viewer', // Sola lettura.
]);

export const invitationStatusEnum = pgEnum('invitation_status', [
  'pending',
  'accepted',
  'revoked',
  'expired',
]);

// ---------------------------------------------------------------------------
// Products & integrations
// ---------------------------------------------------------------------------

export const productStatusEnum = pgEnum('product_status', [
  'onboarding', // Analisi del dominio in corso, nessuna generazione attiva.
  'active', // Pipeline giornaliera attiva.
  'paused', // Sospeso dall'utente o da subscription non attiva.
  'archived', // Soft-delete. Dati conservati, nessun job schedulato.
]);

export const integrationProviderEnum = pgEnum('integration_provider', [
  'wordpress',
  'wordpress_com',
  'webflow',
  'shopify',
  'ghost',
  'notion',
  'wix',
  'framer',
  'webhook',
  'nextjs_blog',
]);

export const integrationStatusEnum = pgEnum('integration_status', [
  'pending', // Credenziali salvate, dry-run non ancora eseguito.
  'healthy', // Ultimo health-check superato.
  'degraded', // Health-check fallito ma con retry disponibili.
  'broken', // Credenziali invalide/revocate: richiede intervento utente.
  'disabled', // Disattivata manualmente.
]);

/** Esito di un singolo health-check preventivo sull'integrazione. */
export const healthCheckResultEnum = pgEnum('health_check_result', [
  'ok',
  'auth_failed',
  'permission_denied',
  'not_found',
  'rate_limited',
  'unreachable',
  'schema_mismatch',
  'unknown_error',
]);

// ---------------------------------------------------------------------------
// Content pipeline
// ---------------------------------------------------------------------------

export const keywordStatusEnum = pgEnum('keyword_status', [
  'suggested', // Proposta dall'AI, non ancora approvata.
  'approved', // Approvata, in attesa di schedulazione.
  'scheduled', // Ha una scheduled_for valorizzata.
  'processing', // Un articolo è in corso di generazione per questa keyword.
  'done', // Articolo pubblicato.
  'rejected', // Scartata dall'utente o dal planner.
]);

/** Origine della keyword: serve al Closed-loop Planner per spiegare le sue scelte. */
export const keywordSourceEnum = pgEnum('keyword_source', [
  'ai_research', // Ricerca iniziale in onboarding.
  'user_manual', // Inserita a mano.
  'gsc_striking_distance', // Posizione 8-20 su GSC: opportunità concreta.
  'gsc_cannibalization_fix', // Generata per consolidare URL in conflitto.
  'competitor_gap', // Gap analysis sui competitor.
  'refresh', // Aggiornamento di un articolo esistente in calo.
]);

/**
 * Macchina a stati dell'articolo. Le transizioni legali sono definite una sola volta
 * in `packages/core/src/articles/state-machine.ts` e validate a runtime:
 * nessun update di stato avviene con una stringa arbitraria.
 */
export const articleStatusEnum = pgEnum('article_status', [
  'queued', // In coda, nessun worker l'ha ancora preso.
  'researching', // Raccolta SERP/fonti in corso.
  'brief_ready', // UPGRADE #1: outline editabile, in attesa di approvazione umana.
  'generating', // Stesura in corso.
  'draft_ready', // UPGRADE #1: bozza completa, in attesa di approvazione umana.
  'approved', // Approvato (da umano o da auto-approve), in coda di pubblicazione.
  'publishing', // Push verso il CMS in corso.
  'published', // Confermato live/draft sul CMS.
  'failed', // Fallimento definitivo dopo esaurimento retry.
  'archived',
]);

export const publicationAttemptStatusEnum = pgEnum('publication_attempt_status', [
  'succeeded',
  'failed_retryable',
  'failed_permanent',
]);

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'paused',
  'canceled',
  'incomplete',
]);

/**
 * UPGRADE #3: i crediti seguono un ledger append-only a doppia entrata.
 * Un credito viene *riservato* all'avvio del job e *consumato* solo a pubblicazione
 * confermata; su fallimento definitivo viene rilasciato automaticamente.
 * Nessuna riga viene mai aggiornata o cancellata: il saldo è la somma degli importi.
 */
export const creditTxnTypeEnum = pgEnum('credit_txn_type', [
  'grant_subscription', // + Ricarica mensile del piano.
  'grant_topup', // + Acquisto extra.
  'grant_promo', // + Bonus manuale/promozionale.
  'reserve', // - Riserva all'avvio della generazione.
  'consume', // 0 Conferma della riserva (chiude la reserve).
  'release', // + Rilascio della riserva su fallimento.
  'expire', // - Scadenza a fine ciclo.
  'adjustment', // ± Correzione manuale (richiede audit log).
]);

// ---------------------------------------------------------------------------
// Ops & observability
// ---------------------------------------------------------------------------

export const jobTypeEnum = pgEnum('job_type', [
  'product_onboarding_analysis',
  'keyword_research',
  'article_research',
  'article_generate',
  'article_publish',
  'integration_health_check',
  'gsc_sync',
  'planner_recalculate',
]);

export const jobStatusEnum = pgEnum('job_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'dead_lettered', // Esauriti i retry: finito nella DLQ, visibile in UI.
  'canceled',
]);

export const jobEventLevelEnum = pgEnum('job_event_level', [
  'debug',
  'info',
  'warn',
  'error',
]);
