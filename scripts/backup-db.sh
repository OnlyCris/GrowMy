#!/usr/bin/env bash
#
# GrowMy — backup del database
#
# Eseguito ogni notte alle 03:15 dal cron installato da install.sh, e a mano
# prima di ogni aggiornamento da update.sh.
#
# Politica di retention:
#   - backup giornalieri: 14 giorni
#   - backup settimanali (domenica): 8 settimane
#   - backup mensili (primo del mese): 12 mesi
#
# Un backup mai verificato non è un backup. Dopo ogni dump lo script controlla
# integrità gzip e presenza delle tabelle principali: se il dump è vuoto o
# corrotto lo scopri stanotte, non il giorno in cui ti serve.
#
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/growmy}"
COMPOSE_FILE="${APP_DIR}/docker/docker-compose.yml"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/growmy}"

DAILY_DIR="${BACKUP_DIR}/daily"
WEEKLY_DIR="${BACKUP_DIR}/weekly"
MONTHLY_DIR="${BACKUP_DIR}/monthly"

KEEP_DAILY_DAYS=14
KEEP_WEEKLY_DAYS=56
KEEP_MONTHLY_DAYS=365

# Soglia sotto la quale un dump è quasi certamente vuoto per un errore.
MIN_SIZE_BYTES=10240

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DAY_OF_WEEK="$(date +%u)"   # 7 = domenica
DAY_OF_MONTH="$(date +%d)"

log()  { printf '[%s] %s\n' "$(date -Iseconds)" "$*"; }
die()  { printf '[%s] ERRORE: %s\n' "$(date -Iseconds)" "$*" >&2; exit 1; }

# `--env-file` esplicito: Docker Compose cerca `.env` accanto al FILE COMPOSE
# (cioè in docker/), non nella root del progetto dove sta davvero. Senza questo
# flag tutte le variabili risultano vuote e i container partono senza segreti.
compose() { docker compose --env-file "${APP_DIR}/.env" -f "$COMPOSE_FILE" "$@"; }

# ---------------------------------------------------------------------------
# Preparazione
# ---------------------------------------------------------------------------
[[ -f "$COMPOSE_FILE" ]] || die "docker-compose.yml non trovato in ${COMPOSE_FILE}"

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR" "$MONTHLY_DIR"
chmod 0700 "$BACKUP_DIR" "$DAILY_DIR" "$WEEKLY_DIR" "$MONTHLY_DIR"

# Se il container Postgres non è in esecuzione non c'è nulla da salvare, ed è
# un fatto che merita di finire nei log invece di passare inosservato.
if ! compose ps postgres --status running --quiet | grep -q .; then
  die "Il container postgres non è in esecuzione: backup impossibile."
fi

# Un secondo backup avviato mentre il primo è in corso raddoppia il carico
# sul database senza produrre nulla di utile.
LOCK_FILE="/tmp/growmy-backup.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || die "Un altro backup è già in corso."

# ---------------------------------------------------------------------------
# Dump
# ---------------------------------------------------------------------------
TARGET="${DAILY_DIR}/growmy-${TIMESTAMP}.sql.gz"
TEMP="${TARGET}.partial"

log "Avvio del dump verso $(basename "$TARGET")"

# `--clean --if-exists`: ripristinabile su un database esistente.
# `--no-owner --no-privileges`: il ripristino non richiede gli stessi ruoli,
# utile per rimontare un backup di produzione su una macchina di staging.
if ! compose exec -T postgres pg_dump \
      -U postgres -d growmy \
      --clean --if-exists --no-owner --no-privileges \
      --exclude-table-data='rate_limit_violations' \
      --exclude-table-data='job_events' \
      | gzip -9 > "$TEMP"; then
  rm -f "$TEMP"
  die "pg_dump fallito."
fi

# Il file assume il nome definitivo solo dopo un dump riuscito: così una
# interruzione a metà non lascia in giro un backup apparentemente valido.
mv "$TEMP" "$TARGET"
chmod 0600 "$TARGET"

