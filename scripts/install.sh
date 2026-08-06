#!/usr/bin/env bash
#
# GrowMy — provisioning del server (Debian 12 "bookworm" / Debian 13 "trixie")
#
# Prepara una VPS pulita a ospitare lo stack: hardening del sistema, Docker,
# utente di deploy non privilegiato, firewall, swap, unità systemd.
#
# CARATTERISTICA PRINCIPALE: è IDEMPOTENTE. Rieseguirlo su un server già
# provisionato non rompe nulla e non duplica nulla — ogni passo verifica lo
# stato prima di agire. Serve a poter riparare un server derivato senza doverlo
# ricreare da zero.
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/<org>/growmy/main/scripts/install.sh -o install.sh
#   sudo bash install.sh --domain growmy.example.com --email admin@example.com
#
# Opzioni:
#   --domain <fqdn>        Dominio pubblico (obbligatorio per TLS)
#   --email <indirizzo>    Email per Let's Encrypt e avvisi
#   --repo <url>           Repository git da clonare
#   --branch <nome>        Branch da usare (default: main)
#   --ssh-port <porta>     Porta SSH da configurare (default: 22)
#   --skip-tls             Salta l'emissione del certificato (utile in staging)
#   --help
#
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Configurazione
# ---------------------------------------------------------------------------
DEPLOY_USER="growmy"
APP_DIR="/opt/growmy"
DATA_DIR="/var/lib/growmy"
LOG_DIR="/var/log/growmy"
BACKUP_DIR="/var/backups/growmy"

DOMAIN=""
ADMIN_EMAIL=""
REPO_URL=""
BRANCH="main"
SSH_PORT="22"
SKIP_TLS="false"

readonly REQUIRED_DEBIAN_MAJOR=12

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

log()   { printf '%s[ .. ]%s %s\n' "$C_BLUE"   "$C_RESET" "$*"; }
ok()    { printf '%s[ ok ]%s %s\n' "$C_GREEN"  "$C_RESET" "$*"; }
warn()  { printf '%s[ !! ]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()   { printf '%s[fail]%s %s\n' "$C_RED"    "$C_RESET" "$*" >&2; exit 1; }
step()  { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

# Su errore diciamo QUALE riga ha fallito: senza questo, il debug di uno
# script di provisioning su una macchina remota è una caccia al tesoro.
trap 'die "Interrotto alla riga $LINENO (comando: ${BASH_COMMAND})"' ERR

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

# ---------------------------------------------------------------------------
# Parsing argomenti
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)    DOMAIN="${2:-}";       shift 2 ;;
    --email)     ADMIN_EMAIL="${2:-}";  shift 2 ;;
    --repo)      REPO_URL="${2:-}";     shift 2 ;;
    --branch)    BRANCH="${2:-}";       shift 2 ;;
    --ssh-port)  SSH_PORT="${2:-}";     shift 2 ;;
    --skip-tls)  SKIP_TLS="true";       shift ;;
    --help|-h)   usage ;;
    *)           die "Opzione sconosciuta: $1 (usa --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Verifiche preliminari
# ---------------------------------------------------------------------------
step "Verifiche preliminari"

[[ $EUID -eq 0 ]] || die "Esegui come root: sudo bash $0 ..."

[[ -f /etc/debian_version ]] || die "Questo script è specifico per Debian."

DEBIAN_MAJOR="$(cut -d. -f1 /etc/debian_version | tr -d '[:space:]')"
if [[ "$DEBIAN_MAJOR" =~ ^[0-9]+$ ]] && (( DEBIAN_MAJOR < REQUIRED_DEBIAN_MAJOR )); then
  die "Serve Debian ${REQUIRED_DEBIAN_MAJOR} o superiore (trovata: $(cat /etc/debian_version))."
fi

ARCH="$(dpkg --print-architecture)"
[[ "$ARCH" == "amd64" || "$ARCH" == "arm64" ]] \
  || die "Architettura non supportata: $ARCH"

