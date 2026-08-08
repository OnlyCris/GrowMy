import { defineConfig } from 'drizzle-kit';

/**
 * Configurazione drizzle-kit per le MIGRAZIONI IN PRODUZIONE.
 *
 * Esiste separata da `drizzle.config.ts` per un motivo trovato nel modo peggiore:
 * quel file, alla prima riga, fa `import './src/load-env'` — e l'immagine
 * `runner` di `Dockerfile.web` copia `drizzle.config.ts` e `migrations/` ma NON
 * `packages/db/src/`, perché il build standalone di Next non include i sorgenti.
 * Il passo di migrazione di `update.sh` falliva quindi con
 * `Cannot find module './src/load-env'`, l'ERR trap faceva scattare il rollback,
 * e il deploy tornava indietro senza che nulla dello schema fosse cambiato.
 *
 * PERCHÉ NON COPIARE `src/` NELL'IMMAGINE. Sarebbe stato possibile (148 KB) ma
 * avrebbe solo spostato il problema: `load-env.ts` importa a sua volta
 * `@growmy/env/load`, che nel runtime standalone potrebbe non risolversi, e in
 * ogni caso caricherebbe file `.env` che in produzione non esistono — il
 * container riceve le variabili da `docker compose run -e`, non da un file.
 *
 * COSA SERVE DAVVERO A `drizzle-kit migrate`: la cartella `out` con lo storico
 * SQL e il journal, più le credenziali. Nient'altro. Niente `schema`, che serve
 * solo a `generate` e `push` — comandi che in produzione non giriamo mai:
 * le migrazioni si generano in sviluppo e si versionano.
 *
 * `drizzle.config.ts` resta il file per lo sviluppo, dove il caricamento dei
 * `.env` è invece indispensabile.
 *
 * NEL CONTAINER QUESTO FILE SI CHIAMA `drizzle.config.ts`: `Dockerfile.web` lo
 * copia rinominandolo. Sembra un dettaglio ed è invece la parte che fa
 * funzionare il fix al primo deploy anziché al secondo — `update.sh` si
 * riscrive da solo con `git checkout` mentre bash lo esegue, e bash continua a
 * leggere dal descrittore aperto sul file vecchio. Se il fix avesse richiesto
 * anche un nuovo percorso nel comando di migrazione, quel percorso sarebbe
 * arrivato un deploy in ritardo rispetto all'immagine che lo contiene, e il
 * deploy sarebbe fallito comunque. Mantenendo il nome invariato, il comando
 * vecchio e quello nuovo puntano entrambi al file giusto.
 */
export default defineConfig({
  out: './migrations',
  dialect: 'postgresql',
  /**
   * `DATABASE_MIGRATION_URL` ha la precedenza: in produzione le migrazioni
   * girano con il ruolo `app_migrator`, l'unico con privilegi DDL. `app_user`
   * non può alterare lo schema, ed è voluto.
   */
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!,
  },
});
