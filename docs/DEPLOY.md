# GrowMy — deploy in produzione (Caddy + certbot)

Guida per un server dove **Caddy gira già sull'host** e serve altre app
(nel tuo caso `mproc.menuisland.it`) con certificati certbot. GrowMy si affianca
senza toccare quello che c'è già.

## Come si incastra

```
                   Internet (443)
                         │
              ┌──────────▼──────────┐
              │   Caddy (host)      │   ← un solo processo, systemd
              │                     │
              │  mproc  → :8000     │   (già tuo)
              │  blog   → :3000     │   (GrowMy, aggiunto)
              └──────────┬──────────┘
                         │ 127.0.0.1:3000
              ┌──────────▼──────────┐
              │  docker compose     │
              │  web · worker       │
              │  postgres · redis   │   (isolati, senza internet)
              └─────────────────────┘
```

- GrowMy **non** ha un proprio Caddy o nginx: espone la sola porta dell'app su
  `127.0.0.1:3000`, invisibile da internet.
- La tua Caddy aggiunge un blocco per `blog.menuisland.it` che proxa lì sopra.
- I certificati di **entrambi** i domini sono di certbot e si rinnovano da soli.

## Installazione in un comando

```bash
sudo bash /opt/growmy/scripts/install-server.sh \
  --domain blog.menuisland.it \
  --email tu@menuisland.it \
  --repo https://github.com/<tuo-utente>/growmy.git
```

Lo script, in ordine: verifica Docker e DNS → clona il codice → genera i segreti
interni → emette il certificato via webroot → scrive il blocco Caddy →
configura il rinnovo automatico → costruisce le immagini → applica schema e
funzioni SQL → avvia → verifica che `https://blog.menuisland.it` risponda.

È **additivo e idempotente**: non tocca il blocco di mproc, non resetta
firewall né SSH, e rieseguirlo aggiorna senza duplicare.

Dopo il primo giro, compila le chiavi dei servizi esterni e riavvia:

```bash
sudo -u growmy nano /opt/growmy/.env      # GOOGLE_GENERATIVE_AI_API_KEY, SUPABASE_*, ...
docker compose -f /opt/growmy/docker/docker-compose.yml up -d
```

## Il rinnovo dei certificati — come funziona per entrambi

certbot rinnova **tutti** i certificati che gestisce, blog e mproc insieme,
tramite il suo `certbot.timer` (due controlli al giorno). L'unico pezzo che di
solito manca è ricaricare Caddy dopo il rinnovo, altrimenti continua a servire
il certificato vecchio fino al riavvio successivo.

Lo script installa un **deploy-hook globale**:

```
/etc/letsencrypt/renewal-hooks/deploy/reload-caddy.sh
```

certbot lo esegue automaticamente dopo ogni rinnovo andato a buon fine, per
qualunque dominio. Un solo hook copre blog e mproc.

Verifica che tutto sia a posto senza aspettare 90 giorni:

```bash
certbot renew --dry-run      # prova entrambi i domini, non emette nulla
certbot certificates         # mostra scadenze e percorsi
```

La sfida di rinnovo passa dalla porta 80: il blocco Caddy di blog serve
`/.well-known/acme-challenge/` dalla cartella `/var/www/certbot` dove certbot
scrive il token. Per questo il rinnovo funziona anche con Caddy che occupa la 443.

> Se anche il blocco di mproc dovesse un giorno servire la stessa cartella per
> le sue sfide, la struttura è già pronta: stessa `/var/www/certbot`.

## Aggiornamenti

```bash
/opt/growmy/scripts/update.sh
```

Fa backup, build, migrazioni sicure (blocca quelle distruttive), verifica di
prontezza e, se qualcosa non risponde, rollback automatico. Non tocca Caddy né
i certificati.

## Manutenzione

| Cosa | Comando |
|---|---|
| Log app | `docker compose -f /opt/growmy/docker/docker-compose.yml logs -f web worker` |
| Ricaricare Caddy | `systemctl reload caddy` |
| Validare la config Caddy | `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` |
| Stato certificati | `certbot certificates` |
| Test rinnovo | `certbot renew --dry-run` |
| Backup DB manuale | `/opt/growmy/scripts/backup-db.sh` |

## Se qualcosa non va

**`https://blog.menuisland.it` non risponde**

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl status caddy
curl -s http://127.0.0.1:3000/api/ready | jq   # l'app risponde in locale?
```

Se l'app risponde in locale ma non via dominio, il problema è nel blocco Caddy
o nel certificato, non nell'app.

**Il certificato non si rinnova**

```bash
certbot renew --dry-run
```

Il colpevole più comune è la porta 80 non raggiungibile: verifica che il blocco
`http://blog.menuisland.it` di Caddy sia attivo e serva
`/.well-known/acme-challenge/`.

**Ho toccato il Caddyfile e ora mproc è giù**

Lo script non modifica mai il blocco di mproc, ma se lo hai fatto tu:

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

mostra l'errore e la riga. Il blocco di blog è isolato in
`/etc/caddy/sites/blog.menuisland.it.caddy`: puoi rimuoverlo e ricaricare per
tornare allo stato precedente senza perdere mproc.