if [[ "$SKIP_TLS" == "false" ]]; then
  [[ -n "$DOMAIN" ]]      || die "--domain è obbligatorio (oppure usa --skip-tls)."
  [[ -n "$ADMIN_EMAIL" ]] || die "--email è obbligatorio (oppure usa --skip-tls)."
fi

# Meno di 2 GB di RAM: l'immagine Next.js non si compila e Postgres soffre.
TOTAL_MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
(( TOTAL_MEM_MB >= 1800 )) || warn "RAM rilevata: ${TOTAL_MEM_MB} MB. Consigliati almeno 4 GB."

FREE_DISK_GB="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
(( FREE_DISK_GB >= 20 )) || warn "Spazio libero: ${FREE_DISK_GB} GB. Consigliati almeno 40 GB."

ok "Debian $(cat /etc/debian_version) · ${ARCH} · ${TOTAL_MEM_MB} MB RAM · ${FREE_DISK_GB} GB liberi"

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# 1. Pacchetti di base
# ---------------------------------------------------------------------------
step "Pacchetti di sistema"

log "Aggiornamento indice APT"
apt-get update -qq

log "Aggiornamento pacchetti installati"
apt-get upgrade -y -qq

# `--no-install-recommends`: meno pacchetti installati significa meno superficie
# di attacco e meno aggiornamenti da gestire nel tempo.
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg lsb-release \
  git jq unzip \
  ufw fail2ban unattended-upgrades apt-listchanges \
  htop ncdu \
  postgresql-client-15 \
  rsync cron logrotate

ok "Pacchetti installati"

# ---------------------------------------------------------------------------
# 2. Aggiornamenti di sicurezza automatici
# ---------------------------------------------------------------------------
step "Aggiornamenti di sicurezza automatici"

# Solo la suite di sicurezza: gli aggiornamenti funzionali restano manuali,
# perché un upgrade non pianificato di Docker in piena notte è un incidente,
# non una feature.
cat > /etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Origins-Pattern {
    "origin=Debian,codename=${distro_codename},label=Debian-Security";
    "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::SyslogEnable "true";
EOF

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "Patch di sicurezza automatiche attive (senza riavvio automatico)"

# ---------------------------------------------------------------------------
# 3. Utente di deploy
# ---------------------------------------------------------------------------
step "Utente di deploy"

if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  ok "Utente ${DEPLOY_USER} già presente"
else
  # `--disabled-password`: l'accesso avviene solo per chiave SSH.
  adduser --system --group --shell /bin/bash \
          --home "/home/${DEPLOY_USER}" --disabled-password "$DEPLOY_USER"
  ok "Utente ${DEPLOY_USER} creato (nessuna password, solo chiave SSH)"
fi

install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"

# Se root ha già delle chiavi autorizzate le riusiamo, così chi sta eseguendo
# lo script non si chiude fuori dal server dopo l'hardening di SSH.
if [[ -f /root/.ssh/authorized_keys ]]; then
  install -m 0600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
    /root/.ssh/authorized_keys "/home/${DEPLOY_USER}/.ssh/authorized_keys"
  ok "Chiavi SSH di root copiate su ${DEPLOY_USER}"
else
  touch "/home/${DEPLOY_USER}/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh/authorized_keys"
  chmod 0600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"
  warn "Nessuna chiave SSH trovata: aggiungine una prima di disconnetterti."
fi

# sudo senza password limitato ai soli comandi di deploy. Un sudo pieno
# renderebbe l'utente di deploy equivalente a root, vanificandone l'esistenza.
cat > /etc/sudoers.d/growmy-deploy <<EOF
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl start growmy, \\
                                    /usr/bin/systemctl stop growmy, \\
                                    /usr/bin/systemctl restart growmy, \\
                                    /usr/bin/systemctl status growmy, \\
                                    /usr/bin/systemctl reload nginx
EOF
chmod 0440 /etc/sudoers.d/growmy-deploy
visudo -cf /etc/sudoers.d/growmy-deploy >/dev/null || die "sudoers non valido"

ok "Privilegi di deploy circoscritti"

# ---------------------------------------------------------------------------
# 4. Docker (repository ufficiale, non quello di Debian)
# ---------------------------------------------------------------------------
step "Docker Engine"

if command -v docker >/dev/null 2>&1; then
  ok "Docker già presente: $(docker --version)"
else
  log "Installazione dal repository ufficiale Docker"

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  # `signed-by` vincola il repository alla sua chiave: senza, una chiave
  # qualsiasi nel keyring potrebbe firmare pacchetti per questa sorgente.
  cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(lsb_release -cs) stable
EOF

  apt-get update -qq
  apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

  ok "Docker installato: $(docker --version)"
fi

usermod -aG docker "$DEPLOY_USER"

# Rotazione dei log dei container. Senza, un container loquace riempie il disco
# e porta giù tutto — è il modo più comune in cui muore una VPS.
install -d -m 0755 /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true,
  "userland-proxy": false
}
EOF

