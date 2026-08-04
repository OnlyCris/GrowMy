# GrowMy — Architettura (Fase 2)

Piattaforma SEO in autopilota. Reverse engineering di Outrank.so, elevata con tre
upgrade strutturali: **human-in-the-loop**, **closed-loop planner su dati GSC**,
**pipeline di job idempotente e osservabile**.

---

## 1. Decisioni architetturali

| Ambito | Scelta | Perché |
|---|---|---|
| Frontend | Next.js 15 App Router, React 19, TypeScript `strict` | RSC per il data-fetching, Server Actions per le mutazioni |
| UI | Tailwind v4, Shadcn UI, Framer Motion | Componenti accessibili di proprietà, non una dipendenza npm opaca |
| DB | Postgres 16 + **Drizzle ORM** | Query parametrizzate, migrazioni versionate, tipi inferiti |
| Auth | Supabase Auth (Google OAuth + magic link) | Gestione sessioni matura; i segreti restano nello schema `auth` |
| Job | **BullMQ + Redis**, worker containerizzato | Generazione da 2–8 min: fuori dal ciclo request/response |
| LLM | Layer astratto multi-provider con fallback | Nessun lock-in, resilienza ai downtime, cost tracking per job |
| Storage | S3-compatibile (MinIO in dev, R2/S3 in prod) | Immagini generate fuori dal database |
| Deploy | Docker-first: `docker-compose.yml` + `Dockerfile` multi-stage | Ambiente identico in locale e in produzione |

**Il punto architetturale non negoziabile**: la generazione di un articolo non
è mai eseguita in una route handler. La richiesta HTTP accoda un job idempotente
e ritorna subito; il worker esegue, scrive lo stato su Postgres, la UI segue via
streaming. Questo è ciò che rende possibile l'UPGRADE #3.

### Separazione delle connessioni al database

| Ruolo | Usato da | RLS |
|---|---|---|
| `app_user` | App Next.js (RSC, Server Actions, API) | **Attivo e forzato** |
| `app_worker` | Worker BullMQ | `BYPASSRLS` — nessun client, scope dal payload del job |
| `app_migrator` | `drizzle-kit` in fase di deploy | DDL only |

---

## 2. Schema del database

30 tabelle in 6 domini. Codice completo in `packages/db/src/schema/`.

### Identità e multi-tenancy — `identity.ts`

```
users ──┬── organization_members ──── organizations ──┬── invitations
        │        (role: owner/admin/editor/viewer)    ├── api_keys
        └── user_preferences                          └── audit_logs
```

- `organization_id` è **la chiave di isolamento tenant di tutta la piattaforma**.
- I ruoli vivono solo in `organization_members`. Mai letti da JWT claims client-side.
- `api_keys`: Argon2id per la verifica, SHA-256 indicizzato per la lookup in O(1),
  prefisso in chiaro solo per il riconoscimento visivo in lista.
- `audit_logs` è append-only, garantito dall'assenza di policy UPDATE/DELETE.

### Prodotti e integrazioni — `products.ts`

```
products ──┬── product_brand_profiles  (1:1, blob letto solo dai worker)
           └── integrations ──── integration_health_checks
```

- `products` porta la configurazione dell'**UPGRADE #1**: `autoApproveBrief`,
  `autoApproveDraft`, `approvalTimeoutHours` (fallback anti-stallo).
- `integrations.encryptedCredentials`: AES-256-GCM, chiave presente **solo**
  nell'ambiente del worker. Le GRANT a livello di colonna impediscono
  all'applicazione di leggerla anche con un `select *`.
- `credentialsKeyVersion` abilita la rotazione della chiave senza downtime.
- `integration_health_checks` alimenta l'**UPGRADE #3**: l'utente vede *quando*
  si è rotta l'integrazione, non solo *che* è rotta.

### Contenuti — `content.ts`

```
keyword_clusters ── keywords ── articles ──┬── article_versions   (append-only)
                                           ├── article_publications (log per tentativo)
                                           ├── media_assets
                                           └── internal_links
```

- `articles` è lo **stato corrente**; il contenuto vive in `article_versions`,
  append-only: ogni rigenerazione, rewrite AI ed edit umano crea una riga.
  Diff in UI e rollback istantaneo diventano gratuiti.
- `articles.brief` (jsonb) è l'outline editabile **prima** della stesura — UPGRADE #1.
- `articles.qualityScore`: leggibilità, keyword density, originalità, densità
  fattuale, link interni. Sotto soglia → una rigenerazione automatica gratuita.
