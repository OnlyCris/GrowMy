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
 *   pnpm db:sql              applica tutti i file (default)
 *   pnpm db:sql --all        alias esplicito dello stesso comportamento — mantenuto
 *                            per compatibilità con script di deploy esistenti
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
 * File applicati per default.
 *
 * `0001_rls_policies` e `0002_deferred_constraints` erano esclusi in origine:
 * dipendevano da `auth.uid()` e da un trigger `ON auth.users`, cioè dallo
 * schema `auth` di Supabase — assente in sviluppo locale. Da quando 0001 usa
 * `app_current_user_id()` (variabile di sessione, non più `auth.uid()`) e 0002
 * non crea più quel trigger, nessuno dei due tocca più nulla di specifico di
 * Supabase: richiedono solo che i ruoli app_user/app_worker/app_migrator
 * esistano già (creati da `docker/postgres/init/01-roles.sql` al primo avvio
 * del container, o a mano in un Postgres locale non containerizzato).
 */
const IDEMPOTENT_FILES = [
  '0001_rls_policies.sql',
  '0002_deferred_constraints.sql',
  '0003_enqueue_job.sql',
];

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

  // Verifica che le funzioni critiche esistano davvero, e che RLS abbia almeno
  // una policy attiva: senza, l'app risponderebbe con zero righe ovunque (RLS
  // forzato + nessuna policy = deny-all) senza un errore che lo spieghi.
  const { rows: functionRows } = await pool.query(
    `SELECT proname FROM pg_proc WHERE proname IN ('app_enqueue_job', 'app_current_user_id')`,
  );
  const { rows: policyRows } = await pool.query(
    `SELECT 1 FROM pg_policies WHERE schemaname = 'public' LIMIT 1`,
  );

  await pool.end();

  const foundFunctions = new Set(functionRows.map((r) => r.proname as string));
  const missing: string[] = [];
  if (!foundFunctions.has('app_enqueue_job')) missing.push('app_enqueue_job()');
  if (!foundFunctions.has('app_current_user_id')) missing.push('app_current_user_id()');
  if (policyRows.length === 0) missing.push('almeno una policy RLS su public.*');

  if (missing.length > 0) {
    console.error(
      `\n  Mancante dopo l'applicazione: ${missing.join(', ')}. Verifica gli errori sopra.`,
    );
    process.exit(1);
  }

  console.log(`\n✓ ${selected.length} file SQL applicati, RLS e funzioni critiche presenti.`);
}

main().catch((error) => {
  console.error('Applicazione SQL fallita:', error);
  process.exit(1);
});
