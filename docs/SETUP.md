# GrowMy — guida al primo deploy

Dall'account vuoto al sito online. Tempo stimato: **60–90 minuti**, di cui
gran parte è attesa (propagazione DNS, build delle immagini).

Serve saper aprire un terminale e copiare comandi. Non serve altro.

---

## Le tre chiavi Google (non confonderle)

Google compare tre volte in questa guida, con tre chiavi **diverse**, da tre
console **diverse**. È la fonte di confusione numero uno, quindi mettiamola
subito in chiaro:

| Cosa | Variabile | Dove si prende | A cosa serve |
|---|---|---|---|
| **Gemini API** | `GOOGLE_GENERATIVE_AI_API_KEY` | aistudio.google.com | **Scrivere gli articoli** |
| **OAuth client** | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | console.cloud.google.com | Login "Accedi con Google" |
| **Search Console** | *(riusa l'OAuth client)* | console.cloud.google.com | Leggere posizioni e impressioni |

La prima inizia con `AIza`, è gratuita entro limiti generosi e da sola basta a
far funzionare tutta la generazione di contenuti. Le altre due riguardano
l'identità degli utenti, non la scrittura.

**Puoi partire con la sola chiave Gemini.** Anthropic e OpenAI sono opzionali:
il sistema li usa come riserva se Gemini è momentaneamente irraggiungibile.

---

## Fase A — Cosa procurarsi (30 minuti)

### A1. Un server

Una VPS con **Debian 12**, minimo 4 GB di RAM e 40 GB di disco.
Hetzner CX22 (~4 €/mese) o DigitalOcean da 4 GB (~24 $/mese) vanno bene.
Alla creazione scegli l'accesso **tramite chiave SSH**, non con password.

Annota l'indirizzo IP che ti viene assegnato.

### A2. Un dominio

Un dominio qualsiasi. Nel pannello DNS crea un record:

```
Tipo: A     Nome: @     Valore: <IP-del-server>     TTL: 300
```

La propagazione richiede da 5 minuti a qualche ora. Verifica con:

```bash
dig +short growmy.tuodominio.it
```

Quando risponde con l'IP del server, puoi proseguire.

### A3. La chiave Gemini

1. Vai su **aistudio.google.com/apikey**
2. Accedi con un account Google
3. `Create API key` → scegli o crea un progetto
4. Copia la chiave (inizia con `AIza`) e conservala

Il piano gratuito basta per iniziare. Per volumi seri attiva la fatturazione
nello stesso progetto.

### A4. Supabase (autenticazione)

1. Vai su **supabase.com**, crea un progetto (piano gratuito)
2. Scegli una regione vicina al server (Frankfurt se il server è in Europa)
3. `Project Settings` → `API`, copia tre valori:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role** → `SUPABASE_SERVICE_ROLE_KEY`
4. `Project Settings` → `API` → `JWT Settings`, copia **JWT Secret**

> La chiave `service_role` bypassa completamente la sicurezza del database.
> Trattala come la password di root: mai in un messaggio, mai in un repository.

### A5. Google OAuth (login)

1. **console.cloud.google.com** → crea un progetto (può essere lo stesso di A3)
2. `APIs & Services` → `OAuth consent screen` → tipo **External** → compila i campi
3. `Credentials` → `Create credentials` → **OAuth client ID** → *Web application*
4. In **Authorized redirect URIs** inserisci **entrambi**:
   ```
   https://growmy.tuodominio.it/api/auth/callback
   https://<progetto>.supabase.co/auth/v1/callback
   ```
5. Copia **Client ID** e **Client Secret**
6. Torna su Supabase → `Authentication` → `Providers` → **Google** → incolla i
   due valori e salva

### A6. Stripe (solo se vendi abbonamenti)

Se stai solo provando il sistema, salta questo passo: metti valori fittizi che
iniziano con `sk_test_` e `whsec_` e configura Stripe più avanti.

---

## Fase B — Provisioning del server (15 minuti)

### B1. Connettiti

```bash
ssh root@<IP-del-server>
```

### B2. Esegui lo script

```bash
curl -fsSL https://raw.githubusercontent.com/<tuo-utente>/growmy/main/scripts/install.sh -o install.sh

sudo bash install.sh \
  --domain growmy.tuodominio.it \
  --email tu@tuodominio.it \
  --repo https://github.com/<tuo-utente>/growmy.git
```

Lo script installa Docker, crea l'utente `growmy`, configura firewall e
fail2ban, blinda SSH, genera i segreti interni ed emette il certificato TLS.

Dura circa 10 minuti. **Non chiudere il terminale.**

> Se in fondo compare *"Nessuna chiave SSH: hardening SALTATO"*, aggiungi la
> tua chiave pubblica a `/home/growmy/.ssh/authorized_keys` e riesegui lo
> script. Finché non lo fai, l'accesso con password resta attivo.

---

## Fase C — Configurazione (10 minuti)

### C1. Apri il file dei segreti

```bash
sudo -u growmy nano /opt/growmy/.env
```

Le password del database e le chiavi di cifratura sono **già state generate**
dallo script. Devi compilare solo i valori raccolti nella Fase A:

```bash
GOOGLE_GENERATIVE_AI_API_KEY=AIza...          # da A3
LLM_PROVIDER_ORDER=google                     # solo Gemini per ora

NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co   # da A4
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_JWT_SECRET=...

GOOGLE_CLIENT_ID=...apps.googleusercontent.com     # da A5
GOOGLE_CLIENT_SECRET=GOCSPX-...

STRIPE_SECRET_KEY=sk_test_placeholder              # da A6, o segnaposto
STRIPE_WEBHOOK_SECRET=whsec_placeholder
```

Salva con `Ctrl+O`, `Invio`, poi esci con `Ctrl+X`.

### C2. Fai una copia della chiave di cifratura

```bash
sudo -u growmy grep CREDENTIALS_ENCRYPTION_KEY /opt/growmy/.env
```

**Salva questo valore nel tuo password manager, adesso.**

Cifra le credenziali dei CMS dei tuoi clienti. Se perdi il server e non hai
questa chiave, ogni integrazione WordPress, Webflow e Shopify va riconfigurata
a mano, una per una.

---

## Fase D — Primo avvio (15 minuti)

### D1. Avvia

```bash
cd /opt/growmy
sudo systemctl start growmy
```

La prima volta Docker compila le immagini: **5–10 minuti**. Segui l'avanzamento:

```bash
docker compose -f docker/docker-compose.yml logs -f
```

Esci dai log con `Ctrl+C` (i container restano attivi).

### D2. Applica lo schema del database

```bash
cd /opt/growmy
docker compose -f docker/docker-compose.yml exec web \
  npx drizzle-kit migrate --config=packages/db/drizzle.config.ts

docker compose -f docker/docker-compose.yml exec -T postgres \
  psql -U postgres -d growmy < packages/db/migrations/sql/0001_rls_policies.sql

docker compose -f docker/docker-compose.yml exec -T postgres \
  psql -U postgres -d growmy < packages/db/migrations/sql/0002_deferred_constraints.sql
```

Il primo comando crea le tabelle, il secondo attiva l'isolamento tra clienti,
il terzo aggiunge i vincoli di integrità.

### D3. Verifica

```bash
curl -fsS http://localhost:3000/api/ready | jq
```

Risposta attesa:

```json
{
  "status": "ready",
  "checks": {
    "database": { "healthy": true, "latencyMs": 3 },
    "redis":    { "healthy": true, "latencyMs": 1 }
  }
}
```

Poi apri **https://growmy.tuodominio.it** nel browser.

---

## Fase E — Manutenzione

| Cosa | Comando |
|---|---|
| Aggiornare | `/opt/growmy/scripts/update.sh` |
| Tornare indietro | `/opt/growmy/scripts/rollback.sh` |
| Vedere le versioni | `/opt/growmy/scripts/rollback.sh --list` |
| Log in tempo reale | `docker compose -f /opt/growmy/docker/docker-compose.yml logs -f web worker` |
| Backup manuale | `/opt/growmy/scripts/backup-db.sh` |
| Stato dei container | `docker compose -f /opt/growmy/docker/docker-compose.yml ps` |

Backup notturno alle 03:15 e rinnovo del certificato sono già automatici.

`update.sh` fa da solo: backup, build, migrazioni, verifica di prontezza e —
se qualcosa non risponde — **rollback automatico**. Se rileva una migrazione
che cancella colonne o tabelle, blocca il deploy invece di eseguirlo.

---

## Se qualcosa non va

**`/api/ready` risponde `not_ready`**

```bash
docker compose -f /opt/growmy/docker/docker-compose.yml logs --tail 50 web
```

Quasi sempre è una variabile mancante in `.env`: il messaggio dice quale.

**Il browser dà errore di certificato**

Il DNS non era propagato quando lo script ha provato a emetterlo. Riprova:

```bash
sudo certbot certonly --standalone -d growmy.tuodominio.it
sudo systemctl restart growmy
```

**Il login con Google dà `redirect_uri_mismatch`**

Nella Google Cloud Console mancano gli URI del passo A5. Devono essere
**entrambi**, con `https://` e senza slash finale.

**Gli articoli restano in coda e non vengono generati**

```bash
docker compose -f /opt/growmy/docker/docker-compose.yml logs --tail 50 worker
```

Di solito è la chiave Gemini: verifica che inizi con `AIza` e che il progetto
Google abbia l'API Generative Language abilitata.

**Il build fallisce per memoria esaurita**

Il server ha meno di 4 GB. Lo swap creato dallo script aiuta, ma su una VPS da
2 GB il build di Next.js non passa. Serve un piano più grande.

---

## Nota sui costi

| Voce | Costo indicativo |
|---|---|
| VPS Hetzner CX22 | ~4 €/mese |
| Dominio | ~12 €/anno |
| Supabase | gratuito fino a 50.000 utenti attivi |
| Gemini API | gratuito entro i limiti, poi a consumo |
| Certificato TLS | gratuito (Let's Encrypt) |

Sotto i 10 € al mese hai l'intera piattaforma in produzione.