systemctl enable docker >/dev/null 2>&1
systemctl restart docker
ok "Docker configurato (log ruotati, live-restore attivo)"

# ---------------------------------------------------------------------------
# 5. Struttura delle directory
# ---------------------------------------------------------------------------
step "Struttura delle directory"

install -d -m 0755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DATA_DIR" "$LOG_DIR"
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$BACKUP_DIR"
install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
  "${DATA_DIR}/postgres" "${DATA_DIR}/redis" "${DATA_DIR}/uploads"

ok "Directory create sotto ${APP_DIR} e ${DATA_DIR}"

# ---------------------------------------------------------------------------
# 6. Swap
# ---------------------------------------------------------------------------
step "Spazio di swap"

# Il criterio è la QUANTITÀ di swap, non la sua esistenza.
#
# Molte VPS arrivano con una partizione di swap simbolica (256 MB è tipico).
# Un controllo del tipo «esiste swap?» la considera sufficiente e prosegue —
# ed è esattamente così che un deploy finisce ucciso dall'OOM killer al primo
# build di Next.js, con un `signal: killed` che non spiega nulla.
RAM_MB="$(free -m | awk '/^Mem:/  {print $2}')"
SWAP_MB="$(free -m | awk '/^Swap:/ {print $2}')"

# Il picco del build Next.js sta intorno ai 2-3 GB. Su una macchina con poca
# RAM la swap deve coprire la differenza, non semplicemente esistere.
REQUIRED_SWAP_MB=4096
(( RAM_MB >= 4096 )) && REQUIRED_SWAP_MB=2048

log "RAM ${RAM_MB} MB, swap attuale ${SWAP_MB} MB, necessaria ${REQUIRED_SWAP_MB} MB"

if (( SWAP_MB >= REQUIRED_SWAP_MB )); then
  ok "Swap sufficiente (${SWAP_MB} MB)"
elif swapon --show | grep -q '^/swapfile'; then
  warn "Lo swapfile esiste ma è di soli ${SWAP_MB} MB."
  warn "Ridimensionalo a mano: swapoff /swapfile && rm /swapfile, poi rilancia questo script."
else
  # Lo swapfile si AGGIUNGE alla partizione esistente: Linux usa entrambi.
  SWAP_FILE_GB=$(( (REQUIRED_SWAP_MB - SWAP_MB + 1023) / 1024 ))
  log "Creazione di ${SWAP_FILE_GB} GB di swapfile (in aggiunta ai ${SWAP_MB} MB esistenti)"

  DISK_FREE_GB="$(df --output=avail -BG / | tail -1 | tr -dc '0-9')"
  if (( DISK_FREE_GB < SWAP_FILE_GB + 5 )); then
    die "Spazio disco insufficiente: servono ${SWAP_FILE_GB} GB per la swap più 5 GB di margine, liberi ${DISK_FREE_GB} GB."
  fi

  fallocate -l "${SWAP_FILE_GB}G" /swapfile \
    || dd if=/dev/zero of=/swapfile bs=1M count=$(( SWAP_FILE_GB * 1024 )) status=none
  chmod 0600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

  # Swappiness bassa: usa la swap come rete di sicurezza, non come RAM lenta.
  sysctl -qw vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

  ok "Swap totale $(free -m | awk '/^Swap:/ {print $2}') MB (swappiness 10)"
