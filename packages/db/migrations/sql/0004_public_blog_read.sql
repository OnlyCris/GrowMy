-- ============================================================================
-- LETTURA PUBBLICA PER LA VETRINA BLOG — blog.[dominio-cliente]
--
-- GrowMy non è solo il backend che genera gli articoli: serve anche la
-- vetrina pubblica su cui i visitatori reali li leggono (product.blog_domain,
-- risolto via header Host in middleware.ts). Chi visita quella vetrina non ha
-- una sessione autenticata — nessun app_current_user_id() da valutare — quindi
-- le policy esistenti (tutte scoped sull'organizzazione dell'utente loggato)
-- non gli mostrerebbero nulla.
--
-- Le policy qui sotto sono la RISPOSTA MINIMA a quel bisogno, non un'apertura
-- generica: valgono SOLO per righe già status = 'published' (o la loro
-- product) — contenuto che è comunque già pubblico su internet nel momento in
-- cui esiste, indicizzabile da chiunque via Google. Non c'è nulla da
-- proteggere leggendolo anche da qui. Restano protetti tutti gli stati
-- pre-pubblicazione (researching, brief_ready, draft_ready, approved) e ogni
-- colonna dei prodotti che le query dell'applicazione non selezionano
-- esplicitamente (stessa disciplina di select-espliciti già in uso ovunque).
--
-- Le policy si sommano (OR) a quelle esistenti per lo stesso comando: un
-- membro autenticato dell'organizzazione continua a vedere tutto ciò che
-- vedeva prima, in più chiunque (incluso un visitatore senza sessione) vede
-- gli articoli già pubblici.
-- ============================================================================

CREATE POLICY products_select_public ON products FOR SELECT TO app_user
USING (blog_domain IS NOT NULL AND deleted_at IS NULL);

CREATE POLICY articles_select_public ON articles FOR SELECT TO app_user
USING (status = 'published' AND deleted_at IS NULL);

-- Solo la versione CORRENTE di un articolo pubblicato: mai le versioni
-- superate, che potrebbero contenere bozze scartate o testo intermedio mai
-- destinato alla pubblicazione.
CREATE POLICY article_versions_select_public ON article_versions FOR SELECT TO app_user
USING (
  EXISTS (
    SELECT 1 FROM articles a
    WHERE a.current_version_id = article_versions.id
      AND a.status = 'published'
      AND a.deleted_at IS NULL
  )
);
