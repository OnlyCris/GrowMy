#!/usr/bin/env bash
#
# GrowMy — aggiornamento con downtime minimo e rollback automatico
#
# Sequenza:
#   1. Backup del database (obbligatorio: senza, si interrompe)
#   2. Registrazione della versione corrente per il rollback
#   3. Pull del codice
#   4. Build delle immagini (il vecchio container continua a servire)
#   5. Migrazioni — SOLO additive, verificate prima di applicarle
#   6. Avvio dei nuovi container
#   7. Polling di /api/ready
#   8. Se il polling fallisce -> rollback automatico e ripristino del backup
#
# Uso:
#   ./scripts/update.sh                  aggiorna al branch corrente
#   ./scripts/update.sh --ref v1.4.0     aggiorna a un tag o commit preciso
#   ./scripts/update.sh --skip-backup    salta il backup (SOLO in staging)
#   ./scripts/update.sh --dry-run        mostra cosa cambierebbe e si ferma
#
set -Eeuo pipefail

# -----------------------------------------------------------------------------
# Ri-esecuzione da una copia
# -----------------------------------------------------------------------------
# Al passo 4 questo script fa `git checkout` del codice nuovo, e quel checkout
# sostituisce anche QUESTO FILE mentre bash lo sta eseguendo. Bash però non
# carica lo script in memoria tutto insieme: lo legge a blocchi dal descrittore
# aperto, per offset di byte. Il risultato è che le righe non ancora lette
# vengono prese dal file NUOVO a partire da un offset calcolato sul VECCHIO —
# nel caso migliore si esegue la versione precedente di un comando, nel peggiore
# si esegue testo troncato a metà.
#
# È già costato due deploy falliti: la correzione al comando di migrazione
# risultava applicata all'immagine ma non allo script, perché quel blocco era
# ancora quello della versione precedente.
#
# Copiandosi in /tmp e ri-eseguendosi da lì, il file in esecuzione non è più
# quello che git sostituisce. La copia vive in una directory che `git checkout`
# non tocca e viene rimossa all'uscita.
if [[ "${GROWMY_UPDATE_REEXEC:-}" != "1" ]]; then
  _self_copy="$(mktemp /tmp/growmy-update.XXXXXX)"
  cat "$0" > "$_self_copy"
  chmod +x "$_self_copy"
  export GROWMY_UPDATE_REEXEC=1
  export GROWMY_UPDATE_SELF_COPY="$_self_copy"
  exec "$_self_copy" "$@"
fi

# Nella copia: rimuovila all'uscita, comunque vada.
if [[ -n "${GROWMY_UPDATE_SELF_COPY:-}" ]]; then
  trap 'rm -f "${GROWMY_UPDATE_SELF_COPY}"' EXIT
fi

APP_DIR="${APP_DIR:-/opt/growmy}"
COMPOSE_FILE="${APP_DIR}/docker/docker-compose.yml"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/growmy}"
STATE_FILE="${APP_DIR}/.deploy-state"

HEALTH_URL="http://127.0.0.1:3000/api/ready"
HEALTH_TIMEOUT=180   # secondi di attesa massima
HEALTH_INTERVAL=5

TARGET_REF=""
SKIP_BACKUP="false"
DRY_RUN="false"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

log()  { printf '%s[ .. ]%s %s\n' "$C_BLUE"   "$C_RESET" "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$C_GREEN"  "$C_RESET" "$*"; }
warn() { printf '%s[ !! ]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s[fail]%s %s\n' "$C_RED"    "$C_RESET" "$*" >&2; exit 1; }
step() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

# `--env-file` esplicito: Docker Compose cerca `.env` accanto al FILE COMPOSE
# (cioè in docker/), non nella root del progetto dove sta davvero. Senza questo
# flag tutte le variabili risultano vuote e i container partono senza segreti.
compose() { docker compose --env-file "${APP_DIR}/.env" -f "$COMPOSE_FILE" "$@"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)         TARGET_REF="${2:-}"; shift 2 ;;
    --skip-backup) SKIP_BACKUP="true";  shift ;;
    --dry-run)     DRY_RUN="true";      shift ;;
    --help|-h)     sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "Opzione sconosciuta: $1" ;;
  esac
done

cd "$APP_DIR" || die "Directory non trovata: ${APP_DIR}"
[[ -f "$COMPOSE_FILE" ]] || die "docker-compose.yml non trovato."
[[ -f "${APP_DIR}/.env" ]] || die ".env non trovato: esegui prima install.sh"

