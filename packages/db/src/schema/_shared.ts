import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Colonne comuni riutilizzate da quasi tutte le tabelle.
 * Centralizzarle evita drift fra tabelle e rende le migrazioni prevedibili.
 */

/** Chiave primaria UUID v4 generata dal database (mai dal client). */
export const primaryId = () =>
  uuid('id').primaryKey().default(sql`gen_random_uuid()`);

/**
 * Timestamp standard.
 * `withTimezone: true` è obbligatorio: la piattaforma schedula contenuti per fusi
 * orari diversi e un `timestamp without time zone` produrrebbe pubblicazioni sfasate.
 */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
};

/**
 * Soft delete. Non usiamo mai DELETE fisico su entità che l'utente potrebbe voler
 * recuperare, e mai su entità referenziate da un ledger di fatturazione.
 * Tutte le query applicative filtrano `isNull(table.deletedAt)` tramite gli helper
 * in `packages/db/src/queries`.
 */
export const softDelete = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};
