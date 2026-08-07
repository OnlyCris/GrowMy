#!/usr/bin/env bash
#
# GrowMy — rollback manuale a una versione precedente
#
# `update.sh` esegue già un rollback automatico se il deploy fallisce. Questo
# script serve al caso diverso e più insidioso: il deploy è riuscito, l'app
# risponde, ma qualcosa non va e te ne accorgi venti minuti dopo.
#
# Uso:
#   ./scripts/rollback.sh                          torna al deploy precedente
#   ./scripts/rollback.sh --ref v1.3.0             torna a un tag preciso
#   ./scripts/rollback.sh --list                   elenca versioni e backup
#   ./scripts/rollback.sh --restore-db <file>      ripristina anche il database
#
# ATTENZIONE SUL RIPRISTINO DEL DATABASE: sostituisce lo stato attuale con
# quello del backup. Tutto ciò che è successo dopo il backup — articoli
# generati, approvazioni, pagamenti — viene perso. Usalo solo se le migrazioni
# hanno corrotto i dati; per un semplice bug applicativo il rollback del solo
# codice è quasi sempre la scelta giusta.
#
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/growmy}"
COMPOSE_FILE="${APP_DIR}/docker/docker-compose.yml"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/growmy}"
STATE_FILE="${APP_DIR}/.deploy-state"

HEALTH_URL="http://127.0.0.1:3000/api/ready"
HEALTH_TIMEOUT=120

TARGET_REF=""
RESTORE_DB=""
LIST_ONLY="false"
ASSUME_YES="false"

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
    --ref)        TARGET_REF="${2:-}"; shift 2 ;;
    --restore-db) RESTORE_DB="${2:-}"; shift 2 ;;
    --list)       LIST_ONLY="true";    shift ;;
    --yes|-y)     ASSUME_YES="true";   shift ;;
    --help|-h)    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "Opzione sconosciuta: $1" ;;
  esac
done

cd "$APP_DIR" || die "Directory non trovata: ${APP_DIR}"

