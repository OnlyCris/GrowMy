-- ============================================================================
-- Estensioni per l'ambiente di SVILUPPO — eseguito al primo avvio del container.
--
-- Sono le stesse di produzione, ma senza la creazione dei ruoli separati:
-- in locale si lavora con il superuser `postgres`, quindi RLS non entra in
-- gioco e non serve distinguere app_user da app_worker.
--
-- NOTA: `drizzle-kit push` non crea estensioni. Senza questo file, il push
-- fallirebbe sulle colonne `vector` con un errore poco chiaro
-- ("type vector does not exist") che manda fuori strada.
-- ============================================================================

-- gen_random_uuid() per le chiavi primarie.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Embedding e indici HNSW su keywords.embedding e articles.embedding,
-- usati per la deduplicazione semantica e il link interno automatico.
CREATE EXTENSION IF NOT EXISTS "vector";

-- Ricerca full-text tollerante ai refusi sui titoli degli articoli.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
