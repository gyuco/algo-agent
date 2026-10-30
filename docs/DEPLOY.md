# Deploy in casa + accesso remoto con Tailscale

L'app gira come **un solo processo**: NestJS serve `/api` e la build del frontend
(`frontend/dist`) sulla stessa origine, quindi basta una porta. `PERSONAL_MODE=true`
la lega a `127.0.0.1`: ci si arriva solo tramite `tailscale serve`, che fa da reverse
proxy HTTPS sulla stessa macchina.

## 1. Prerequisiti

- Node 22+ e `npm` (lo script usa nvm se presente).
- `tailscale` installato e la macchina nella tailnet.
- Claude CLI installato e loggato **come lo stesso utente** che esegue il server:
  `claude setup-token`.
- `backend/.env` compilato: `JWT_SECRET` ed `ENCRYPTION_KEY` con
  `openssl rand -hex 32`. Cambiare `ENCRYPTION_KEY` dopo il primo uso rende
  illeggibili le API key già salvate.

## 2. Build

```bash
scripts/build-prod.sh
```

Fa `npm ci` + build di frontend e backend e applica le migrazioni
(`prisma migrate deploy`). Il database SQLite è `backend/dev.db`: fai un backup
prima di ogni aggiornamento.

## 3. Avvio manuale (per provare)

```bash
scripts/start-prod.sh
```

Poi, da un altro dispositivo della tailnet:

```bash
curl -I https://<macchina>.<tailnet>.ts.net/
```

## 4. Tailscale

```bash
sudo tailscale up
tailscale serve --bg 3000        # HTTPS su https://<macchina>.<tailnet>.ts.net
tailscale serve status
tailscale serve reset            # per rimuovere la configurazione
```

- HTTPS e MagicDNS devono essere attivi nella admin console di Tailscale.
- **Non usare `tailscale funnel`**: pubblicherebbe su internet un'app che custodisce
  il token della sottoscrizione Claude.
- Con `PERSONAL_MODE=true` l'accesso diretto via IP (`http://100.x.y.z:3000`) non
  funziona ed è voluto: passa sempre da `serve`.

## 5. Avvio automatico su macOS (launchd)

```bash
scripts/install-launchd.sh
```

Installa `com.giuseppeconcas.algo-agent` in `~/Library/LaunchAgents` con `KeepAlive`,
quindi riparte dopo un crash o un login.

```bash
# stato
launchctl print gui/$(id -u)/com.giuseppeconcas.algo-agent | head -20
# log
tail -f ~/Library/Logs/algo-agent/backend.log
# stop / rimozione
launchctl bootout gui/$(id -u)/com.giuseppeconcas.algo-agent
```

Se sposti il repo o cambi versione di Node, aggiorna i percorsi in
`scripts/com.giuseppeconcas.algo-agent.plist` e rilancia `install-launchd.sh`.

## 6. Google sign-in

Nel progetto OAuth aggiorna il redirect URI a:

```
https://<macchina>.<tailnet>.ts.net/api/auth/google/callback
```

e imposta `GOOGLE_REDIRECT_URI` nello stesso modo se lo usi.

## 7. Note operative

- **Il Mac non deve dormire**, altrimenti da remoto non risponde:
  `sudo pmset -a sleep 0`, oppure `caffeinate -s` accanto al server.
- `node-pty` richiede il `chmod` degli `spawn-helper` fatto dal `postinstall`:
  se copi solo `dist/`, rifai `npm ci`.
- Il frontend usa URL relativi (`/api/...`), quindi `CORS_ORIGIN` è irrilevante
  in questa configurazione same-origin.
- `WORKSPACE_ROOT` limita le cartelle su cui possono lavorare le chat: tienilo
  impostato a una directory specifica, non alla home.
