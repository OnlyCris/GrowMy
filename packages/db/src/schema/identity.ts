import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, softDelete, timestamps } from './_shared';
import { invitationStatusEnum, orgRoleEnum } from './enums';

/**
 * IDENTITY & MULTI-TENANCY
 *
 * Modello: User --(membership)--> Organization --> Product
 * `organization_id` è la chiave di isolamento tenant di TUTTA la piattaforma.
 * Ogni tabella che contiene dati cliente la porta, direttamente o via join di primo
 * livello, e ogni policy RLS la usa come predicato.
 */

/**
 * Profilo applicativo dell'utente.
 * `id` è FK verso `auth.users.id` di Supabase: NON duplichiamo mai qui password,
 * hash, refresh token o provider identity — quelli restano nello schema `auth`,
 * inaccessibile dalla connessione applicativa.
 */
export const users = pgTable(
  'users',
  {
    // Nessun default: l'id arriva da auth.users, popolato da un trigger on-signup.
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    fullName: text('full_name'),
    avatarUrl: text('avatar_url'),
    /** Fuso orario IANA usato per schedulare le pubblicazioni. */
    timezone: text('timezone').notNull().default('UTC'),
    locale: text('locale').notNull().default('en'),
    /** Timestamp dell'ultimo accesso: usato per lifecycle email, non per sicurezza. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // L'email è unica case-insensitive: 'Mario@x.it' e 'mario@x.it' sono lo stesso utente.
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
  ],
);

/** Tenant. Ogni utente ne ha almeno una, creata automaticamente al primo signup. */
export const organizations = pgTable(
  'organizations',
  {
    id: primaryId(),
    name: text('name').notNull(),
    /** Slug pubblico usato negli URL (`/o/:slug/...`). Immutabile dopo la creazione. */
    slug: text('slug').notNull(),
    logoUrl: text('logo_url'),
    /** Denormalizzato per performance: evita un join su ogni check di ownership. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('organizations_slug_uq').on(t.slug),
    index('organizations_owner_idx').on(t.ownerId),
  ],
);

/**
 * Tabella di join utente<->organizzazione che porta il ruolo RBAC.
 * È la SOLA fonte di verità per l'autorizzazione: nessun ruolo viene letto da
 * JWT claims modificabili lato client o da cookie.
 */
export const organizationMembers = pgTable(
  'organization_members',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull().default('editor'),
    invitedBy: uuid('invited_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    // Un utente non può avere due ruoli nella stessa org.
    uniqueIndex('org_members_org_user_uq').on(t.organizationId, t.userId),
    // Query calda: "di quali org fa parte questo utente?" a ogni richiesta autenticata.
    index('org_members_user_idx').on(t.userId),
    index('org_members_org_role_idx').on(t.organizationId, t.role),
  ],
);

/**
 * Inviti via email. Il token è memorizzato solo come hash SHA-256: un dump del
 * database non permette di accettare inviti altrui.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: orgRoleEnum('role').notNull().default('editor'),
    /** SHA-256 del token inviato per email. Il token in chiaro non è mai persistito. */
    tokenHash: text('token_hash').notNull(),
    status: invitationStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('invitations_token_hash_uq').on(t.tokenHash),
    // Un solo invito pendente per (org, email): l'indice parziale lo garantisce a livello DB.
    uniqueIndex('invitations_org_email_pending_uq')
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.status} = 'pending'`),
    index('invitations_org_idx').on(t.organizationId),
  ],
);

/**
 * API key per l'accesso programmatico (parità con la REST API di Outrank).
 * Sicurezza:
 *  - `keyHash`: Argon2id del segreto completo. Il segreto in chiaro è mostrato UNA VOLTA.
 *  - `keyPrefix`: primi 12 caratteri, in chiaro, solo per permettere all'utente di
 *    riconoscere la chiave in lista. Non è sufficiente per autenticarsi.
 *  - `lookupHash`: SHA-256 non salato del segreto, indicizzato. Serve a trovare la riga
 *    in O(1) senza dover eseguire Argon2 su ogni chiave del database; la verifica
 *    effettiva avviene comunque con Argon2 su `keyHash`.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    lookupHash: text('lookup_hash').notNull(),
    /** Scope granulari (es. ['articles:read','products:write']). Default: nessuno. */
    scopes: jsonb('scopes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('api_keys_lookup_hash_uq').on(t.lookupHash),
    index('api_keys_org_idx').on(t.organizationId),
  ],
);

/**
 * Audit log append-only delle azioni sensibili (cambi di ruolo, revoca chiavi,
 * modifiche billing, connessione integrazioni, aggiustamenti crediti).
 * REGOLA: non contiene mai PII oltre all'id dell'attore e non contiene mai segreti.
 * Nessun UPDATE/DELETE è concesso su questa tabella (enforced da policy RLS).
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Popolato quando l'azione arriva dalla REST API invece che dalla UI. */
    actorApiKeyId: uuid('actor_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(), // es. 'member.role_changed'
    targetType: text('target_type').notNull(), // es. 'organization_member'
    targetId: text('target_id'),
    /** Solo metadati non sensibili: { from: 'editor', to: 'admin' }. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** IP troncato (/24 IPv4, /48 IPv6) per ridurre l'impronta PII. */
    ipPrefix: text('ip_prefix'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    index('audit_logs_target_idx').on(t.targetType, t.targetId),
  ],
);

/**
 * Flag di sistema per utente: usato per feature gating e onboarding.
 * Separato da `users` perché cambia con frequenza molto diversa.
 */
export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  emailOnArticleReady: boolean('email_on_article_ready').notNull().default(true),
  emailOnPublishFailed: boolean('email_on_publish_failed').notNull().default(true),
  emailWeeklyDigest: boolean('email_weekly_digest').notNull().default(true),
  onboardingCompletedAt: timestamp('onboarding_completed_at', {
    withTimezone: true,
  }),
  ...timestamps,
});
