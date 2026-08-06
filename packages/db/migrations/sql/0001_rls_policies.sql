-- ============================================================================
-- ROW LEVEL SECURITY — isolamento tenant a livello di database
-- ============================================================================
--
-- Modello di difesa in profondità a due strati:
--
--   Strato 1 (applicativo): ogni query passa da `packages/db/src/queries/*`, che
--                           inietta sempre il filtro su organization_id ricavato
--                           dalla sessione verificata lato server.
--   Strato 2 (database):    queste policy. Se lo strato 1 ha un bug, il database
--                           restituisce comunque zero righe invece dei dati altrui.
--
-- CONNESSIONI:
--   - `app_user`   : usata dall'app Next.js. RLS ATTIVO. È il default.
--   - `app_worker` : usata dai worker BullMQ. Ha BYPASSRLS perché opera fuori dal
--                    contesto di una sessione utente, ma riceve sempre gli id di
--                    scope dal payload del job e non espone mai dati a un client.
--   - `app_migrator`: usata solo da drizzle-kit in fase di deploy.
--
-- PERCHÉ NON `auth.uid()`
--
-- La versione precedente di questo file leggeva l'utente da `auth.uid()`, la
-- funzione che Supabase Postgres espone a partire dai claim del JWT verificato.
-- In questo deploy l'autenticazione (Supabase Auth, `auth.users`) vive in un
-- progetto Supabase Cloud separato, mentre lo schema applicativo (`public.*`,
-- comprese queste tabelle) vive in un Postgres self-hosted sulla stessa rete
-- Docker del worker. Sono due server fisici distinti: `auth.uid()` non esiste
-- affatto qui, non è un problema di permessi.
--
-- L'identità arriva invece da `app_current_user_id()`, che legge una variabile
-- di sessione (`app.current_user_id`) impostata UNA VOLTA per transazione da
-- `withUserContext()` (`packages/db/src/context.ts`) con `set_config(...)`, mai
-- da testo SQL costruito a mano. Il valore che ci finisce è sempre l'id
-- verificato da `supabase.auth.getUser()` lato server — mai un input del client.
-- È lo stesso principio già applicato in `0003_enqueue_job.sql` (che passa l'id
-- come parametro di funzione invece che leggerlo da `auth.uid()`), esteso qui
-- alle policy, che non possono ricevere parametri dalla query che le innesca.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Estensioni richieste
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "vector";    -- embedding + indici HNSW

-- ---------------------------------------------------------------------------
-- Funzioni helper
-- ---------------------------------------------------------------------------

-- Identità dell'utente corrente per QUESTA transazione. `NULLIF(..., '')`
-- fa sì che una variabile mai impostata (fuori da `withUserContext`) risulti
-- NULL invece di far fallire il cast — ogni policy valuta semplicemente falso,
-- cioè fallisce chiuso.
CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

-- Elenco delle organizzazioni a cui l'utente corrente appartiene.
-- STABLE + SECURITY DEFINER: valutata una sola volta per statement e capace di
-- leggere organization_members senza innescare ricorsione infinita nelle policy.
CREATE OR REPLACE FUNCTION app_current_org_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT om.organization_id
  FROM organization_members om
  WHERE om.user_id = app_current_user_id();
$$;

-- Vero se l'utente corrente ha nell'organizzazione un ruolo fra quelli richiesti.
CREATE OR REPLACE FUNCTION app_has_org_role(target_org uuid, allowed_roles org_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_members om
    WHERE om.user_id = app_current_user_id()
      AND om.organization_id = target_org
      AND om.role = ANY(allowed_roles)
  );
$$;