- `keywords.embedding` e `articles.embedding` (pgvector, indice HNSW): impediscono
  la cannibalizzazione **alla radice**, rifiutando keyword semanticamente troppo
  vicine a contenuti già esistenti.
- `article_publications`: una riga **per tentativo**, con `errorCode` macchina,
  messaggio già tradotto per l'utente e `nextRetryAt`. Mai stack trace — UPGRADE #3.

### Closed-loop planner — `analytics.ts`

```
gsc_connections ── gsc_daily_metrics ──┬── cannibalization_issues
                                       └── planner_decisions
```

- `gsc_daily_metrics` è la tabella più voluminosa: partizionata per RANGE su `date`,
  partizioni mensili create da `scripts/db/ensure-partitions.sh`. Le partizioni
  oltre i 16 mesi vengono **staccate e archiviate, mai cancellate**.
- Indice parziale su `position BETWEEN 8 AND 20`: è la query dello striking distance,
  eseguita settimanalmente su ogni prodotto.
- `planner_decisions` è il cuore della trasparenza dell'**UPGRADE #2**: ogni
  promozione, declassamento o refresh scrive `rationale` (linguaggio naturale,
  mostrato all'utente) più `evidence` (i numeri che l'hanno motivato). Risponde alla
  domanda che nell'originale non ha risposta: *«perché questa keyword questa settimana?»*

### Billing — `billing.ts`

```
subscriptions ── credit_ledger (append-only, doppia entrata) ── usage_counters
stripe_events (idempotenza webhook)
```

Il ledger è il meccanismo dell'**UPGRADE #3** sul lato economico:

```
grant_subscription (+30) → reserve (−1) → consume (0)      ← pubblicazione confermata
                                        → release (+1)     ← fallimento definitivo
```

Nessun UPDATE, nessun DELETE: il saldo è `SUM(amount)`. `idempotencyKey` unico
impedisce doppi accrediti su webhook Stripe consegnati due volte.
**Nell'originale un fallimento di pubblicazione brucia il credito. Qui no.**

### Ops — `ops.ts`

```
jobs ── job_events        webhook_deliveries        rate_limit_violations
```

- `jobs` è il **mirror persistente** di BullMQ. Redis è cache, Postgres è verità:
  se Redis viene perso, la coda si ricostruisce da qui.
- `jobs.idempotencyKey` (`{type}:{entityId}:{discriminator}`, unique) impedisce che
  cron doppi, click ripetuti o retry di rete accodino due volte lo stesso lavoro.
- `job_events` è la timeline leggibile mostrata all'utente su un articolo fallito.

---

## 3. File tree