# `--env-file` passa le variabili a Docker Compose, non alla shell di questo
# script: senza questo source, POSTGRES_PASSWORD resta non definita qui sotto
# `set -u` e la migrazione (che la legge direttamente in bash, non nel
# container) fallisce con "unbound variable".
set -a
# shellcheck disable=SC1091
source "${APP_DIR}/.env"
set +a

# ---------------------------------------------------------------------------
# 0. Stato attuale
# ---------------------------------------------------------------------------
step "Stato attuale"

PREVIOUS_SHA="$(git rev-parse HEAD)"
PREVIOUS_SHORT="$(git rev-parse --short HEAD)"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

log "Versione in esecuzione: ${PREVIOUS_SHORT} (${CURRENT_BRANCH})"

# Un working tree sporco significa modifiche fatte a mano sul server. Il pull
# le sovrascriverebbe silenziosamente: meglio fermarsi e farle vedere.
if [[ -n "$(git status --porcelain)" ]]; then
  warn "Ci sono modifiche non committate sul server:"
  git status --short
  die "Committale o scartale (git checkout .) prima di aggiornare."
fi

# ---------------------------------------------------------------------------
# 1. Cosa cambierebbe
# ---------------------------------------------------------------------------
step "Recupero delle modifiche"

git fetch --all --prune --tags --quiet
TARGET="${TARGET_REF:-origin/${CURRENT_BRANCH}}"
TARGET_SHA="$(git rev-parse "$TARGET")"
TARGET_SHORT="$(git rev-parse --short "$TARGET")"

if [[ "$PREVIOUS_SHA" == "$TARGET_SHA" ]]; then
  ok "Già aggiornato a ${TARGET_SHORT}. Niente da fare."
  exit 0
fi

COMMIT_COUNT="$(git rev-list --count "${PREVIOUS_SHA}..${TARGET_SHA}")"
log "${COMMIT_COUNT} commit da applicare: ${PREVIOUS_SHORT} -> ${TARGET_SHORT}"
git --no-pager log --oneline --no-decorate "${PREVIOUS_SHA}..${TARGET_SHA}" | head -20 | sed 's/^/       /'

# Segnala se cambiano schema, compose o dipendenze: sono i cambiamenti che
# richiedono più attenzione e che di solito causano i deploy problematici.
CHANGED="$(git diff --name-only "${PREVIOUS_SHA}" "${TARGET_SHA}")"
echo "$CHANGED" | grep -q '^packages/db/'   && warn "Lo schema del database cambia."
echo "$CHANGED" | grep -q '^docker/'        && warn "La configurazione Docker cambia."
echo "$CHANGED" | grep -q 'package.*\.json' && warn "Le dipendenze cambiano."

if [[ "$DRY_RUN" == "true" ]]; then
  ok "Dry run: nessuna modifica applicata."
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Backup
# ---------------------------------------------------------------------------
BACKUP_FILE=""

if [[ "$SKIP_BACKUP" == "true" ]]; then
  warn "Backup SALTATO su richiesta esplicita."
else
  step "Backup del database"

  mkdir -p "$BACKUP_DIR"
  BACKUP_FILE="${BACKUP_DIR}/pre-update-$(date +%Y%m%d-%H%M%S)-${PREVIOUS_SHORT}.sql.gz"

  # `--clean --if-exists`: il dump è ripristinabile su un database esistente
  # senza doverlo prima svuotare a mano.
  #
  # `pg_dump` legge `PGPASSWORD`, non `POSTGRES_PASSWORD` — libpq non conosce
  # quel nome. Il container ha già `POSTGRES_PASSWORD` in ambiente (dal blocco
  # `environment:` del servizio postgres); la shell dentro `exec` la rilegge e
  # la espone col nome giusto, senza bisogno che questo script la conosca.
  if compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -d growmy --clean --if-exists' \
      | gzip -9 > "$BACKUP_FILE"; then
    BACKUP_SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
    ok "Backup salvato: $(basename "$BACKUP_FILE") (${BACKUP_SIZE})"
  else
    rm -f "$BACKUP_FILE"
    die "Backup fallito. Aggiornamento interrotto: non si aggiorna senza rete di sicurezza."
  fi

  # Un dump troppo piccolo è quasi sempre un dump vuoto per un errore di
  # autenticazione andato a buon fine solo apparentemente.
  if [[ "$(stat -c%s "$BACKUP_FILE")" -lt 1024 ]]; then
    die "Il backup è sospettosamente piccolo. Verifica manualmente prima di procedere."
  fi

  # Conserva 14 giorni di backup: oltre, il disco si riempie senza avvisare.
  find "$BACKUP_DIR" -name 'pre-update-*.sql.gz' -mtime +14 -delete 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 3. Stato per il rollback