fi

# ---------------------------------------------------------------------------
# 7. Firewall
# ---------------------------------------------------------------------------
step "Firewall (ufw)"

ufw --force reset >/dev/null 2>&1

ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null

ufw allow "${SSH_PORT}/tcp" comment 'SSH' >/dev/null
ufw allow 80/tcp  comment 'HTTP'  >/dev/null
ufw allow 443/tcp comment 'HTTPS' >/dev/null

# Postgres e Redis NON sono esposti: vivono sulla rete interna di Docker e
# sono raggiungibili solo dai container dello stack.
ufw --force enable >/dev/null
ok "Firewall attivo: aperte solo ${SSH_PORT}, 80, 443"

# ---------------------------------------------------------------------------
# 8. fail2ban
# ---------------------------------------------------------------------------
step "Protezione brute force (fail2ban)"

cat > /etc/fail2ban/jail.local <<EOF
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd
banaction = ufw

[sshd]
enabled = true
port    = ${SSH_PORT}
maxretry = 3
bantime = 86400
EOF

systemctl enable fail2ban >/dev/null 2>&1
systemctl restart fail2ban
ok "fail2ban attivo (SSH: 3 tentativi, ban 24 ore)"

# ---------------------------------------------------------------------------
# 9. Hardening SSH
# ---------------------------------------------------------------------------
step "Hardening SSH"

# Prima di disabilitare la password verifichiamo che esista almeno una chiave:
# altrimenti lo script chiuderebbe fuori chi lo sta eseguendo.
KEY_COUNT=0
[[ -s "/home/${DEPLOY_USER}/.ssh/authorized_keys" ]] && \
  KEY_COUNT="$(grep -c '^ssh-\|^ecdsa-\|^sk-' "/home/${DEPLOY_USER}/.ssh/authorized_keys" || true)"

if (( KEY_COUNT > 0 )); then
  cat > /etc/ssh/sshd_config.d/99-growmy.conf <<EOF
Port ${SSH_PORT}
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
AllowAgentForwarding no
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers ${DEPLOY_USER}
EOF

  if sshd -t; then
    systemctl reload ssh
    ok "SSH: solo chiavi, root disabilitato, accesso limitato a ${DEPLOY_USER}"
  else
    rm -f /etc/ssh/sshd_config.d/99-growmy.conf
    warn "Configurazione SSH non valida: hardening annullato."
  fi
else
  warn "Nessuna chiave SSH per ${DEPLOY_USER}: hardening SALTATO."
  warn "Aggiungi la chiave e riesegui questo script per completarlo."
fi

