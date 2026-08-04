/**
 * Configurazione drizzle-kit.
 *
 * L'import di `load-env` deve stare PRIMA di tutto: drizzle-kit esegue questo
 * file come processo Node autonomo, senza il caricamento automatico dei file
 * .env che fa Next.js.
 */
import './src/load-env';

import { defineConfig } from 'drizzle-kit';

/**
 * `DATABASE_MIGRATION_URL` ha la precedenza: in produzione le migrazioni girano
 * con il ruolo `app_migrator`, che ha i privilegi DDL. `DATABASE_URL` (ruolo
 * `app_user`) non può alterare lo schema — è voluto.
 *
 * In sviluppo le due variabili coincidono e si usa il superuser locale.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!,
  },
  // Le estensioni sono create dagli script di init dei container, non da
  // drizzle-kit. Dichiararle qui evita che il push provi a rimuoverle.
  extensionsFilters: ['postgis'],
  // Log delle istruzioni generate: utile per accorgersi di una migrazione
  // distruttiva prima che update.sh la blocchi in produzione.
  verbose: true,
  // Chiede conferma per le operazioni che perdono dati.
  strict: true,
});