# ---------------------------------------------------------------------------
cat > "$STATE_FILE" <<EOF
PREVIOUS_SHA=${PREVIOUS_SHA}
TARGET_SHA=${TARGET_SHA}
BACKUP_FILE=${BACKUP_FILE}
STARTED_AT=$(date -Iseconds)
EOF
chmod 0600 "$STATE_FILE"

# ---------------------------------------------------------------------------
# Rollback automatico
# ---------------------------------------------------------------------------
rollback() {
  local reason="$1"

  printf '\n%s╭─ ROLLBACK ─────────────────────────────────╮%s\n' "$C_RED" "$C_RESET"
  printf '%s│%s %s\n' "$C_RED" "$C_RESET" "$reason"
  printf '%s╰────────────────────────────────────────────╯%s\n\n' "$C_RED" "$C_RESET"

  log "Ripristino del codice a ${PREVIOUS_SHORT}"
  git checkout --force "$PREVIOUS_SHA" --quiet

  log "Ricostruzione dell'immagine precedente"
  # Sequenziale anche qui: un rollback che viene ucciso dall'OOM killer
  # lascerebbe il sistema in uno stato peggiore di quello da cui si scappava.
  IMAGE_TAG="$PREVIOUS_SHORT" compose build --quiet worker || true
  IMAGE_TAG="$PREVIOUS_SHORT" compose build --quiet web    || true

  log "Riavvio dei container"
  IMAGE_TAG="$PREVIOUS_SHORT" compose up -d --remove-orphans

  # Il ripristino del database NON è automatico, ed è deliberato: se le
  # migrazioni sono state solo additive (come devono essere), i dati sono
  # intatti e ripristinare il dump perderebbe tutto ciò che è successo durante
  # il deploy. La decisione richiede un umano.
  if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
    warn "Backup disponibile ma NON ripristinato automaticamente."
    warn "Se le migrazioni hanno corrotto i dati, ripristina con:"
    warn "  ${APP_DIR}/scripts/rollback.sh --restore-db ${BACKUP_FILE}"
  fi

  die "Rollback completato. Il servizio è tornato alla versione ${PREVIOUS_SHORT}."
}

trap 'rollback "Errore inatteso alla riga ${LINENO}: ${BASH_COMMAND}"' ERR

# ---------------------------------------------------------------------------
# 4. Aggiornamento del codice
# ---------------------------------------------------------------------------
step "Aggiornamento del codice"
git checkout --force "$TARGET_SHA" --quiet
ok "Codice a ${TARGET_SHORT}"

# ---------------------------------------------------------------------------
# 5. Build
# ---------------------------------------------------------------------------
step "Build delle immagini"
log "Il container attuale continua a servire traffico durante il build"

# Il tag è lo SHA del commit: è ciò che rende il rollback una riga di comando
# invece di una ricostruzione da sorgente.
export IMAGE_TAG="$TARGET_SHORT"

# --- Verifica preventiva della memoria disponibile ---------------------------
# Il server ha 1 GB di RAM e un solo core. Il picco di minificazione di Next.js
# lo supera: senza swap il build viene ucciso dall'OOM killer a metà, con un
# messaggio (`signal: killed`) che non dice nulla di utile. Peggio: l'OOM
# killer sceglie il processo più grosso, che potrebbe essere Postgres o
# un'ALTRA applicazione sulla stessa macchina.
SWAP_TOTAL_MB="$(free -m | awk '/^Swap:/ {print $2}')"
if (( SWAP_TOTAL_MB < 2048 )); then
  die "Swap insufficiente (${SWAP_TOTAL_MB} MB): il build verrebbe ucciso dall'OOM killer.
       Attiva almeno 4 GB:
         fallocate -l 6G /swapfile && chmod 600 /swapfile
         mkswap /swapfile && swapon /swapfile
         echo '/swapfile none swap sw 0 0' >> /etc/fstab"
fi