SIZE_BYTES="$(stat -c%s "$TARGET")"
SIZE_HUMAN="$(du -h "$TARGET" | cut -f1)"
log "Dump completato: ${SIZE_HUMAN}"

# ---------------------------------------------------------------------------
# Verifica
# ---------------------------------------------------------------------------
log "Verifica del backup"

(( SIZE_BYTES >= MIN_SIZE_BYTES )) \
  || die "Il dump è di soli ${SIZE_BYTES} byte: quasi certamente vuoto."

gzip -t "$TARGET" 2>/dev/null \
  || die "Archivio gzip corrotto."

# Le tabelle che DEVONO esserci. Un dump che non le contiene è tecnicamente
# valido ma inutile — tipicamente il sintomo di un dump del database sbagliato.
for table in organizations products articles credit_ledger; do
  gunzip -c "$TARGET" | grep -q "CREATE TABLE public.${table}" \
    || die "Tabella «${table}» assente dal dump."
done

log "Verifica superata: struttura e integrità corrette"

# ---------------------------------------------------------------------------
# Copie settimanali e mensili
# ---------------------------------------------------------------------------
if [[ "$DAY_OF_WEEK" == "7" ]]; then
  cp "$TARGET" "${WEEKLY_DIR}/$(basename "$TARGET")"
  log "Copia settimanale creata"
fi

if [[ "$DAY_OF_MONTH" == "01" ]]; then
  cp "$TARGET" "${MONTHLY_DIR}/$(basename "$TARGET")"
  log "Copia mensile creata"
fi

# ---------------------------------------------------------------------------
# Pulizia
# ---------------------------------------------------------------------------
DELETED=0
for spec in "${DAILY_DIR}:${KEEP_DAILY_DAYS}" \
            "${WEEKLY_DIR}:${KEEP_WEEKLY_DAYS}" \
            "${MONTHLY_DIR}:${KEEP_MONTHLY_DAYS}"; do
  dir="${spec%%:*}"
  days="${spec##*:}"
  count="$(find "$dir" -name '*.sql.gz' -mtime "+${days}" -print -delete 2>/dev/null | wc -l)"
  DELETED=$(( DELETED + count ))
done

(( DELETED > 0 )) && log "Rimossi ${DELETED} backup scaduti"

# ---------------------------------------------------------------------------
# Avviso sullo spazio disco
# ---------------------------------------------------------------------------
DISK_USED_PCT="$(df --output=pcent "$BACKUP_DIR" | tail -1 | tr -dc '0-9')"
if (( DISK_USED_PCT > 85 )); then
  log "ATTENZIONE: disco al ${DISK_USED_PCT}%. Riduci la retention o aggiungi spazio."
fi

TOTAL_SIZE="$(du -sh "$BACKUP_DIR" | cut -f1)"
TOTAL_COUNT="$(find "$BACKUP_DIR" -name '*.sql.gz' | wc -l)"

log "Backup completato — ${TOTAL_COUNT} archivi, ${TOTAL_SIZE} totali, disco al ${DISK_USED_PCT}%"

# ---------------------------------------------------------------------------
# Promemoria sul backup fuori sede
# ---------------------------------------------------------------------------
# Un backup che vive sullo stesso disco del database non protegge dal guasto
# del disco. Se hai configurato rclone, questo è il punto in cui sincronizzare.
if command -v rclone >/dev/null 2>&1 && [[ -n "${RCLONE_REMOTE:-}" ]]; then
  log "Sincronizzazione fuori sede verso ${RCLONE_REMOTE}"
  rclone sync "$BACKUP_DIR" "${RCLONE_REMOTE}" --transfers 2 --quiet \
    && log "Sincronizzazione completata" \
    || log "ATTENZIONE: sincronizzazione fuori sede fallita."
else
  log "Nota: nessuna copia fuori sede configurata (imposta RCLONE_REMOTE)."
fi