# ---------------------------------------------------------------------------
# --list
# ---------------------------------------------------------------------------
if [[ "$LIST_ONLY" == "true" ]]; then
  step "Versione in esecuzione"
  printf '  %s  %s\n' "$(git rev-parse --short HEAD)" "$(git log -1 --format='%s')"

  step "Ultimi 10 commit disponibili"
  git --no-pager log --oneline --no-decorate -10 | sed 's/^/  /'

  step "Immagini Docker disponibili per il rollback"
  docker images growmy-web --format '  {{.Tag}}\t{{.CreatedSince}}\t{{.Size}}' | head -10

  step "Backup del database"
  if compgen -G "${BACKUP_DIR}/*.sql.gz" > /dev/null; then
    ls -lht "${BACKUP_DIR}"/*.sql.gz | head -10 | awk '{printf "  %-42s %8s  %s %s %s\n", $9, $5, $6, $7, $8}'
  else
    printf '  nessun backup trovato in %s\n' "$BACKUP_DIR"
  fi

  if [[ -f "$STATE_FILE" ]]; then
    step "Ultimo deploy registrato"
    sed 's/^/  /' "$STATE_FILE"
  fi

  exit 0
fi

# ---------------------------------------------------------------------------
# Determinazione del target
# ---------------------------------------------------------------------------
step "Determinazione della versione di destinazione"

CURRENT_SHA="$(git rev-parse HEAD)"
CURRENT_SHORT="$(git rev-parse --short HEAD)"

if [[ -n "$TARGET_REF" ]]; then
  git rev-parse --verify "$TARGET_REF" >/dev/null 2>&1 \
    || die "Riferimento non valido: ${TARGET_REF}"
  TARGET_SHA="$(git rev-parse "$TARGET_REF")"
elif [[ -f "$STATE_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$STATE_FILE"
  TARGET_SHA="${PREVIOUS_SHA:-}"
  [[ -n "$TARGET_SHA" ]] || die "Lo stato del deploy non contiene una versione precedente."
  log "Uso la versione precedente registrata da update.sh"
else
  TARGET_SHA="$(git rev-parse 'HEAD~1')"
  warn "Nessuno stato di deploy trovato: uso HEAD~1."
fi

TARGET_SHORT="$(git rev-parse --short "$TARGET_SHA")"

[[ "$CURRENT_SHA" != "$TARGET_SHA" ]] || die "Sei già su ${TARGET_SHORT}."

printf '\n  %s  ->  %s%s%s\n\n' "$CURRENT_SHORT" "$C_BOLD" "$TARGET_SHORT" "$C_RESET"
printf '  Commit che verranno annullati:\n'
git --no-pager log --oneline --no-decorate "${TARGET_SHA}..${CURRENT_SHA}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# Conferma
# ---------------------------------------------------------------------------
if [[ "$ASSUME_YES" != "true" ]]; then
  printf '\n'
  if [[ -n "$RESTORE_DB" ]]; then
    warn "Verrà ripristinato anche il DATABASE da: $(basename "$RESTORE_DB")"
    warn "TUTTI i dati creati dopo quel backup andranno persi in modo definitivo."
    read -rp "Scrivi RIPRISTINA per confermare: " confirm
    [[ "$confirm" == "RIPRISTINA" ]] || die "Annullato."
  else
    read -rp "Procedere con il rollback del codice? [s/N] " confirm
    [[ "$confirm" =~ ^[sSyY]$ ]] || die "Annullato."
  fi
fi

# ---------------------------------------------------------------------------
# Backup di sicurezza dello stato attuale
# ---------------------------------------------------------------------------
step "Backup dello stato attuale"

mkdir -p "$BACKUP_DIR"
SAFETY_BACKUP="${BACKUP_DIR}/pre-rollback-$(date +%Y%m%d-%H%M%S)-${CURRENT_SHORT}.sql.gz"

# Anche quando si torna indietro conviene salvare lo stato presente: se il
# rollback si rivela l'errore, senza questo dump non c'è modo di tornare avanti.
#
# `pg_dump` legge `PGPASSWORD`, non `POSTGRES_PASSWORD` — vedi lo stesso
# commento in `update.sh`.
if compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -d growmy --clean --if-exists' \
    | gzip -9 > "$SAFETY_BACKUP" 2>/dev/null; then
  ok "Stato attuale salvato: $(basename "$SAFETY_BACKUP")"
else
  rm -f "$SAFETY_BACKUP"
  warn "Backup di sicurezza non riuscito. Si prosegue comunque."
fi

# ---------------------------------------------------------------------------
# Rollback del codice
# ---------------------------------------------------------------------------
step "Ripristino del codice"

git checkout --force "$TARGET_SHA" --quiet
ok "Codice a ${TARGET_SHORT}"

export IMAGE_TAG="$TARGET_SHORT"

# Se l'immagine di quel commit esiste ancora, si riparte in pochi secondi.
if docker image inspect "growmy-web:${TARGET_SHORT}" >/dev/null 2>&1; then
  ok "Immagine growmy-web:${TARGET_SHORT} già presente: nessun build necessario"
else
  log "Immagine assente: ricostruzione da sorgente"
  compose build web worker
fi

# ---------------------------------------------------------------------------
# Ripristino del database (opzionale)
# ---------------------------------------------------------------------------
if [[ -n "$RESTORE_DB" ]]; then
  step "Ripristino del database"

  [[ -f "$RESTORE_DB" ]] || die "File di backup non trovato: ${RESTORE_DB}"

  # Un dump gzip valido inizia con i magic bytes 1f 8b. Controllarlo prima
  # evita di svuotare il database per poi scoprire che il file era corrotto.
  gzip -t "$RESTORE_DB" 2>/dev/null || die "Il backup è corrotto o non è un file gzip."

  log "Arresto di web e worker per evitare scritture durante il ripristino"
  compose stop web worker

  log "Ripristino in corso (può richiedere alcuni minuti)"
  # `psql` legge `PGPASSWORD`, non `POSTGRES_PASSWORD` — vedi lo stesso
  # commento in `update.sh`. Lo stdin (il dump decompresso) passa comunque
  # attraverso `sh -c` fino a `psql` senza differenze.
  if gunzip -c "$RESTORE_DB" | compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d growmy -v ON_ERROR_STOP=1' >/dev/null; then
    ok "Database ripristinato da $(basename "$RESTORE_DB")"
  else
    die "Ripristino fallito. Il database potrebbe essere in uno stato incoerente: intervieni a mano."
  fi
fi

# ---------------------------------------------------------------------------
# Riavvio
# ---------------------------------------------------------------------------
step "Riavvio dei servizi"

compose up -d --remove-orphans --wait --wait-timeout 120 || true

log "Verifica di prontezza"
ELAPSED=0
READY="false"

while (( ELAPSED < HEALTH_TIMEOUT )); do
  if curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ready"'; then
    READY="true"
    break
  fi
  sleep 5
  ELAPSED=$(( ELAPSED + 5 ))
  printf '       %ss…\r' "$ELAPSED"
done
printf '\n'

if [[ "$READY" != "true" ]]; then
  warn "Il servizio non è tornato pronto entro ${HEALTH_TIMEOUT}s."
  compose logs --tail 40 web >&2 || true
  die "Rollback applicato ma il servizio non risponde. Serve un intervento manuale."
fi

ok "Servizio operativo"

# Lo stato di deploy non è più valido: rimuoverlo evita che un rollback
# successivo torni a una versione sbagliata.
rm -f "$STATE_FILE"

step "Rollback completato"

cat <<EOF

  Versione attiva  ${C_BOLD}${TARGET_SHORT}${C_RESET}
  Stato salvato    $( [[ -f "$SAFETY_BACKUP" ]] && basename "$SAFETY_BACKUP" || echo 'non disponibile' )

  Per tornare avanti, quando il problema è risolto:
    ./scripts/update.sh --ref ${CURRENT_SHORT}

EOF

ok "Fatto."