# --- Build SEQUENZIALE, un servizio alla volta --------------------------------
# `compose build web worker` li costruisce in PARALLELO: due toolchain Node
# contemporanee su 1 GB di RAM sono la causa diretta dell'OOM. In sequenza il
# build è più lungo di qualche minuto ma arriva in fondo.
#
# Il worker viene fermato prima: durante il build non ha nulla da fare e la
# sua memoria serve altrove. Il web resta acceso e continua a servire traffico.
log "Arresto temporaneo del worker per liberare memoria"
compose stop worker >/dev/null 2>&1 || true

log "Build del worker (1/2)"
compose build worker

log "Build del web (2/2) — è la fase più pesante, può richiedere parecchi minuti"
compose build web

ok "Immagini costruite con tag ${TARGET_SHORT}"

# ---------------------------------------------------------------------------
# 6. Migrazioni
# ---------------------------------------------------------------------------
step "Migrazioni del database"

# Verifica preventiva: le migrazioni devono essere NON DISTRUTTIVE.
# DROP COLUMN, DROP TABLE e simili richiedono una strategia a due deploy
# (prima si smette di usare la colonna, poi la si rimuove) e non possono
# passare da uno script automatico.
MIGRATION_DIR="packages/db/migrations"
NEW_MIGRATIONS=""

