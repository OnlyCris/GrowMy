#!/usr/bin/env bash
#
# GrowMy — installazione completa end-to-end
#
# Un solo script, dall'inizio alla fine: prerequisiti, codice, segreti,
# certificato TLS, blocco Caddy, build, migrazioni, avvio e verifica.
#
# PENSATO PER UN SERVER GIÀ IN USO. Su questa macchina gira già una Caddy
# sull'host che serve mproc.menuisland.it con certificati certbot. Lo script è
# ADDITIVO e non distruttivo:
#   - NON tocca il blocco Caddy di mproc;
#   - NON resetta firewall, SSH o certbot;
#   - aggiunge blog.menuisland.it accanto a ciò che esiste già;
#   - configura il rinnovo automatico dei certificati per ENTRAMBI i domini.
#
# È idempotente: rieseguirlo aggiorna l'installazione senza duplicare nulla.
#
# Uso:
#   sudo bash install-server.sh \
#     --domain blog.menuisland.it \
#     --email tu@menuisland.it \
#     --repo https://github.com/<tuo-utente>/growmy.git
#
# Opzioni:
#   --domain <fqdn>     Dominio di questa app          (default: blog.menuisland.it)
#   --email <indirizzo> Email per certbot              (obbligatoria al primo giro)
#   --repo <url>        Repository git da clonare
#   --branch <nome>     Branch                         (default: main)
#   --app-port <porta>  Porta locale dell'app          (default: 3000)
#   --seed              Popola dati demo dopo il primo avvio
#   --skip-build        Non ricostruisce le immagini (solo riconfigura Caddy/cert)
#   --help
#
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Configurazione
# ---------------------------------------------------------------------------
DEPLOY_USER="${DEPLOY_USER:-growmy}"
APP_DIR="${APP_DIR:-/opt/growmy}"
DATA_DIR="${DATA_DIR:-/var/lib/growmy}"
COMPOSE_FILE_REL="docker/docker-compose.yml"

CADDY_SITES_DIR="/etc/caddy/sites"
CADDY_MAIN="/etc/caddy/Caddyfile"
CADDY_WEBROOT="/var/www/certbot"
CADDY_RENEWAL_HOOK="/etc/letsencrypt/renewal-hooks/deploy/reload-caddy.sh"

DOMAIN="blog.menuisland.it"
ADMIN_EMAIL=""
REPO_URL=""
BRANCH="main"
APP_PORT="3000"
DO_SEED="false"
SKIP_BUILD="false"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
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

trap 'die "Interrotto alla riga $LINENO (comando: ${BASH_COMMAND})"' ERR

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

# ---------------------------------------------------------------------------
# Argomenti
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)     DOMAIN="${2:-}";      shift 2 ;;
    --email)      ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --repo)       REPO_URL="${2:-}";    shift 2 ;;
    --branch)     BRANCH="${2:-}";      shift 2 ;;
    --app-port)   APP_PORT="${2:-}";    shift 2 ;;
    --seed)       DO_SEED="true";       shift ;;
    --skip-build) SKIP_BUILD="true";    shift ;;
    --help|-h)    usage ;;
    *)            die "Opzione sconosciuta: $1 (usa --help)" ;;
  esac
done

COMPOSE_FILE="${APP_DIR}/${COMPOSE_FILE_REL}"

# ---------------------------------------------------------------------------
# 0. Verifiche preliminari
# ---------------------------------------------------------------------------
step "Verifiche preliminari"

[[ $EUID -eq 0 ]] || die "Esegui come root: sudo bash $0 ..."
[[ -f /etc/debian_version ]] || die "Script specifico per Debian/Ubuntu."
[[ -n "$DOMAIN" ]] || die "--domain è obbligatorio."

export DEBIAN_FRONTEND=noninteractive

# Strumenti di base che diamo per scontati più avanti.
if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git jq openssl gnupg
fi

