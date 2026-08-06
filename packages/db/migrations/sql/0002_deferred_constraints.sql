-- ============================================================================
-- VINCOLI CIRCOLARI E INTEGRITÀ AVANZATA
-- ============================================================================
--
-- Tre foreign key non possono essere dichiarate inline nello schema Drizzle
-- perché creerebbero un ciclo di import fra i moduli TypeScript:
--
--   keyword_clusters.pillar_article_id  ->  articles.id
--   articles.current_version_id         ->  article_versions.id
--   articles.refresh_of_article_id      ->  articles.id   (auto-riferimento)
--
-- Sono dichiarate qui, dopo la creazione di tutte le tabelle. Sono TUTTE
-- `ON DELETE SET NULL`: la cancellazione di una versione o di un articolo
-- non deve mai cancellare a cascata il contenitore.
-- ============================================================================

ALTER TABLE keyword_clusters
  ADD CONSTRAINT keyword_clusters_pillar_article_fk
  FOREIGN KEY (pillar_article_id) REFERENCES articles(id) ON DELETE SET NULL;

ALTER TABLE articles
  ADD CONSTRAINT articles_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES article_versions(id) ON DELETE SET NULL;

ALTER TABLE articles
  ADD CONSTRAINT articles_refresh_of_fk
  FOREIGN KEY (refresh_of_article_id) REFERENCES articles(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- CHECK CONSTRAINT: invarianti di dominio applicate dal database.
-- Lo strato Zod li valida prima, ma questi sono la rete di sicurezza: nessun
-- percorso di scrittura (worker, migrazione, script manuale) può violarli.
-- ---------------------------------------------------------------------------

ALTER TABLE products
  ADD CONSTRAINT products_publish_hour_range
  CHECK (publish_hour BETWEEN 0 AND 23);

ALTER TABLE products
  ADD CONSTRAINT products_word_count_order
  CHECK (target_word_count_min > 0
         AND target_word_count_max >= target_word_count_min);

ALTER TABLE products
  ADD CONSTRAINT products_approval_timeout_positive
  CHECK (approval_timeout_hours IS NULL OR approval_timeout_hours > 0);

ALTER TABLE keywords
  ADD CONSTRAINT keywords_priority_range
  CHECK (priority_score >= 0 AND priority_score <= 100);

ALTER TABLE keywords
  ADD CONSTRAINT keywords_difficulty_range
  CHECK (difficulty IS NULL OR (difficulty >= 0 AND difficulty <= 100));

ALTER TABLE keywords
  ADD CONSTRAINT keywords_term_not_blank
  CHECK (length(btrim(term)) > 0);

-- Un articolo pubblicato deve avere URL e timestamp: impedisce stati incoerenti
-- se un processor dimentica di popolare i campi.
ALTER TABLE articles
  ADD CONSTRAINT articles_published_requires_url
  CHECK (status <> 'published' OR (published_url IS NOT NULL AND published_at IS NOT NULL));

-- Un articolo non può essere il refresh di sé stesso.
ALTER TABLE articles
  ADD CONSTRAINT articles_refresh_not_self
  CHECK (refresh_of_article_id IS NULL OR refresh_of_article_id <> id);

ALTER TABLE article_versions
  ADD CONSTRAINT article_versions_number_positive
  CHECK (version_number > 0);

ALTER TABLE internal_links
  ADD CONSTRAINT internal_links_no_self_reference
  CHECK (source_article_id <> target_article_id);

-- Coerenza del ledger: il segno dell'importo deve corrispondere al tipo di
-- transazione. È l'invariante che protegge la fatturazione da bug applicativi.
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_amount_sign
  CHECK (
    (type IN ('grant_subscription','grant_topup','grant_promo','release') AND amount > 0)
    OR (type IN ('reserve','expire') AND amount < 0)
    OR (type = 'consume' AND amount = 0)
    OR (type = 'adjustment')
  );

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_seats_positive
  CHECK (seats > 0 AND articles_per_cycle > 0);

ALTER TABLE jobs
  ADD CONSTRAINT jobs_attempts_within_max
  CHECK (attempts >= 0 AND attempts <= max_attempts);

-- ---------------------------------------------------------------------------
-- Trigger: manutenzione automatica di updated_at.
-- Farlo nel database invece che nell'applicazione garantisce che il campo sia
-- corretto anche per le scritture del worker e degli script di manutenzione.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','organizations','organization_members','invitations','api_keys',
    'user_preferences','products','product_brand_profiles','integrations',
    'keyword_clusters','keywords','articles','media_assets',
    'gsc_connections','cannibalization_issues','subscriptions','usage_counters','jobs'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %1$s_touch_updated_at
         BEFORE UPDATE ON %1$I
         FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at();', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- NIENTE trigger `ON auth.users` qui.
--
-- La versione precedente di questo file ne dichiarava uno per creare la riga
-- `public.users` (+ `user_preferences`) a ogni signup Supabase. Impossibile in
-- questo deploy: `auth.users` vive nel progetto Supabase Cloud che gestisce
-- l'autenticazione, `public.*` vive in un Postgres self-hosted separato sulla
-- stessa rete Docker del worker — due server fisici distinti. Un trigger non
-- può scavalcare quel confine indipendentemente da come lo si scrive.
--
-- Il rimpiazzo è applicativo: `ensureUserProvisioned()`
-- (`apps/web/src/lib/auth/provision-user.ts`) fa lo stesso upsert, dentro
-- `withUserContext`, chiamato dopo ogni exchange OAuth riuscito
-- (`auth/callback/route.ts`) e all'ingresso di `/onboarding` — quest'ultimo è
-- il percorso che conta davvero, perché un login email/password senza conferma
-- via link non passa mai dal callback. La policy `users_insert_self` in
-- `0001_rls_policies.sql` è ciò che permette a quell'insert di avere successo
-- sotto RLS.
-- ---------------------------------------------------------------------------
-- Protezione: un'organizzazione deve sempre avere almeno un owner.
-- Impedisce il lockout permanente causato da un declassamento accidentale.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_assert_org_has_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_count integer;
  target_org uuid;
BEGIN
  target_org := COALESCE(OLD.organization_id, NEW.organization_id);

  SELECT count(*) INTO owner_count
  FROM organization_members
  WHERE organization_id = target_org AND role = 'owner';

  IF owner_count = 0 THEN
    RAISE EXCEPTION 'ORG_MUST_HAVE_OWNER'
      USING HINT = 'Assegna il ruolo owner a un altro membro prima di procedere.';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER organization_members_owner_guard
  AFTER UPDATE OR DELETE ON organization_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_assert_org_has_owner();
