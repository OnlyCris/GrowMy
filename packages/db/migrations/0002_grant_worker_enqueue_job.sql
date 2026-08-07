-- app_enqueue_job() (0003_enqueue_job.sql) era GRANTata solo ad app_user (web).
-- Il worker chiama la STESSA funzione per accodare il passo successivo della
-- pipeline (research -> generate -> publish, e ora anche integration_connect
-- -> integration_health_check) con la propria connessione, ruolo app_worker.
-- Mai notato prima d'ora: nessun articolo aveva mai completato la ricerca in
-- produzione fino a questa sessione, quindi questo GRANT mancante non era
-- mai stato esercitato — "permission denied for function app_enqueue_job".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    GRANT EXECUTE ON FUNCTION app_enqueue_job(
      uuid, uuid, uuid, job_type, text, uuid, jsonb, text, boolean, text
    ) TO app_worker;
  END IF;
END
$$;