```
growmy/
├── apps/
│   ├── web/                                  # Next.js 15 — App Router
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (marketing)/              # Sito pubblico, statico, ISR
│   │   │   │   │   ├── page.tsx              # Landing
│   │   │   │   │   ├── pricing/page.tsx
│   │   │   │   │   ├── integrations/page.tsx
│   │   │   │   │   ├── blog/[slug]/page.tsx
│   │   │   │   │   └── layout.tsx
│   │   │   │   │
│   │   │   │   ├── (auth)/
│   │   │   │   │   ├── signin/page.tsx
│   │   │   │   │   ├── verify/page.tsx
│   │   │   │   │   ├── accept-invite/[token]/page.tsx
│   │   │   │   │   └── layout.tsx
│   │   │   │   │
│   │   │   │   ├── (app)/                    # Area autenticata
│   │   │   │   │   ├── layout.tsx            # Guard di sessione + sidebar
│   │   │   │   │   ├── onboarding/
│   │   │   │   │   │   ├── page.tsx
│   │   │   │   │   │   └── _components/analysis-progress.tsx
│   │   │   │   │   │
│   │   │   │   │   └── [orgSlug]/
│   │   │   │   │       ├── layout.tsx        # Verifica membership → 404 se estraneo
│   │   │   │   │       ├── page.tsx          # Dashboard org
│   │   │   │   │       │
│   │   │   │   │       ├── review/           # ★ UPGRADE #1 — coda di revisione
│   │   │   │   │       │   ├── page.tsx
│   │   │   │   │       │   ├── loading.tsx
│   │   │   │   │       │   └── _components/
│   │   │   │   │       │       ├── review-queue.tsx
│   │   │   │   │       │       ├── brief-editor.tsx
│   │   │   │   │       │       ├── draft-reviewer.tsx
│   │   │   │   │       │       └── quality-score-panel.tsx
│   │   │   │   │       │
│   │   │   │   │       ├── products/
│   │   │   │   │       │   ├── page.tsx
│   │   │   │   │       │   ├── new/page.tsx
│   │   │   │   │       │   └── [productId]/
│   │   │   │   │       │       ├── layout.tsx
│   │   │   │   │       │       ├── page.tsx           # Overview
│   │   │   │   │       │       ├── planner/           # ★ UPGRADE #2
│   │   │   │   │       │       │   ├── page.tsx
│   │   │   │   │       │       │   └── _components/
│   │   │   │   │       │       │       ├── content-calendar.tsx
│   │   │   │   │       │       │       ├── keyword-table.tsx
│   │   │   │   │       │       │       ├── decision-log.tsx
│   │   │   │   │       │       │       └── striking-distance-panel.tsx
│   │   │   │   │       │       ├── articles/
│   │   │   │   │       │       │   ├── page.tsx
│   │   │   │   │       │       │   └── [articleId]/
│   │   │   │   │       │       │       ├── page.tsx
│   │   │   │   │       │       │       ├── versions/page.tsx
│   │   │   │   │       │       │       └── activity/page.tsx   # ★ UPGRADE #3
│   │   │   │   │       │       ├── analytics/page.tsx
│   │   │   │   │       │       ├── integrations/
│   │   │   │   │       │       │   ├── page.tsx
│   │   │   │   │       │       │   └── _components/health-status-card.tsx
│   │   │   │   │       │       └── settings/
│   │   │   │   │       │           ├── page.tsx
│   │   │   │   │       │           ├── brand/page.tsx
│   │   │   │   │       │           └── automation/page.tsx
│   │   │   │   │       │
│   │   │   │   │       └── settings/
│   │   │   │   │           ├── general/page.tsx
│   │   │   │   │           ├── members/page.tsx
│   │   │   │   │           ├── api-keys/page.tsx
│   │   │   │   │           ├── billing/page.tsx
│   │   │   │   │           └── audit-log/page.tsx
│   │   │   │   │
│   │   │   │   ├── api/
│   │   │   │   │   ├── health/route.ts            # ★ health-check per update.sh
│   │   │   │   │   ├── ready/route.ts             # readiness: DB + Redis
│   │   │   │   │   ├── auth/callback/route.ts
│   │   │   │   │   ├── webhooks/
│   │   │   │   │   │   ├── stripe/route.ts
│   │   │   │   │   │   └── gsc/route.ts
│   │   │   │   │   ├── oauth/
│   │   │   │   │   │   ├── webflow/callback/route.ts
│   │   │   │   │   │   ├── shopify/callback/route.ts
│   │   │   │   │   │   ├── notion/callback/route.ts
│   │   │   │   │   │   └── gsc/callback/route.ts
│   │   │   │   │   └── agent/v1/               # REST API pubblica
│   │   │   │   │       ├── _middleware.ts      # API key + rate limit + scopes
│   │   │   │   │       ├── auth/whoami/route.ts
│   │   │   │   │       ├── products/…
│   │   │   │   │       ├── keywords/…
│   │   │   │   │       └── articles/…
│   │   │   │   │
│   │   │   │   ├── error.tsx                   # Error boundary globale
│   │   │   │   ├── not-found.tsx
│   │   │   │   └── layout.tsx
│   │   │   │
│   │   │   ├── actions/                        # Server Actions (mutazioni)
│   │   │   │   ├── _safe-action.ts             # ★ wrapper: auth + RBAC + Zod + rate limit
│   │   │   │   ├── auth.actions.ts
│   │   │   │   ├── organization.actions.ts
│   │   │   │   ├── product.actions.ts
│   │   │   │   ├── keyword.actions.ts
│   │   │   │   ├── article.actions.ts
│   │   │   │   ├── review.actions.ts
│   │   │   │   ├── integration.actions.ts
│   │   │   │   ├── gsc.actions.ts
│   │   │   │   └── billing.actions.ts
│   │   │   │
│   │   │   ├── components/
│   │   │   │   ├── ui/                         # Shadcn (button, dialog, table…)
│   │   │   │   ├── shared/
│   │   │   │   │   ├── data-table/
│   │   │   │   │   ├── empty-state.tsx
│   │   │   │   │   ├── error-state.tsx
│   │   │   │   │   ├── skeletons/              # ★ uno skeleton per ogni vista
│   │   │   │   │   ├── status-badge.tsx
│   │   │   │   │   └── confirm-dialog.tsx
│   │   │   │   ├── editor/                     # Tiptap + toolbar AI + diff view
│   │   │   │   └── marketing/
│   │   │   │
│   │   │   ├── hooks/
│   │   │   ├── lib/
│   │   │   │   ├── supabase/{server,client,middleware}.ts
│   │   │   │   ├── auth/{session,rbac,guards}.ts
│   │   │   │   ├── csrf.ts
│   │   │   │   └── utils.ts
│   │   │   └── middleware.ts                   # CSP, security headers, refresh sessione
│   │   ├── next.config.ts
│   │   └── package.json
│   │
│   └── worker/                                 # ★ BullMQ — processo separato
│       ├── src/
│       │   ├── index.ts                        # Bootstrap + graceful shutdown
│       │   ├── queues.ts
│       │   ├── scheduler.ts                    # Repeatable jobs (cron)
│       │   ├── processors/
│       │   │   ├── product-onboarding.processor.ts
│       │   │   ├── keyword-research.processor.ts
│       │   │   ├── article-research.processor.ts
│       │   │   ├── article-generate.processor.ts
│       │   │   ├── article-publish.processor.ts
│       │   │   ├── integration-health.processor.ts
│       │   │   ├── gsc-sync.processor.ts
│       │   │   └── planner-recalculate.processor.ts   # ★ UPGRADE #2
│       │   ├── lib/
│       │   │   ├── job-recorder.ts             # ★ mirror Postgres + job_events
│       │   │   ├── idempotency.ts
│       │   │   ├── backoff.ts
│       │   │   └── dead-letter.ts
│       │   └── health.ts                       # /health del worker
│       ├── Dockerfile
│       └── package.json
│
├── packages/
│   ├── db/
│   │   ├── src/
│   │   │   ├── schema/{_shared,enums,identity,products,content,analytics,billing,ops,relations,index}.ts
│   │   │   ├── queries/                        # ★ query scoped: iniettano sempre organizationId
│   │   │   ├── client.ts
│   │   │   └── types.ts
│   │   ├── migrations/
│   │   │   ├── sql/0001_rls_policies.sql
│   │   │   └── meta/
│   │   └── drizzle.config.ts
│   │
│   ├── core/                                   # Logica di dominio, zero I/O HTTP
│   │   ├── src/
│   │   │   ├── articles/{state-machine,quality-score,internal-linking}.ts
│   │   │   ├── planner/{striking-distance,cannibalization,prioritizer,refresh}.ts
│   │   │   ├── credits/{ledger,reservations}.ts
│   │   │   └── seo/{slug,meta,readability}.ts
│   │   └── package.json
│   │
│   ├── ai/                                     # ★ layer LLM multi-provider
│   │   ├── src/
│   │   │   ├── provider.ts                     # Interfaccia comune
│   │   │   ├── providers/{anthropic,openai}.ts
│   │   │   ├── router.ts                       # Fallback + retry + cost tracking
│   │   │   ├── prompts/{research,outline,draft,rewrite,image}.ts
│   │   │   └── guardrails.ts                   # Forbidden topics, PII, prompt injection
│   │   └── package.json
│   │
│   ├── integrations/                           # Adapter CMS
│   │   ├── src/
│   │   │   ├── adapter.ts                      # Interfaccia: connect/healthCheck/publish/update
│   │   │   ├── providers/{wordpress,ghost,webflow,shopify,notion,wix,framer,webhook}.ts
│   │   │   ├── crypto.ts                       # AES-256-GCM + rotazione chiavi
│   │   │   └── ssrf-guard.ts                   # ★ validazione URL: blocca IP privati
│   │   └── package.json
│   │
│   ├── validation/                             # ★ schemi Zod condivisi client↔server
│   ├── env/                                    # ★ t3-env: fail-fast in build
│   ├── logger/                                 # Pino + redaction PII/segreti
│   └── config/                                 # tsconfig, eslint, tailwind, prettier
│
├── scripts/                                    # ★ operatività server
│   ├── install.sh
│   ├── update.sh
│   ├── rollback.sh
│   ├── backup-db.sh
│   ├── restore-db.sh
│   ├── healthcheck.sh
│   ├── rotate-encryption-key.sh
│   └── db/ensure-partitions.sh
│
├── docker/
│   ├── Dockerfile.web                          # Multi-stage, non-root, distroless
│   ├── Dockerfile.worker
│   ├── docker-compose.yml                      # Prod
│   ├── docker-compose.dev.yml                  # + MinIO, Mailpit
│   └── nginx/nginx.conf
│
├── .env.example                                # ★ ogni variabile documentata, zero segreti
├── .github/workflows/{ci.yml,deploy.yml,security.yml}
├── turbo.json
└── package.json
```

