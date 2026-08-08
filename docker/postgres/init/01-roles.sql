-- ============================================================================
-- Creazione dei ruoli applicativi — eseguito UNA SOLA VOLTA al primo avvio.
--
-- Tre ruoli con privilegi deliberatamente diversi. La separazione è a livello
-- di credenziali di connessione, non di convenzione applicativa: non è
-- aggirabile per distrazione.
--
--   app_user     -> app Next.js.       RLS ATTIVO E FORZATO.
--   app_worker   -> worker BullMQ.     BYPASSRLS (nessuna sessione utente).
--   app_migrator -> drizzle-kit.       Solo DDL, usato solo in deploy.
--
-- Le password arrivano dalle variabili d'ambiente passate dal compose.
-- ============================================================================

\set app_user_password `echo "$POSTGRES_PASSWORD"`
\set app_worker_password `echo "${POSTGRES_WORKER_PASSWORD:-$POSTGRES_PASSWORD}"`
\set app_migrator_password `echo "${POSTGRES_MIGRATOR_PASSWORD:-$POSTGRES_PASSWORD}"`

-- ---------------------------------------------------------------------------
-- Estensioni
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ---------------------------------------------------------------------------
-- app_user — la connessione dell'applicazione web
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN;
  END IF;
END
$$;

ALTER ROLE app_user WITH PASSWORD :'app_user_password';

-- Nessun privilegio di creazione: l'app non deve poter alterare lo schema.
ALTER ROLE app_user NOCREATEDB NOCREATEROLE NOSUPERUSER NOBYPASSRLS;

GRANT CONNECT ON DATABASE growmy TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- ---------------------------------------------------------------------------
-- app_worker — la connessione dei processi in background
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker LOGIN;
  END IF;
END
$$;

ALTER ROLE app_worker WITH PASSWORD :'app_worker_password';

/*
 * BYPASSRLS è concesso deliberatamente: il worker opera fuori dal contesto di
 * una sessione utente (`auth.uid()` è NULL), quindi le policy RLS lo
 * bloccherebbero su tutto. Lo scope gli arriva dal payload del job.
 *
 * Il rischio è accettabile perché questo ruolo non è mai usato da codice che
 * risponde direttamente a una richiesta del browser: non esiste un percorso in
 * cui un input utente scelga cosa il worker legge.
 */
ALTER ROLE app_worker NOCREATEDB NOCREATEROLE NOSUPERUSER BYPASSRLS;

GRANT CONNECT ON DATABASE growmy TO app_worker;
GRANT USAGE ON SCHEMA public TO app_worker;

-- ---------------------------------------------------------------------------
-- app_migrator — solo per il deploy
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator LOGIN;
  END IF;
END
$$;

ALTER ROLE app_migrator WITH PASSWORD :'app_migrator_password';
ALTER ROLE app_migrator NOCREATEDB NOCREATEROLE NOSUPERUSER BYPASSRLS;

GRANT CONNECT ON DATABASE growmy TO app_migrator;
GRANT ALL ON SCHEMA public TO app_migrator;

-- CREATE sul DATABASE, non solo sullo schema `public`: `drizzle-kit migrate`
-- tiene lo storico in `drizzle.__drizzle_migrations` e alla prima esecuzione
-- deve poter fare `CREATE SCHEMA drizzle`, che richiede questo privilegio a
-- livello di database. Senza, l'unico messaggio è
-- `permission denied for database growmy` — che manda a cercare il problema
-- nella connessione invece che in una GRANT mancante.
GRANT CREATE ON DATABASE growmy TO app_migrator;

-- ---------------------------------------------------------------------------
-- Privilegi di default sugli oggetti FUTURI
--
-- Senza questo, ogni nuova tabella creata da una migrazione sarebbe invisibile
-- ad app_user finché qualcuno non esegue una GRANT a mano — cioè fino al primo
-- errore in produzione.
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_worker;

-- Nessun privilegio per il pubblico: revoca esplicita, non assunta.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE growmy FROM PUBLIC;
