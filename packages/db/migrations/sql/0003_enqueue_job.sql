-- ============================================================================
-- app_enqueue_job — unico varco di scrittura su `jobs` e `credit_ledger`
--
-- Nessuna delle due tabelle ha policy di INSERT per l'applicazione: l'unico
-- percorso è questa funzione, che in una sola transazione verifica il ruolo,
-- blocca la riga organizzazione, controlla il saldo, riserva il credito e
-- accoda il lavoro.
--
-- PERCHÉ NON USA auth.uid()
--
-- La versione precedente leggeva l'utente dal contesto di sessione Supabase.
-- Aveva due difetti:
--
--   1. Non funzionava in sviluppo locale, dove non esiste lo schema `auth`.
--      Un varco di sicurezza che si può esercitare solo in produzione è un
--      varco che nessuno testa mai.
--   2. Legava una funzione di dominio a uno specifico provider di
--      autenticazione, rendendo la migrazione a un altro provider un lavoro
--      sul database invece che sull'applicazione.
--
-- Ora l'id utente arriva come parametro. NON è un indebolimento: il valore è
-- prodotto dal wrapper `safe-action`, che lo ricava da `supabase.auth.getUser()`
-- — una verifica di firma lato server — e mai dall'input del client. La
-- funzione lo riverifica comunque contro `organization_members`, quindi un id
-- arbitrario non basta ad accodare lavoro.
--
-- Idempotente: rieseguirlo sostituisce la funzione senza toccare i dati.
-- ============================================================================

CREATE OR REPLACE FUNCTION app_enqueue_job(
  p_user_id         uuid,
  p_organization_id uuid,
  p_product_id      uuid,
  p_type            job_type,
  p_target_type     text,
  p_target_id       uuid,
  p_payload         jsonb,
  p_idempotency_key text,
  p_reserve_credit  boolean DEFAULT false,
  p_trace_id        text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id         uuid;
  v_balance        integer;
  v_reservation_id uuid;
  v_role           org_role;
BEGIN
  -- 1. Autorizzazione. La funzione è SECURITY DEFINER e bypassa RLS, quindi il
  --    controllo va fatto qui a mano, senza eccezioni.
  SELECT om.role INTO v_role
  FROM organization_members om
  WHERE om.user_id = p_user_id
    AND om.organization_id = p_organization_id;

  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'editor') THEN
    RAISE EXCEPTION 'FORBIDDEN'
      USING HINT = 'Ruolo insufficiente per accodare lavoro su questa organizzazione.';
  END IF;

  -- 2. Il prodotto, se indicato, deve appartenere all'organizzazione dichiarata.
  --    Impedisce di operare su un prodotto altrui passando il proprio org_id.
  IF p_product_id IS NOT NULL
     AND (SELECT organization_id FROM products WHERE id = p_product_id)
         IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'PRODUCT_ORG_MISMATCH';
  END IF;

  -- 3. Idempotenza: una seconda invocazione con la stessa chiave restituisce
  --    il job esistente invece di crearne un duplicato.
  SELECT id INTO v_job_id FROM jobs WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_job_id;
  END IF;

  -- 4. Riserva del credito, quando richiesta.
  IF p_reserve_credit THEN
    -- Lock sulla riga organizzazione: serializza le riserve concorrenti ed
    -- evita che due richieste simultanee superino entrambe il controllo di saldo.
    PERFORM 1 FROM organizations WHERE id = p_organization_id FOR UPDATE;

    SELECT COALESCE(sum(amount), 0) INTO v_balance
    FROM credit_ledger
    WHERE organization_id = p_organization_id
      AND (expires_at IS NULL OR expires_at > now());

    IF v_balance < 1 THEN
      RAISE EXCEPTION 'INSUFFICIENT_CREDITS'
        USING HINT = 'Saldo crediti esaurito per il ciclo corrente.';
    END IF;

    v_reservation_id := gen_random_uuid();

    INSERT INTO credit_ledger (
      organization_id, product_id, type, amount,
      reservation_id, idempotency_key, description
    ) VALUES (
      p_organization_id, p_product_id, 'reserve', -1,
      v_reservation_id, 'reserve:' || p_idempotency_key,
      'Riserva credito per ' || p_type::text
    );
  END IF;

  -- 5. Accodamento.
  INSERT INTO jobs (
    organization_id, product_id, type, idempotency_key,
    target_type, target_id, payload, trace_id
  ) VALUES (
    p_organization_id, p_product_id, p_type, p_idempotency_key,
    p_target_type, p_target_id,
    COALESCE(p_payload, '{}'::jsonb)
      || jsonb_build_object('reservationId', v_reservation_id),
    p_trace_id
  )
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

-- La firma precedente, basata su auth.uid(), non deve restare raggiungibile:
-- due overload dello stesso nome renderebbero ambigua la risoluzione e
-- lascerebbero in vita il percorso legato a Supabase.
DROP FUNCTION IF EXISTS app_enqueue_job(uuid, uuid, job_type, text, uuid, jsonb, text, boolean, text);

REVOKE EXECUTE ON FUNCTION app_enqueue_job(
  uuid, uuid, uuid, job_type, text, uuid, jsonb, text, boolean, text
) FROM PUBLIC;

-- In produzione i ruoli esistono; in sviluppo si lavora con il superuser
-- locale e la GRANT non è necessaria. Il blocco condizionale rende lo script
-- eseguibile in entrambi gli ambienti senza modifiche.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION app_enqueue_job(
      uuid, uuid, uuid, job_type, text, uuid, jsonb, text, boolean, text
    ) TO app_user;
  END IF;
END
$$;