if [[ -d "$MIGRATION_DIR" ]]; then
  # Solo i file `.sql`: `meta/_journal.json` e gli snapshot cambiano a ogni
  # `drizzle-kit generate` anche quando lo schema resta identico, e farebbero
  # risultare "nuove migrazioni" dove non ce ne sono.
  NEW_MIGRATIONS="$(git diff --name-only "${PREVIOUS_SHA}" "${TARGET_SHA}" -- "${MIGRATION_DIR}/*.sql" || true)"

  if [[ -n "$NEW_MIGRATIONS" ]]; then
    log "Nuove migrazioni rilevate"

    DESTRUCTIVE=""
    while IFS= read -r file; do
      [[ -f "$file" ]] || continue
      if grep -qiE 'drop\s+(table|column|constraint)|truncate\s+table' "$file"; then
        DESTRUCTIVE+="  ${file}"$'\n'
      fi
    done <<< "$NEW_MIGRATIONS"

    if [[ -n "$DESTRUCTIVE" ]]; then
      warn "Migrazioni potenzialmente distruttive:"
      printf '%s' "$DESTRUCTIVE" >&2
      rollback "Migrazione distruttiva bloccata. Applicala a mano, in due deploy separati."
    fi

    ok "Nessuna operazione distruttiva rilevata"
  fi
fi

# Le migrazioni girano nel container WORKER, non nel web.
#
# L'immagine web è un build standalone di Next: contiene solo i pacchetti che
# il tracing ha trovato raggiungibili a runtime. `drizzle-kit` e `drizzle-orm`
# non ci sono, quindi questo passo falliva a ogni deploy e faceva scattare il
# rollback — un difetto presente dal primo commit e mascherato dal fatto che
# fallisce identico anche quando non ci sono migrazioni da applicare.
# L'immagine worker ha invece lo store pnpm completo.
#
# Il binario è invocato per percorso, non tramite `npx`: `npx` senza una copia
# locale la scarica dalla rete: silenziosamente, e a una versione diversa da
# quella del lockfile. Un deploy non deve dipendere dalla raggiungibilità del
# registry npm, e una migrazione non deve girare con un drizzle-kit che nessuno
# ha testato. Se il binario manca, questo fallisce dicendo esattamente quello.
if [[ -z "$NEW_MIGRATIONS" ]]; then
  # Nessun file di migrazione cambiato fra le due revisioni: non c'è nulla da
  # applicare. Prima si invocava `drizzle-kit migrate` comunque, a ogni deploy,
  # ed è così che un passo che non ha MAI funzionato è rimasto invisibile per
  # mesi — falliva identico anche quando non aveva niente da fare, e nessuno
  # collegava il rollback a una migrazione che non esisteva.
  ok "Nessuna nuova migrazione: passo saltato"
else
  log "Applicazione delle migrazioni"
  compose run --rm --no-deps -w /app/packages/db \
    -e DATABASE_MIGRATION_URL="postgres://app_migrator:${POSTGRES_MIGRATOR_PASSWORD:-$POSTGRES_PASSWORD}@postgres:5432/growmy" \
    worker ./node_modules/.bin/drizzle-kit migrate --config=drizzle.config.ts

  ok "Migrazioni applicate"
fi

# Partizioni future di gsc_daily_metrics: se mancano, gli inserimenti falliscono
# il primo giorno del mese nuovo.
if [[ -x "${APP_DIR}/scripts/db/ensure-partitions.sh" ]]; then
  "${APP_DIR}/scripts/db/ensure-partitions.sh" && ok "Partizioni verificate"
fi

# ---------------------------------------------------------------------------
# 7. Avvio
# ---------------------------------------------------------------------------
step "Avvio dei nuovi container"

# `--wait` fa attendere a Docker che gli healthcheck passino. Non basta da solo
# (il nostro polling è più severo) ma evita di procedere su container morti.
compose up -d --remove-orphans --wait --wait-timeout 120 || true
ok "Container avviati"

# ---------------------------------------------------------------------------
# 8. Verifica di prontezza
# ---------------------------------------------------------------------------
step "Verifica di prontezza"

log "Polling di ${HEALTH_URL} (fino a ${HEALTH_TIMEOUT}s)"

ELAPSED=0
READY="false"

while (( ELAPSED < HEALTH_TIMEOUT )); do
  if RESPONSE="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
    if echo "$RESPONSE" | grep -q '"status":"ready"'; then
      READY="true"
      break
    fi
  fi
  sleep "$HEALTH_INTERVAL"
  ELAPSED=$(( ELAPSED + HEALTH_INTERVAL ))
  printf '       %ss…\r' "$ELAPSED"
done
printf '\n'

if [[ "$READY" != "true" ]]; then
  warn "Ultimi log dell'applicazione:"
  compose logs --tail 40 web >&2 || true
  rollback "L'applicazione non è diventata pronta entro ${HEALTH_TIMEOUT}s."
fi

ok "Applicazione pronta ($(echo "$RESPONSE" | grep -o '"totalMs":[0-9]*' || echo 'n/d'))"

# Verifica anche il worker: un deploy in cui l'app risponde ma i job non
# vengono processati è un deploy fallito che sembra riuscito.
if ! compose ps worker --format json | grep -q '"Health":"healthy"'; then
  warn "Il worker non risulta sano. L'app funziona ma i job potrebbero non essere processati."
  compose logs --tail 20 worker >&2 || true
fi

# Da qui in poi il deploy è riuscito: il rollback automatico non serve più.
trap - ERR

# ---------------------------------------------------------------------------
# 9. Pulizia
# ---------------------------------------------------------------------------
step "Pulizia"

# Rimuove le immagini senza tag e più vecchie di 7 giorni.
docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true
docker builder prune -f --filter "until=168h" >/dev/null 2>&1 || true

# Le immagini taggate con SHA invece NON scadono mai da sole: ogni deploy ne
# aggiunge di nuove per rendere il rollback una riga di comando, ma su un
# server con 20GB di disco si accumulano in fretta (un worker pesa ~1.3GB).
# Qui è già successo: 17 tag accumulati in un giorno hanno riempito il disco
# a metà di un deploy, mandando in errore anche il rollback automatico che
# doveva salvare la situazione. Si tengono le 2 più recenti per tag (quella
# attuale e la precedente, per un rollback immediato) e si eliminano le
# altre — un rollback più vecchio richiede comunque una ricostruzione da
# sorgente, non solo un `docker tag`.
for repo in growmy-web growmy-worker; do
  docker images "$repo" --format '{{.Tag}}	{{.CreatedAt}}' \
    | sort -k2 -r \
    | awk 'NR>2 {print $1}' \
    | while read -r old_tag; do
        [[ -n "$old_tag" && "$old_tag" != "<none>" ]] || continue
        docker rmi "${repo}:${old_tag}" >/dev/null 2>&1 || true
      done
done

ok "Immagini obsolete rimosse"

# ---------------------------------------------------------------------------
# Riepilogo
# ---------------------------------------------------------------------------
step "Aggiornamento completato"

cat <<EOF

  ${PREVIOUS_SHORT}  ->  ${C_BOLD}${TARGET_SHORT}${C_RESET}   (${COMMIT_COUNT} commit)

  Backup           $( [[ -n "$BACKUP_FILE" ]] && basename "$BACKUP_FILE" || echo 'saltato' )
  Rollback         ${APP_DIR}/scripts/rollback.sh
  Log in tempo reale
                   docker compose -f ${COMPOSE_FILE} logs -f web worker

EOF

ok "Fatto."