---

## 4. Server Actions e API

### Convenzione trasversale

Ogni Server Action passa da `_safe-action.ts`, che applica **in quest'ordine**:

1. Verifica sessione lato server (`supabase.auth.getUser()`, mai `getSession()`
   sul client, mai fiducia in un cookie non verificato).
2. Risoluzione membership + ruolo dal database.
3. Controllo RBAC del ruolo minimo richiesto.
4. Validazione input con Zod (`.strict()`: proprietà extra → rifiuto).
5. Rate limit sullo scope dell'azione.
6. Esecuzione in transazione.
7. Scrittura su `audit_logs` se l'azione è sensibile.
8. Ritorno di un `ActionResult<T>` discriminato — **mai** un'eccezione grezza al client.

Le Server Actions di Next.js hanno già la protezione CSRF basata su Origin; il
wrapper aggiunge un token double-submit per le azioni distruttive.

### Server Actions

| Azione | Ruolo min. | Rate limit | Note |
|---|---|---|---|
| `signInWithGoogle` / `signInWithEmail` | — | 5/min per IP | Blocco progressivo su violazioni |
| `acceptInvitation` | — | 10/h per IP | Token confrontato per hash |
| `createOrganization` | — | 3/h per utente | |
| `updateOrganization` | admin | 30/min | |
| `inviteMember` / `revokeInvitation` | admin | 20/h | |
| `updateMemberRole` | admin | 20/h | Impedisce l'auto-declassamento dell'ultimo owner |
| `removeMember` | admin | 20/h | |
| `createApiKey` / `revokeApiKey` | admin | 10/h | Segreto in chiaro ritornato **una sola volta** |
| `createProduct` | editor | 10/h | Accoda `product_onboarding_analysis` |
| `updateProduct` / `updateBrandProfile` | editor | 60/min | |
| `pauseProduct` / `resumeProduct` | admin | 20/h | |
| `deleteProduct` | owner | 5/h | Soft delete + cancellazione job schedulati |
| `generateKeywords` | editor | **5/h per prodotto** | Costosa: LLM + provider SEO |
| `createKeyword` / `updateKeyword` | editor | 60/min | Dedup semantica via embedding |
| `bulkScheduleKeywords` / `bulkDeleteKeywords` | editor | 20/h | Max 500 elementi per chiamata |
| `approveKeywordSuggestions` | editor | 60/min | |
| `generateArticleNow` | editor | **10/h per prodotto** | Riserva un credito **prima** di accodare |
| `updateArticleBrief` ★ | editor | 60/min | UPGRADE #1 |
| `approveBrief` ★ | editor | 60/min | Sblocca `brief_ready → generating` |
| `rejectBrief` ★ | editor | 30/min | Rigenerazione con feedback, credito non riaddebitato |
| `saveArticleDraft` | editor | 120/min | Nuova riga in `article_versions` |
| `rewriteSection` | editor | 30/min per articolo | Rewrite AI mirato |
| `approveDraft` ★ | editor | 60/min | Sblocca `draft_ready → approved` |
| `revertToVersion` | editor | 30/min | |
| `retryPublish` | editor | 10/h per articolo | Idempotente sul tentativo |
| `connectIntegration` | admin | 10/h | Dry-run obbligatorio prima di salvare `healthy` |
| `testIntegration` | admin | 20/h | |
| `disconnectIntegration` | admin | 10/h | |
| `connectGsc` / `disconnectGsc` | admin | 10/h | |
| `runPlannerNow` ★ | admin | 2/h per prodotto | UPGRADE #2 |
| `resolveCannibalization` ★ | editor | 30/min | |
| `createCheckoutSession` / `openBillingPortal` | owner | 10/h | Solo redirect Stripe |

