# GrowMy — sviluppo in locale

Quattro comandi e l'app gira sul tuo computer, con dati realistici e senza
dover configurare Supabase, Stripe o un dominio.

## Prerequisiti

- **Node 20.11+** — `node -v`
- **pnpm 9** — `npm install -g pnpm`
- **Docker Desktop** avviato — `docker ps`

## Avvio

```bash
cd /percorso/di/GrowMy

cp .env.local.example .env.local
pnpm install
pnpm bootstrap    # avvia Postgres + Redis, crea lo schema, popola i dati
pnpm dev
```

Apri **http://localhost:3000/demo/review**

Trovi quattro elementi in coda: due brief da approvare e due bozze da
revisionare, con contenuti in italiano su fitness e fisco.

> `pnpm bootstrap` è la scorciatoia per `infra:up` + `db:push` + `db:seed`.
> La prima esecuzione scarica le immagini Docker: metti in conto qualche minuto.
>
> Il nome non è `setup` di proposito: **`pnpm setup` è un comando interno di
> pnpm** che configura il PATH della shell. Uno script con quel nome viene
> silenziosamente ignorato.

## Cosa provare

**La regola del colore.** L'unico elemento colorato nell'interfaccia è l'ambra,
e sta solo dove serve una tua decisione. Approva tutto e guarda l'ambra
scomparire: quello è il segnale che non hai nulla da fare.

**Il brief editor.** Riordina le sezioni trascinandole, cambia l'angolo
editoriale, aggiungi un punto. Le modifiche sono locali finché non approvi.

**Il diff.** Il primo articolo ha due versioni: apri la tab "Differenze" e vedi
cosa è cambiato fra la prima stesura e il rewrite, senza rileggere tutto.

**Il quality score.** Sull'articolo del recupero muscolare la densità fattuale
è a 44, sotto la soglia di 50. È l'unica barra ambra: ti dice dove guardare
senza leggere 1.640 parole. Cliccala per vedere cosa fare.

**La tastiera.** `J` e `K` scorrono la coda, `A` approva, `?` mostra le
scorciatoie. Chi revisiona trenta articoli al mese non deve toccare il mouse.

## Come funziona l'autenticazione in locale

`DEV_AUTH_BYPASS=true` fa considerare autenticato l'utente creato dal seed.
Serve a non doverti registrare su Supabase per vedere una pagina.

Non è una convenzione fragile: `lib/auth/dev-session.ts` **lancia un errore
fatale all'import** se `NODE_ENV === 'production'`. Non esiste combinazione di
variabili che lo renda attivo in produzione — il processo non parte proprio.

Per provare il login Google vero: metti `DEV_AUTH_BYPASS=false` e compila le
variabili Supabase seguendo la Fase A di [SETUP.md](./SETUP.md).

## Comandi utili

| Comando | Cosa fa |
|---|---|
| `pnpm dev` | Avvia l'app in hot reload |
| `pnpm db:studio` | Interfaccia web sul database (porta 4983) |
| `pnpm db:seed` | Ricrea i dati di esempio |
| `pnpm db:sql` | Applica funzioni e trigger SQL (non gestiti da drizzle-kit) |
| `pnpm db:push` | Allinea lo schema senza generare migrazioni |
| `pnpm db:generate` | Genera un file di migrazione dalle modifiche allo schema |
| `pnpm infra:logs` | Log di Postgres e Redis |
| `pnpm infra:reset` | **Cancella tutto** e ricrea l'infrastruttura |
| `pnpm typecheck` | Controllo dei tipi su tutto il monorepo |

Interfacce disponibili: Drizzle Studio su `localhost:4983`, Mailpit (email
catturate) su `localhost:8025`.

## `db:push` o `db:generate`?

In sviluppo usa **`db:push`**: applica lo schema direttamente, senza creare
file di migrazione. È rapido e va bene finché stai sperimentando.

Quando una modifica allo schema è definitiva, genera la migrazione con
**`db:generate`** e committala. In produzione `update.sh` applica solo le
migrazioni versionate, mai un push — un push in produzione può perdere dati
senza avvisare.

## Se qualcosa non va

**`ECONNREFUSED` su localhost:5432**

Docker non è partito o i container non sono su.

```bash
docker ps                 # devono comparire growmy-dev-postgres e -redis
pnpm infra:up
```

**`Invalid environment variables` all'avvio**

Manca `.env.local` o una variabile è malformata. Il messaggio dice quale.

```bash
cp .env.local.example .env.local
```

**La coda di revisione è vuota**

Il seed non è stato eseguito, o l'hai svuotata approvando tutto.

```bash
pnpm db:seed
```

**`relation "articles" does not exist`**

Lo schema non è stato applicato.

```bash
pnpm db:push
```

**Errori di tipo su `@growmy/db` o `@growmy/env`**

I pacchetti workspace non sono collegati.

```bash
pnpm install
```

**`Invalid environment variables` con tutte le variabili `Required`**

Non hai copiato il file di ambiente. È il primo comando della guida:

```bash
cp .env.local.example .env.local
```

**`pnpm setup` non fa nulla di quello che mi aspetto**

`setup` è un comando interno di pnpm: configura `PNPM_HOME` nella shell e
ignora lo script del progetto. Il comando giusto è `pnpm bootstrap`.

**Ripartire da zero**

```bash
pnpm infra:reset && pnpm db:push && pnpm db:seed
```

## Cosa manca ancora

L'app parte e la coda di revisione è completamente funzionante. Non sono
ancora implementati:

- `apps/worker/` — il processo che genera davvero gli articoli. Le azioni di
  approvazione accodano correttamente i job, ma nessuno li consuma: gli
  articoli approvati restano in stato `approved` invece di essere pubblicati.
- `packages/ai/` — gli adapter Gemini, Anthropic e OpenAI.
- `packages/integrations/` — gli adapter CMS (WordPress, Webflow, Shopify).
- Le viste dashboard, content planner e analytics.
