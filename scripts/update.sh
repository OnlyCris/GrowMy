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
  if compose exec -T postgres pg_dump -U postgres -d growmy --clean --if-exists \
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
  IMAGE_TAG="$PREVIOUS_SHORT" compose build --quiet web worker || true

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
compose build web worker
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
if [[ -d "$MIGRATION_DIR" ]]; then
  NEW_MIGRATIONS="$(git diff --name-only "${PREVIOUS_SHA}" "${TARGET_SHA}" -- "$MIGRATION_DIR" || true)"

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

log "Applicazione delle migrazioni"
compose run --rm --no-deps \
  -e DATABASE_URL="postgres://app_migrator:${POSTGRES_MIGRATOR_PASSWORD:-$POSTGRES_PASSWORD}@postgres:5432/growmy" \
  web npx drizzle-kit migrate --config=packages/db/drizzle.config.ts

ok "Migrazioni applicate"

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

# Rimuove solo le immagini senza tag e più vecchie di 7 giorni: le immagini
# taggate con SHA restano, perché sono ciò che rende possibile il rollback.
docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true
docker builder prune -f --filter "until=168h" >/dev/null 2>&1 || true
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
