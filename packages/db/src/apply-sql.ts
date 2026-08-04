/**
 * APPLICAZIONE DEI FILE SQL SCRITTI A MANO
 *
 * `drizzle-kit push` e `drizzle-kit migrate` gestiscono tabelle, colonne e
 * indici — tutto ciò che è descrivibile nello schema TypeScript. Non gestiscono
 * funzioni, trigger e policy RLS, che stanno in `migrations/sql/*.sql`.
 *
 * Il bug che questo script previene: lo schema si crea correttamente,
 * l'applicazione parte, e la prima approvazione fallisce con un generico
 * "Qualcosa è andato storto" perché `app_enqueue_job()` non esiste. Nulla nel
 * processo di setup lo segnalava.
 *
 *   pnpm db:sql              applica i file idempotenti (default)
 *   pnpm db:sql --all        applica anche RLS e vincoli (richiede i ruoli)
 *
 * I file sono applicati in ordine alfabetico, ciascuno in una transazione:
 * se uno fallisce a metà non lascia il database in uno stato intermedio.
 */
import './load-env';

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

/**
 * File applicabili ovunque, senza prerequisiti.
 * `0001_rls_policies` e `0002_deferred_constraints` sono esclusi dal default:
 * il primo richiede i ruoli app_user/app_worker e lo schema `auth` di Supabase,
 * il secondo crea un trigger su `auth.users`. In sviluppo locale nessuno dei
 * due esiste, e applicarli produrrebbe errori che non indicano un problema reale.
 */
const IDEMPOTENT_FILES = ['0003_enqueue_job.sql'];

const sqlDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations/sql',
);

const applyAll = process.argv.includes('--all');

async function main() {
  const available = readdirSync(sqlDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const selected = applyAll
    ? available
    : available.filter((name) => IDEMPOTENT_FILES.includes(name));

  if (selected.length === 0) {
    console.log('Nessun file SQL da applicare.');
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  for (const filename of selected) {
    const sql = readFileSync(join(sqlDir, filename), 'utf8');
    const client = await pool.connect();

    try {
      // Una transazione per file: un fallimento non lascia metà definizioni.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`  ✓ ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ ${filename}\n    ${message}`);
      client.release();
      await pool.end();
      process.exit(1);
    } finally {
      client.release();
    }
  }

  // Verifica che la funzione critica esista davvero: senza, l'intero flusso di
  // approvazione fallirebbe a runtime con un errore generico.
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_proc WHERE proname = 'app_enqueue_job'`,
  );

  await pool.end();

  if (rows.length === 0) {
    console.error('\n  app_enqueue_job() non risulta creata. Verifica gli errori sopra.');
    process.exit(1);
  }

  console.log(`\n✓ ${selected.length} file SQL applicati, app_enqueue_job() presente.`);
}

main().catch((error) => {
  console.error('Applicazione SQL fallita:', error);
  process.exit(1);
});