-- Risolve l'organizzazione proprietaria di un prodotto (usata dalle tabelle che
-- non portano organization_id direttamente).
CREATE OR REPLACE FUNCTION app_org_of_product(target_product uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.organization_id FROM products p WHERE p.id = target_product;
$$;

-- Usata SOLO da `org_members_insert_bootstrap_owner` più sotto, per lo
-- stesso motivo per cui `app_current_org_ids()` è SECURITY DEFINER: una
-- policy su `organization_members` che facesse
-- `SELECT ... FROM organization_members` direttamente, senza passare da una
-- funzione SECURITY DEFINER, fa scattare "infinite recursion detected in
-- policy for relation organization_members" — Postgres deve ri-applicare le
-- policy della tabella per valutare la sub-query, compresa quella che sta
-- ancora valutando. SECURITY DEFINER rompe il ciclo: la funzione gira con i
-- privilegi del proprietario (bypassa RLS), non con quelli di chi chiama.
CREATE OR REPLACE FUNCTION app_org_has_any_member(target_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM organization_members WHERE organization_id = target_org);
$$;

REVOKE EXECUTE ON FUNCTION app_current_user_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_current_org_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_has_org_role(uuid, org_role[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_org_of_product(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app_org_has_any_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO app_user;
GRANT EXECUTE ON FUNCTION app_current_org_ids() TO app_user;
GRANT EXECUTE ON FUNCTION app_has_org_role(uuid, org_role[]) TO app_user;
GRANT EXECUTE ON FUNCTION app_org_of_product(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app_org_has_any_member(uuid) TO app_user;

-- ---------------------------------------------------------------------------
-- Abilitazione RLS su TUTTE le tabelle applicative
-- FORCE: la policy vale anche per il proprietario della tabella.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','organizations','organization_members','invitations','api_keys',
    'audit_logs','user_preferences',
    'products','product_brand_profiles','integrations','integration_health_checks',
    'keyword_clusters','keywords','articles','article_versions',
    'article_publications','media_assets','internal_links',
    'gsc_connections','gsc_daily_metrics','cannibalization_issues','planner_decisions',
    'subscriptions','credit_ledger','stripe_events','usage_counters',
    'jobs','job_events','webhook_deliveries','rate_limit_violations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- USERS — ognuno vede solo sé stesso e i colleghi di organizzazione
-- ---------------------------------------------------------------------------
CREATE POLICY users_select ON users FOR SELECT TO app_user
USING (
  id = app_current_user_id()
  OR EXISTS (
    SELECT 1 FROM organization_members om
    WHERE om.user_id = users.id
      AND om.organization_id IN (SELECT app_current_org_ids())
  )
);

-- L'utente può aggiornare solo il proprio profilo.
CREATE POLICY users_update_self ON users FOR UPDATE TO app_user
USING (id = app_current_user_id())
WITH CHECK (id = app_current_user_id());

-- Provisioning al primo accesso: nessun trigger su `auth.users` può crearla per
-- noi (vive in un altro database), quindi l'applicazione la inserisce da sé al
-- primo login (`ensureUserProvisioned`, dentro `withUserContext`). L'unica riga
-- che questa policy permette di creare è la PROPRIA: `id` è sempre l'id
-- verificato server-side che ha aperto la transazione, mai un valore scelto dal
-- client.
CREATE POLICY users_insert_self ON users FOR INSERT TO app_user
WITH CHECK (id = app_current_user_id());

-- ---------------------------------------------------------------------------
-- ORGANIZATIONS
-- ---------------------------------------------------------------------------
-- `OR owner_id = app_current_user_id()`: non è ridondante con la membership.
-- Nella finestra fra l'INSERT di una nuova organizzazione e l'INSERT della
-- sua riga di membership owner (stessa transazione, vedi
-- `org_members_insert_bootstrap_owner` più sotto), l'organizzazione non è
-- ancora visibile via `app_current_org_ids()`. Senza questa clausola,
-- `INSERT ... RETURNING` sull'organizzazione fallirebbe con "new row
-- violates row-level security policy": Postgres filtra l'output di
-- RETURNING con le policy di SELECT, non solo con il WITH CHECK
-- dell'INSERT. Riscontrato in produzione al primo onboarding reale.
CREATE POLICY organizations_select ON organizations FOR SELECT TO app_user
USING (
  id IN (SELECT app_current_org_ids())
  OR owner_id = app_current_user_id()
);

CREATE POLICY organizations_update ON organizations FOR UPDATE TO app_user
USING (app_has_org_role(id, ARRAY['owner','admin']::org_role[]))
WITH CHECK (app_has_org_role(id, ARRAY['owner','admin']::org_role[]));

-- Solo l'owner può eliminare (soft-delete via UPDATE resta comunque preferito).
CREATE POLICY organizations_delete ON organizations FOR DELETE TO app_user
USING (app_has_org_role(id, ARRAY['owner']::org_role[]));

-- Chiunque può creare una nuova organizzazione, ma solo dichiarandosi
-- immediatamente proprietario di sé stesso — mai di un altro utente. Nessun
-- tetto al numero di organizzazioni per utente: non è compito di RLS, è compito
-- del rate limiting applicativo (`onboarding.create-organization`).
CREATE POLICY organizations_insert_self_owner ON organizations FOR INSERT TO app_user
WITH CHECK (owner_id = app_current_user_id());

-- `organizations_update` (sopra) consente a owner/admin di aggiornare la riga,
-- ma RLS è per riga, non per colonna: senza questo, un ADMIN potrebbe riassegnare
-- `owner_id` con una UPDATE qualsiasi. Il trasferimento di proprietà è un'azione
-- distinta e sensibile che merita un flusso dedicato e auditato (sul modello di
-- `app_enqueue_job`, non costruito in questo passo) — per ora la colonna è
-- semplicemente non scrivibile dall'applicazione. `slug` è immutabile per
-- decisione di prodotto (vedi commento su `organizations.slug` in identity.ts).
REVOKE UPDATE ON organizations FROM app_user;
GRANT UPDATE (name, logo_url, deleted_at) ON organizations TO app_user;

-- ---------------------------------------------------------------------------
-- ORGANIZATION MEMBERS — gestione membri riservata a owner/admin
-- ---------------------------------------------------------------------------
CREATE POLICY org_members_select ON organization_members FOR SELECT TO app_user
USING (organization_id IN (SELECT app_current_org_ids()));

CREATE POLICY org_members_write ON organization_members FOR ALL TO app_user
USING (app_has_org_role(organization_id, ARRAY['owner','admin']::org_role[]))
WITH CHECK (app_has_org_role(organization_id, ARRAY['owner','admin']::org_role[]));

-- BOOTSTRAP: la riga di membership dell'owner, alla creazione di una nuova
-- organizzazione, è l'unico caso in cui `org_members_write` non basta — richiede
-- di essere GIÀ owner/admin di quell'organizzazione, il che è circolare per la
-- primissima riga. Questa policy apre un varco stretto e non aggirabile:
--
--   - `user_id = app_current_user_id()`: puoi inserire solo TE STESSO, mai un
--     altro utente.
--   - `role = 'owner'`: nessun altro ruolo soddisfa questa policy — non è un
--     modo per auto-promuoversi con un ruolo diverso.
--   - `o.owner_id = app_current_user_id()`: l'organizzazione bersaglio deve
--     essere una che possiedi già (creata un istante prima nella stessa
--     transazione da `organizations_insert_self_owner`) — non un'organizzazione
--     esistente di qualcun altro.
--   - `NOT app_org_has_any_member(...)`: vale solo se l'organizzazione non ha
--     ancora NESSUN membro. Race-safe: creazione dell'org e inserimento di
--     questa riga avvengono nella stessa transazione applicativa
--     (`createOrganizationAction`), quindi nessun'altra sessione può mai
--     osservare l'organizzazione prima che la sua membership owner sia già
--     committata insieme.
--
-- `app_org_has_any_member()` invece di una `NOT EXISTS` diretta su
-- `organization_members`: una policy che interroga direttamente la propria
-- tabella fa fallire Postgres con "infinite recursion detected in policy
-- for relation organization_members" — deve ri-applicare le policy della
-- tabella per valutare la sub-query, compresa quella ancora in corso di
-- valutazione. Riscontrato in produzione al primo onboarding reale.
CREATE POLICY org_members_insert_bootstrap_owner ON organization_members
FOR INSERT TO app_user
WITH CHECK (
  user_id = app_current_user_id()
  AND role = 'owner'
  AND EXISTS (
    SELECT 1 FROM organizations o
    WHERE o.id = organization_members.organization_id
      AND o.owner_id = app_current_user_id()
  )
  AND NOT app_org_has_any_member(organization_members.organization_id)
);

-- ---------------------------------------------------------------------------
-- INVITATIONS / API KEYS — owner e admin
-- Nota: `key_hash` e `lookup_hash` non sono mai selezionati dall'applicazione;
-- la GRANT a livello di colonna lo impedisce anche in caso di `select *`.
-- ---------------------------------------------------------------------------
CREATE POLICY invitations_all ON invitations FOR ALL TO app_user
USING (app_has_org_role(organization_id, ARRAY['owner','admin']::org_role[]))
WITH CHECK (app_has_org_role(organization_id, ARRAY['owner','admin']::org_role[]));

CREATE POLICY api_keys_all ON api_keys FOR ALL TO app_user
USING (app_has_org_role(organization_id, ARRAY['owner','admin']::org_role[]))
WITH CHECK (app_has_org_role(organization_id, ARRAY['owner','admin']::org_role[]));

REVOKE ALL ON api_keys FROM app_user;
GRANT SELECT (id, organization_id, name, key_prefix, scopes, last_used_at,
              expires_at, revoked_at, created_by, created_at, updated_at)
  ON api_keys TO app_user;
GRANT INSERT, UPDATE, DELETE ON api_keys TO app_user;

-- ---------------------------------------------------------------------------
-- AUDIT LOGS — append-only. Nessun UPDATE, nessun DELETE, per nessuno.
-- ---------------------------------------------------------------------------
CREATE POLICY audit_logs_select ON audit_logs FOR SELECT TO app_user
USING (app_has_org_role(organization_id, ARRAY['owner','admin']::org_role[]));

CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT TO app_user
WITH CHECK (organization_id IN (SELECT app_current_org_ids()));
-- Volutamente assenti: policy UPDATE e DELETE.

-- ---------------------------------------------------------------------------
-- USER PREFERENCES
-- ---------------------------------------------------------------------------
CREATE POLICY user_preferences_all ON user_preferences FOR ALL TO app_user
USING (user_id = app_current_user_id())
WITH CHECK (user_id = app_current_user_id());

-- ---------------------------------------------------------------------------
-- PRODUCTS e tabelle figlie con organization_id diretto
-- Lettura: qualsiasi membro. Scrittura: owner/admin/editor (non viewer).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'products','integrations','keyword_clusters','keywords','articles',
    'media_assets','gsc_connections','planner_decisions'
  ]
  LOOP
    EXECUTE format($f$
      CREATE POLICY %1$s_select ON %1$I FOR SELECT TO app_user
      USING (organization_id IN (SELECT app_current_org_ids()));
    $f$, t);

    EXECUTE format($f$
      CREATE POLICY %1$s_write ON %1$I FOR ALL TO app_user
      USING (app_has_org_role(organization_id,
             ARRAY['owner','admin','editor']::org_role[]))
      WITH CHECK (app_has_org_role(organization_id,
             ARRAY['owner','admin','editor']::org_role[]));
    $f$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- INTEGRATIONS — le colonne con credenziali cifrate non sono leggibili
-- nemmeno dalla connessione applicativa: solo il worker le decifra.
-- ---------------------------------------------------------------------------
REVOKE ALL ON integrations FROM app_user;
GRANT SELECT (id, organization_id, product_id, provider, status, label, config,
              publish_as_draft, is_primary, last_health_check_at,
              last_health_check_result, last_error_message, consecutive_failures,
              token_expires_at, connected_by, created_at, updated_at, deleted_at)
  ON integrations TO app_user;
GRANT INSERT, UPDATE, DELETE ON integrations TO app_user;

REVOKE ALL ON gsc_connections FROM app_user;
GRANT SELECT (id, organization_id, product_id, site_url, connected_email,
              last_synced_at, last_synced_date, last_sync_error, is_active,
              connected_by, created_at, updated_at)
  ON gsc_connections TO app_user;
GRANT INSERT, UPDATE, DELETE ON gsc_connections TO app_user;

-- ---------------------------------------------------------------------------
-- Tabelle figlie SENZA organization_id: derivano lo scope dal padre.
-- ---------------------------------------------------------------------------

CREATE POLICY product_brand_profiles_all ON product_brand_profiles FOR ALL TO app_user
USING (app_org_of_product(product_id) IN (SELECT app_current_org_ids()))
WITH CHECK (app_has_org_role(app_org_of_product(product_id),
            ARRAY['owner','admin','editor']::org_role[]));

CREATE POLICY integration_health_checks_select ON integration_health_checks
FOR SELECT TO app_user
USING (EXISTS (
  SELECT 1 FROM integrations i
  WHERE i.id = integration_health_checks.integration_id
    AND i.organization_id IN (SELECT app_current_org_ids())
));

CREATE POLICY article_versions_select ON article_versions FOR SELECT TO app_user
USING (EXISTS (
  SELECT 1 FROM articles a
  WHERE a.id = article_versions.article_id
    AND a.organization_id IN (SELECT app_current_org_ids())
));

CREATE POLICY article_versions_insert ON article_versions FOR INSERT TO app_user
WITH CHECK (EXISTS (
  SELECT 1 FROM articles a
  WHERE a.id = article_versions.article_id
    AND app_has_org_role(a.organization_id,
        ARRAY['owner','admin','editor']::org_role[])
));
-- Append-only: nessuna policy UPDATE/DELETE. Le versioni non si riscrivono.

CREATE POLICY article_publications_select ON article_publications FOR SELECT TO app_user
USING (EXISTS (
  SELECT 1 FROM articles a
  WHERE a.id = article_publications.article_id
    AND a.organization_id IN (SELECT app_current_org_ids())
));

CREATE POLICY internal_links_select ON internal_links FOR SELECT TO app_user
USING (EXISTS (
  SELECT 1 FROM articles a
  WHERE a.id = internal_links.source_article_id
    AND a.organization_id IN (SELECT app_current_org_ids())
));

CREATE POLICY gsc_daily_metrics_select ON gsc_daily_metrics FOR SELECT TO app_user
USING (app_org_of_product(product_id) IN (SELECT app_current_org_ids()));

CREATE POLICY cannibalization_issues_select ON cannibalization_issues
FOR SELECT TO app_user
USING (app_org_of_product(product_id) IN (SELECT app_current_org_ids()));

CREATE POLICY cannibalization_issues_update ON cannibalization_issues
FOR UPDATE TO app_user
USING (app_has_org_role(app_org_of_product(product_id),
       ARRAY['owner','admin','editor']::org_role[]))
WITH CHECK (app_has_org_role(app_org_of_product(product_id),
       ARRAY['owner','admin','editor']::org_role[]));

-- ---------------------------------------------------------------------------
-- BILLING — sola lettura per owner/admin. Ogni scrittura passa dal worker
-- che processa i webhook Stripe: nessun percorso client può creare crediti.
-- ---------------------------------------------------------------------------
CREATE POLICY subscriptions_select ON subscriptions FOR SELECT TO app_user
USING (app_has_org_role(organization_id, ARRAY['owner','admin']::org_role[]));

CREATE POLICY credit_ledger_select ON credit_ledger FOR SELECT TO app_user
USING (app_has_org_role(organization_id, ARRAY['owner','admin']::org_role[]));

CREATE POLICY usage_counters_select ON usage_counters FOR SELECT TO app_user
USING (organization_id IN (SELECT app_current_org_ids()));

-- `stripe_events` non ha alcuna policy per app_user: è invisibile all'applicazione.
REVOKE ALL ON stripe_events FROM app_user;

-- ---------------------------------------------------------------------------
-- OPS — l'utente vede lo stato dei propri job (UPGRADE #3) ma non li modifica.
-- ---------------------------------------------------------------------------
CREATE POLICY jobs_select ON jobs FOR SELECT TO app_user
USING (organization_id IN (SELECT app_current_org_ids()));

CREATE POLICY job_events_select ON job_events FOR SELECT TO app_user
USING (EXISTS (
  SELECT 1 FROM jobs j
  WHERE j.id = job_events.job_id
    AND j.organization_id IN (SELECT app_current_org_ids())
));

CREATE POLICY webhook_deliveries_select ON webhook_deliveries FOR SELECT TO app_user
USING (app_has_org_role(organization_id, ARRAY['owner','admin']::org_role[]));

-- `rate_limit_violations` è interna all'infrastruttura: nessun accesso applicativo.
REVOKE ALL ON rate_limit_violations FROM app_user;

-- ---------------------------------------------------------------------------
-- ACCODAMENTO JOB + RISERVA CREDITO
--
-- `jobs` e `credit_ledger` non hanno policy di INSERT per app_user: nessuna
-- Server Action può scriverci direttamente. L'unico varco è la funzione
-- SECURITY DEFINER `app_enqueue_job()`, definita in 0003_enqueue_job.sql.
--
-- Sta in un file separato perché serve in OGNI ambiente, mentre queste policy
-- richiedono i ruoli applicativi (app_user/app_worker), che in sviluppo locale
-- vanno comunque creati da `postgres/init/01-roles.sql` prima di poterle
-- applicare. Tenerla qui la rendeva applicabile solo dopo quel setup — separarla
-- la rende testabile anche prima che i ruoli esistano.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Ruolo worker: bypassa RLS perché opera senza sessione utente.
-- Non è mai usato da codice che risponde direttamente a una richiesta browser.
-- È l'unico ruolo che scrive su credit_ledger in `consume`/`release`, a valle
-- dell'esito reale del job.
-- ---------------------------------------------------------------------------
ALTER ROLE app_worker BYPASSRLS;