# ---------------------------------------------------------------------------
# 10. Clone del repository
# ---------------------------------------------------------------------------
if [[ -n "$REPO_URL" ]]; then
  step "Codice sorgente"

  if [[ -d "${APP_DIR}/.git" ]]; then
    log "Repository già presente: aggiornamento"
    sudo -u "$DEPLOY_USER" git -C "$APP_DIR" fetch --all --prune
    sudo -u "$DEPLOY_USER" git -C "$APP_DIR" checkout "$BRANCH"
    sudo -u "$DEPLOY_USER" git -C "$APP_DIR" pull --ff-only
  else
    sudo -u "$DEPLOY_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi

  chmod +x "${APP_DIR}"/scripts/*.sh 2>/dev/null || true
  ok "Repository su ${APP_DIR} (branch ${BRANCH})"
fi

# ---------------------------------------------------------------------------
# 11. File di ambiente
# ---------------------------------------------------------------------------
step "File di ambiente"

ENV_FILE="${APP_DIR}/.env"

if [[ -f "$ENV_FILE" ]]; then
  ok ".env già presente: non viene toccato"
else
  if [[ -f "${APP_DIR}/.env.example" ]]; then
    cp "${APP_DIR}/.env.example" "$ENV_FILE"
  else
    touch "$ENV_FILE"
  fi

  # Genera i segreti al posto dell'operatore: chiedere a un umano di produrre
  # 32 byte casuali è il modo più affidabile per ritrovarsi "changeme" in
  # produzione.
  gen_hex()  { openssl rand -hex 32; }
  gen_b64()  { openssl rand -base64 32; }

  set_var() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$ENV_FILE"; then
      # Delimitatore | perché i valori base64 contengono /
      sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
      echo "${key}=${value}" >> "$ENV_FILE"
    fi
  }

  set_var POSTGRES_PASSWORD          "$(gen_hex)"
  set_var CSRF_SECRET                "$(gen_hex)"
  set_var WEBHOOK_SIGNING_SECRET     "$(gen_hex)"
  set_var CREDENTIALS_ENCRYPTION_KEY "$(gen_b64)"
  [[ -n "$DOMAIN" ]] && set_var NEXT_PUBLIC_APP_URL "https://${DOMAIN}"

  chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
  # 0600: leggibile solo dal proprietario. Contiene tutti i segreti dello stack.
  chmod 0600 "$ENV_FILE"

  ok "Creato ${ENV_FILE} con i segreti generati"
  warn "Compila le chiavi dei servizi esterni prima del primo deploy:"
  warn "  ANTHROPIC_API_KEY, STRIPE_SECRET_KEY, GOOGLE_CLIENT_ID/SECRET, SUPABASE_*"
fi

# ---------------------------------------------------------------------------
# 12. Unità systemd
# ---------------------------------------------------------------------------
step "Servizio systemd"

cat > /etc/systemd/system/growmy.service <<EOF
[Unit]
Description=GrowMy — piattaforma SEO
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=${DEPLOY_USER}
Group=${DEPLOY_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env

ExecStart=/usr/bin/docker compose -f docker/docker-compose.yml up -d --remove-orphans
ExecStop=/usr/bin/docker compose -f docker/docker-compose.yml down
ExecReload=/usr/bin/docker compose -f docker/docker-compose.yml up -d --remove-orphans

# Il build dell'immagine su una VPS piccola può superare i 5 minuti di default.
TimeoutStartSec=900
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable growmy.service >/dev/null 2>&1
ok "Servizio growmy registrato (avvio automatico al boot)"

# ---------------------------------------------------------------------------
# 13. Rotazione dei log applicativi
# ---------------------------------------------------------------------------
step "Rotazione dei log"

cat > /etc/logrotate.d/growmy <<EOF
${LOG_DIR}/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 ${DEPLOY_USER} ${DEPLOY_USER}
    sharedscripts
}
EOF
ok "Log ruotati giornalmente, 14 giorni di storico"

# ---------------------------------------------------------------------------
# 14. Backup automatico del database
# ---------------------------------------------------------------------------
step "Backup automatico"

if [[ -x "${APP_DIR}/scripts/backup-db.sh" ]]; then
  cat > /etc/cron.d/growmy-backup <<EOF
# Backup del database ogni notte alle 03:15
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * ${DEPLOY_USER} ${APP_DIR}/scripts/backup-db.sh >> ${LOG_DIR}/backup.log 2>&1
EOF
  chmod 0644 /etc/cron.d/growmy-backup
  ok "Backup notturno pianificato (03:15)"
else
  warn "scripts/backup-db.sh non trovato: backup automatico non pianificato."
fi

# ---------------------------------------------------------------------------
# 15. TLS
# ---------------------------------------------------------------------------
if [[ "$SKIP_TLS" == "false" ]]; then
  step "Certificato TLS"

  apt-get install -y -qq --no-install-recommends certbot

  if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    ok "Certificato già presente per ${DOMAIN}"
  else
    # Il DNS deve già puntare qui: verificarlo prima evita di consumare uno
    # dei 5 tentativi orari del rate limit di Let's Encrypt.
    RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
    PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"

    if [[ -n "$RESOLVED" && -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
      warn "${DOMAIN} risolve a ${RESOLVED} ma questo server è ${PUBLIC_IP}."
      warn "Certificato NON emesso. Correggi il DNS e riesegui lo script."
    else
      log "Emissione del certificato (modalità standalone, porta 80)"
      systemctl stop growmy 2>/dev/null || true

      certbot certonly --standalone --non-interactive --agree-tos \
        --email "$ADMIN_EMAIL" -d "$DOMAIN" \
        --key-type ecdsa --preferred-challenges http \
        && ok "Certificato emesso per ${DOMAIN}" \
        || warn "Emissione fallita: continuo senza TLS."
    fi
  fi

  # Il rinnovo ricarica nginx dentro al container, non sull'host.
  cat > /etc/cron.d/growmy-certbot <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 2 * * * root certbot renew --quiet --deploy-hook "docker compose -f ${APP_DIR}/docker/docker-compose.yml exec -T nginx nginx -s reload"
EOF
  chmod 0644 /etc/cron.d/growmy-certbot
  ok "Rinnovo automatico del certificato pianificato"
fi

# ---------------------------------------------------------------------------
# 16. Parametri di kernel
# ---------------------------------------------------------------------------
step "Parametri di rete e kernel"

cat > /etc/sysctl.d/99-growmy.conf <<'EOF'
# Coda di connessioni più profonda: sotto carico il default (128) fa cadere
# connessioni prima ancora che Node le veda.
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096

# Protezione contro SYN flood.
net.ipv4.tcp_syncookies = 1

# Ignora ping broadcast e redirect ICMP: riduce la superficie di attacco.
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0

# Logga i pacchetti con indirizzo sorgente impossibile.
net.ipv4.conf.all.log_martians = 1

# Postgres e Node aprono molti file descriptor.
fs.file-max = 200000

# Non uccidere processi per overcommit prudenziale: il picco del build Next.js
# è transitorio e la swap lo assorbe.
vm.overcommit_memory = 1
EOF

sysctl -p /etc/sysctl.d/99-growmy.conf >/dev/null
ok "Parametri di kernel applicati"

cat > /etc/security/limits.d/99-growmy.conf <<EOF
${DEPLOY_USER} soft nofile 65535
${DEPLOY_USER} hard nofile 65535
EOF
ok "Limiti sui file descriptor alzati a 65535"

# ---------------------------------------------------------------------------
# Riepilogo
# ---------------------------------------------------------------------------
step "Provisioning completato"

cat <<EOF

  ${C_BOLD}Stato del server${C_RESET}

    Utente di deploy    ${DEPLOY_USER}
    Directory app       ${APP_DIR}
    Dati persistenti    ${DATA_DIR}
    Backup              ${BACKUP_DIR}
    Docker              $(docker --version | cut -d, -f1)
    Firewall            porte ${SSH_PORT}, 80, 443
    SSH                 $( (( KEY_COUNT > 0 )) && echo "solo chiave" || echo "${C_YELLOW}password ancora attiva${C_RESET}")

  ${C_BOLD}Prossimi passi${C_RESET}

    1. Compila i segreti dei servizi esterni:
         sudo -u ${DEPLOY_USER} nano ${APP_DIR}/.env

    2. Primo avvio:
         cd ${APP_DIR} && sudo systemctl start growmy

    3. Verifica che risponda:
         curl -fsS http://localhost:3000/api/ready | jq

    4. Da qui in poi, per ogni aggiornamento:
         ${APP_DIR}/scripts/update.sh

EOF

if (( KEY_COUNT == 0 )); then
  warn "IMPORTANTE: aggiungi una chiave SSH e riesegui lo script,"
  warn "altrimenti l'accesso con password resta attivo."
fi

ok "Fatto."
