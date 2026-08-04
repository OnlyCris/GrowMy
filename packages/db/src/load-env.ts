/**
 * Caricamento delle variabili per gli script del database.
 *
 * `drizzle-kit` e lo script di seed girano come processi Node autonomi: senza
 * questo import non vedrebbero i file `.env` della root e fallirebbero con un
 * errore di connessione di `pg`, che manda a cercare il problema nel database
 * invece che nel file mancante.
 *
 * La logica di caricamento è condivisa con l'app web (`@growmy/env/load`):
 * un solo posto che sa dove stanno i file di ambiente.
 */
import '@growmy/env/load';

if (!process.env.DATABASE_URL) {
  console.error(
    '\n  DATABASE_URL non è definita.\n\n' +
      '  Per lo sviluppo locale, dalla root del progetto:\n' +
      '    cp .env.local.example .env.local\n',
  );
  process.exit(1);
}