### Route Handlers

| Endpoint | Auth | Note |
|---|---|---|
| `GET /api/health` | pubblico | ★ liveness: risponde 200 se il processo è vivo |
| `GET /api/ready` | pubblico | ★ readiness: verifica Postgres + Redis. **Pingato da `update.sh` prima di spostare il traffico** |
| `GET /api/auth/callback` | — | Scambio codice OAuth |
| `POST /api/webhooks/stripe` | firma HMAC | Idempotente su `stripe_event_id` |
| `GET /api/oauth/{provider}/callback` | state param | State firmato e a scadenza, anti-CSRF |

### REST API pubblica — `/api/agent/v1`

Autenticazione: `Authorization: Bearer growmy_live_...`.
Rate limit: 120 req/min e 10.000 req/giorno per chiave, header `X-RateLimit-*`,
`429` con `Retry-After`. Scope per chiave verificati per endpoint.

```
GET    /auth/whoami

GET    /products                    POST   /products
GET    /products/{id}               PATCH  /products/{id}
POST   /products/{id}/pause         POST   /products/{id}/resume

GET    /keywords                    POST   /keywords/generate
POST   /keywords/bulk-schedule      POST   /keywords/bulk-delete
GET    /keywords/export

GET    /articles                    POST   /articles/generate
GET    /articles/{id}               GET    /articles/{id}/content
GET    /articles/{id}/versions      POST   /articles/{id}/revert
POST   /articles/{id}/retry-publish

# ★ Esclusivi rispetto all'originale — espongono i tre upgrade via API
GET    /review/queue                     # coda umana (UPGRADE #1)
POST   /articles/{id}/approve-brief
POST   /articles/{id}/approve-draft
GET    /articles/{id}/activity           # timeline job (UPGRADE #3)
GET    /products/{id}/planner/decisions  # log decisioni (UPGRADE #2)
POST   /products/{id}/planner/run
GET    /products/{id}/gsc/striking-distance
GET    /products/{id}/gsc/cannibalization
GET    /integrations/{id}/health         # storico health-check

GET    /subscription/status         GET    /usage/stats
GET    /billing/portal-url
```