# Docker: se manca, lo installiamo dal repository ufficiale. Uno script
# "completo" non può fermarsi qui — è la prima cosa che serve.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker già presente: $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
else
  log "Docker non trovato: installazione dal repository ufficiale"
  install -m 0755 -d /etc/apt/keyrings

  # Debian e Ubuntu hanno percorsi di repository diversi: rileviamo quale.
  DOCKER_OS="debian"
  grep -qi ubuntu /etc/os-release && DOCKER_OS="ubuntu"

  curl -fsSL "https://download.docker.com/linux/${DOCKER_OS}/gpg" \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${DOCKER_OS} $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker >/dev/null 2>&1 || true

  command -v docker >/dev/null 2>&1 \
    || die "Installazione di Docker fallita. Controlla la connessione e riprova."
  ok "Docker installato: $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
fi

# Il DNS del dominio deve puntare a questo server, altrimenti certbot fallisce e
# consuma uno dei tentativi orari del rate limit di Let's Encrypt.
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo '')"
if [[ -n "$RESOLVED" && -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
  warn "${DOMAIN} risolve a ${RESOLVED} ma questo server è ${PUBLIC_IP}."
  warn "Correggi il record DNS prima di procedere, o l'emissione del certificato fallirà."
  read -rp "Continuo comunque? [s/N] " ans
  [[ "$ans" =~ ^[sSyY]$ ]] || die "Interrotto: sistema il DNS e riprova."
fi

# ---------------------------------------------------------------------------
# 1. Caddy sull'host
# ---------------------------------------------------------------------------
step "Caddy (host)"

if command -v caddy >/dev/null 2>&1; then
  ok "Caddy già presente: $(caddy version | head -1)"
else
  # Non ci aspettiamo di installarlo (mproc gira già), ma gestiamo il caso.
  log "Caddy non trovato: installazione dal repository ufficiale"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  ok "Caddy installato"
fi

# La directory dei siti importati e il webroot per le sfide ACME.
install -d -m 0755 "$CADDY_SITES_DIR"
install -d -m 0755 -o caddy -g caddy "$CADDY_WEBROOT" 2>/dev/null \
  || install -d -m 0755 "$CADDY_WEBROOT"
# Caddy scrive i log come utente `caddy`: la cartella deve appartenergli.
install -d -m 0755 -o caddy -g caddy /var/log/caddy 2>/dev/null \
  || install -d -m 0755 /var/log/caddy

# Assicura che il Caddyfile principale importi la cartella dei siti.
# Lo facciamo con un marcatore, senza toccare il blocco esistente di mproc.
if [[ -f "$CADDY_MAIN" ]] && grep -q "import sites/\*.caddy" "$CADDY_MAIN"; then
  ok "Il Caddyfile importa già sites/*.caddy"
else
  {
    echo ""
    echo "# >>> aggiunto da growmy install-server.sh >>>"
    echo "import sites/*.caddy"
    echo "# <<< growmy <<<"
  } >> "$CADDY_MAIN"
  ok "Aggiunto 'import sites/*.caddy' al Caddyfile (blocco mproc intatto)"
fi

# ---------------------------------------------------------------------------
# 2. Codice sorgente
# ---------------------------------------------------------------------------
step "Codice sorgente"

# Utente di deploy (se non esiste già, per esempio se hai usato install.sh).
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --system --group --shell /bin/bash \
          --home "/home/${DEPLOY_USER}" --disabled-password "$DEPLOY_USER"
  usermod -aG docker "$DEPLOY_USER"
  ok "Utente ${DEPLOY_USER} creato"
fi

install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
  "${DATA_DIR}/postgres" "${DATA_DIR}/redis" "${DATA_DIR}/uploads"

if [[ -d "${APP_DIR}/.git" ]]; then
  log "Aggiornamento del repository"
  sudo -u "$DEPLOY_USER" git -C "$APP_DIR" fetch --all --prune --quiet
  sudo -u "$DEPLOY_USER" git -C "$APP_DIR" checkout "$BRANCH" --quiet
  sudo -u "$DEPLOY_USER" git -C "$APP_DIR" pull --ff-only --quiet
elif [[ -n "$REPO_URL" ]]; then
  sudo -u "$DEPLOY_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  die "Repository non presente in ${APP_DIR} e --repo non fornito."
fi
chmod +x "${APP_DIR}"/scripts/*.sh 2>/dev/null || true
ok "Codice pronto in ${APP_DIR} (branch ${BRANCH})"

# ---------------------------------------------------------------------------
# 3. File di ambiente e segreti
# ---------------------------------------------------------------------------
step "Ambiente"

ENV_FILE="${APP_DIR}/.env"

if [[ -f "$ENV_FILE" ]]; then
  ok ".env già presente: non viene toccato"
else
  cp "${APP_DIR}/.env.example" "$ENV_FILE" 2>/dev/null || touch "$ENV_FILE"

  set_var() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$ENV_FILE"; then
      # Delimitatore | perché i valori base64 contengono /
      sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
      echo "${key}=${value}" >> "$ENV_FILE"
    fi
  }

  set_var POSTGRES_PASSWORD          "$(openssl rand -hex 32)"
  set_var POSTGRES_WORKER_PASSWORD   "$(openssl rand -hex 32)"
  set_var POSTGRES_MIGRATOR_PASSWORD "$(openssl rand -hex 32)"
  set_var CSRF_SECRET                "$(openssl rand -hex 32)"
  set_var WEBHOOK_SIGNING_SECRET     "$(openssl rand -hex 32)"
  set_var CREDENTIALS_ENCRYPTION_KEY "$(openssl rand -base64 32)"
  set_var NEXT_PUBLIC_APP_URL        "https://${DOMAIN}"

  chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"

  ok "Creato ${ENV_FILE} con i segreti generati"
  warn "Compila le chiavi dei servizi esterni PRIMA di riavviare:"
  warn "  GOOGLE_GENERATIVE_AI_API_KEY, SUPABASE_*, STRIPE_*, GOOGLE_CLIENT_*"
  warn "  sudo -u ${DEPLOY_USER} nano ${ENV_FILE}"
fi

# ---------------------------------------------------------------------------
# 4. Certificato TLS (certbot, webroot via Caddy)
# ---------------------------------------------------------------------------
step "Certificato TLS"

command -v certbot >/dev/null 2>&1 || { apt-get install -y -qq certbot; }

if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
  ok "Certificato già presente per ${DOMAIN}"
else
  [[ -n "$ADMIN_EMAIL" ]] || die "--email è obbligatorio per emettere il certificato."

  # Chicken-and-egg: il blocco HTTPS referenzia file di certificato che non
  # esistono ancora. Quindi PRIMA installiamo solo il blocco http:// che serve
  # la sfida ACME, poi emettiamo il certificato, poi il blocco completo.
  log "Configurazione temporanea per la sfida ACME"
  cat > "${CADDY_SITES_DIR}/${DOMAIN}.caddy" <<EOF
http://${DOMAIN} {
	handle /.well-known/acme-challenge/* {
		root * ${CADDY_WEBROOT}
		file_server
	}
	handle {
		respond "In allestimento" 200
	}
}
EOF
  caddy validate --config "$CADDY_MAIN" --adapter caddyfile >/dev/null 2>&1 \
    || die "Configurazione Caddy non valida dopo l'aggiunta del blocco temporaneo."
  systemctl reload caddy
  ok "Caddy pronto a servire la sfida ACME"

  log "Emissione del certificato via webroot"
  certbot certonly --webroot -w "$CADDY_WEBROOT" \
    --non-interactive --agree-tos --email "$ADMIN_EMAIL" \
    -d "$DOMAIN" --key-type ecdsa \
    || die "Emissione del certificato fallita. Verifica DNS e porta 80."
  ok "Certificato emesso per ${DOMAIN}"
fi

# ---------------------------------------------------------------------------
# 5. Blocco Caddy definitivo
# ---------------------------------------------------------------------------
step "Configurazione Caddy per ${DOMAIN}"

# Copia il blocco versionato nel repo, così è manutenibile via git.
if [[ -f "${APP_DIR}/docker/caddy/${DOMAIN}.caddy" ]]; then
  cp "${APP_DIR}/docker/caddy/${DOMAIN}.caddy" "${CADDY_SITES_DIR}/${DOMAIN}.caddy"
else
  # Fallback: genera il blocco se il file versionato non c'è (dominio diverso
  # dal default). Usa APP_PORT per il reverse proxy.
  cat > "${CADDY_SITES_DIR}/${DOMAIN}.caddy" <<EOF
http://${DOMAIN} {
	handle /.well-known/acme-challenge/* {
		root * ${CADDY_WEBROOT}
		file_server
	}
	handle {
		redir https://{host}{uri} permanent
	}
}

${DOMAIN} {
	tls /etc/letsencrypt/live/${DOMAIN}/fullchain.pem /etc/letsencrypt/live/${DOMAIN}/privkey.pem
	encode zstd gzip
	header -Server
	handle /api/health { respond 404 }
	handle /api/ready  { respond 404 }
	handle {
		reverse_proxy 127.0.0.1:${APP_PORT}
	}
}
EOF
fi

caddy validate --config "$CADDY_MAIN" --adapter caddyfile >/dev/null 2>&1 \
  || die "Configurazione Caddy non valida. Il blocco di mproc NON è stato toccato."
systemctl reload caddy
ok "Caddy ricaricato (blog + mproc serviti dallo stesso processo)"

# ---------------------------------------------------------------------------
# 6. Rinnovo automatico per ENTRAMBI i domini
# ---------------------------------------------------------------------------
step "Rinnovo automatico dei certificati"

# certbot rinnova TUTTI i certificati che gestisce — blog E mproc — tramite il
# suo timer systemd. L'unico pezzo che di solito manca è ricaricare Caddy dopo
# il rinnovo: un deploy-hook GLOBALE risolve per entrambi in un colpo solo.
install -d -m 0755 "$(dirname "$CADDY_RENEWAL_HOOK")"
cat > "$CADDY_RENEWAL_HOOK" <<'EOF'
#!/usr/bin/env bash
# Ricarica Caddy dopo il rinnovo di un QUALSIASI certificato.
# Eseguito automaticamente da certbot dopo ogni rinnovo andato a buon fine.
# `reload` non interrompe le connessioni in corso.
systemctl reload caddy
EOF
chmod +x "$CADDY_RENEWAL_HOOK"
ok "Deploy-hook installato: ${CADDY_RENEWAL_HOOK}"

# Il pacchetto certbot di Debian installa già certbot.timer. Ci assicuriamo
# solo che sia attivo.
if systemctl list-unit-files | grep -q '^certbot.timer'; then
  systemctl enable --now certbot.timer >/dev/null 2>&1 || true
  ok "certbot.timer attivo (rinnovo controllato due volte al giorno)"
else
  # Fallback: cron, se il timer non c'è.
  cat > /etc/cron.d/growmy-certbot <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3,15 * * * root certbot renew --quiet
EOF
  ok "Rinnovo pianificato via cron (il timer systemd non era disponibile)"
fi

# Verifica a secco che il rinnovo funzioni per entrambi, senza emettere nulla.
log "Prova a secco del rinnovo (nessun certificato viene toccato)"
if certbot renew --dry-run >/dev/null 2>&1; then
  ok "Rinnovo a secco riuscito per tutti i domini gestiti (blog + mproc)"
else
  warn "La prova a secco del rinnovo ha segnalato problemi. Controlla:"
  warn "  certbot renew --dry-run"
fi

# ---------------------------------------------------------------------------
# 7. Build e avvio
# ---------------------------------------------------------------------------
if [[ "$SKIP_BUILD" == "true" ]]; then
  step "Build saltato (--skip-build)"
else
  step "Build e avvio dei container"

  cd "$APP_DIR"
  # Le migrazioni girano nel container web: il build deve precedere.
  sudo -u "$DEPLOY_USER" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build web worker
  ok "Immagini costruite"

  sudo -u "$DEPLOY_USER" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans \
    postgres redis
  log "Attendo che il database sia pronto"
  sleep 6

  # Migrazioni Drizzle + funzioni SQL scritte a mano (app_enqueue_job, ecc.).
  log "Applicazione dello schema e delle funzioni"
  sudo -u "$DEPLOY_USER" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
    -e DATABASE_MIGRATION_URL="postgres://app_migrator:$(grep '^POSTGRES_MIGRATOR_PASSWORD=' "$ENV_FILE" | cut -d= -f2)@postgres:5432/growmy" \
    web sh -c "npx drizzle-kit migrate --config=packages/db/drizzle.config.ts" \
    || warn "Migrazioni: verifica manuale consigliata."

  # Le policy RLS e le funzioni richiedono i ruoli app_*: applicate col superuser.
  for sqlfile in 0001_rls_policies.sql 0002_deferred_constraints.sql 0003_enqueue_job.sql; do
    if [[ -f "${APP_DIR}/packages/db/migrations/sql/${sqlfile}" ]]; then
      sudo -u "$DEPLOY_USER" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
        psql -U postgres -d growmy -v ON_ERROR_STOP=1 \
        < "${APP_DIR}/packages/db/migrations/sql/${sqlfile}" >/dev/null 2>&1 \
        && ok "Applicato ${sqlfile}" \
        || warn "${sqlfile}: alcune istruzioni potrebbero essere già presenti (normale al re-run)."
    fi
  done

  if [[ "$DO_SEED" == "true" ]]; then
    log "Popolamento dati demo"
    sudo -u "$DEPLOY_USER" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
      web sh -c "pnpm --filter @growmy/db seed" || warn "Seed non riuscito."
  fi

  log "Avvio di web e worker"
  sudo -u "$DEPLOY_USER" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans
  ok "Container avviati"
fi

# ---------------------------------------------------------------------------
# 8. Verifica
# ---------------------------------------------------------------------------
step "Verifica"

log "Attendo che l'app diventi pronta"
READY="false"
for i in $(seq 1 24); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${APP_PORT}/api/ready" 2>/dev/null | grep -q '"status":"ready"'; then
    READY="true"; break
  fi
  sleep 5
done

if [[ "$READY" == "true" ]]; then
  ok "App pronta su 127.0.0.1:${APP_PORT}"
else
  warn "L'app non risponde ancora. Log:"
  warn "  docker compose -f ${COMPOSE_FILE} logs --tail 40 web"
fi

# Verifica end-to-end passando dalla Caddy e dal TLS reale.
if curl -fsS --max-time 10 "https://${DOMAIN}/api/health" >/dev/null 2>&1; then
  ok "Health raggiungibile via https://${DOMAIN} — ma dovrebbe dare 404"
elif curl -fsSk --max-time 10 "https://${DOMAIN}" >/dev/null 2>&1; then
  ok "https://${DOMAIN} risponde attraverso Caddy con TLS valido"
else
  warn "https://${DOMAIN} non risponde ancora. Verifica DNS, certificato e Caddy."
fi

# ---------------------------------------------------------------------------
# Riepilogo
# ---------------------------------------------------------------------------
step "Installazione completata"

cat <<EOF

  ${C_BOLD}Stato${C_RESET}

    App                 https://${DOMAIN}
    Porta locale        127.0.0.1:${APP_PORT}  (non esposta a internet)
    Reverse proxy       Caddy sull'host  (condiviso con mproc.menuisland.it)
    Certificato         certbot · rinnovo automatico attivo per ENTRAMBI i domini
    Deploy-hook         ${CADDY_RENEWAL_HOOK}
    Codice              ${APP_DIR}
    Segreti             ${APP_DIR}/.env

  ${C_BOLD}Comandi utili${C_RESET}

    Log app             docker compose -f ${COMPOSE_FILE} logs -f web worker
    Aggiornare          ${APP_DIR}/scripts/update.sh
    Ricaricare Caddy    systemctl reload caddy
    Stato certificati   certbot certificates
    Test rinnovo        certbot renew --dry-run

EOF

if ! grep -q '^SUPABASE_SERVICE_ROLE_KEY=.\{20\}' "$ENV_FILE" 2>/dev/null; then
  warn "Ricorda di compilare le chiavi dei servizi esterni in ${ENV_FILE}"
  warn "e poi riavviare:  docker compose -f ${COMPOSE_FILE} up -d"
fi

ok "Fatto."