### Job schedulati (repeatable BullMQ)

| Job | Cadenza | Scopo |
|---|---|---|
| `daily-content-dispatch` | ogni ora | Accoda le generazioni la cui ora locale è arrivata |
| `approval-timeout-sweep` ★ | ogni 15 min | Auto-approva ciò che ha superato `approvalTimeoutHours` |
| `integration-health-check` ★ | ogni 24 h | Avvisa **prima** che la pubblicazione fallisca |
| `gsc-sync` | ogni 24 h | Import incrementale delle metriche |
| `planner-recalculate` ★ | settimanale | Ricalcola le priorità sui dati reali |
| `credit-cycle-refresh` | ogni ora | Ricarica e scadenza crediti a fine ciclo |
| `dead-letter-alert` | ogni ora | Notifica gli admin dei job in DLQ |
| `partition-maintenance` | settimanale | Crea le partizioni future di `gsc_daily_metrics` |

---

## 5. Postura di sicurezza

| Requisito | Implementazione |
|---|---|
| Zero trust input | Zod `.strict()` su ogni Server Action, route handler e payload di job |
| SQL injection | Solo Drizzle, query parametrizzate. Nessun SQL concatenato |
| XSS | Markdown → HTML sanificato con `rehype-sanitize`, allowlist esplicita. CSP con nonce |
| CSRF | Origin check nativo delle Server Actions + double-submit token sulle azioni distruttive |
| SSRF | ★ `ssrf-guard.ts` su ogni URL fornito dall'utente: blocca IP privati, loopback, link-local, metadata cloud. Rilevante perché la piattaforma **crawla domini indicati dall'utente** e consegna webhook |
| Prompt injection | Contenuto crawlato passato all'LLM come dato delimitato, mai come istruzione. Guardrail sull'output |
| Isolamento tenant | RLS forzato su 30 tabelle + query layer che inietta sempre `organizationId` |
| Segreti | t3-env: errore in **build time** se manca una variabile critica. Credenziali CMS cifrate AES-256-GCM con chiave solo nel worker |
| Rate limiting | Redis sliding window + persistenza su `rate_limit_violations` per i blocchi che devono sopravvivere a un riavvio |
| Error handling | Nessuno stack trace al client. Pino con redaction di token, header, email |
| Fatturazione | Ledger append-only idempotente. Nessun percorso client può creare crediti |

---

## 6. Ciclo di vita del deploy

`update.sh` esegue nell'ordine: backup DB → pull → build immagini →
`drizzle-kit migrate` (solo additive; le rimozioni di colonna richiedono due deploy) →
avvio del nuovo container → **polling di `/api/ready`** → switch del traffico →
stop del vecchio container. Se `/api/ready` non risponde 200 entro il timeout,
`rollback.sh` riporta l'immagine precedente e ripristina il backup.

---

**Fase 2 completata.** Attendo approvazione per la Fase 3 (implementazione frontend).
