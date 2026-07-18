# Deployment

Ausführliche, aktuell gepflegte Anleitungen liegen in [`deploy/`](../deploy/) —
dieses File ist nur eine Kurzübersicht mit den Punkten, die bei Code-Änderungen
relevant werden können. Bei Widerspruch gilt `deploy/`.

- [`deploy/portainer-synology.md`](../deploy/portainer-synology.md) — Portainer-Stack aus GitHub-Repo (Test-/aktuelle Produktivumgebung, Synology DiskStation)
- [`deploy/README.md`](../deploy/README.md) — Nginx + Certbot Variante
- [`deploy/deploy.sh`](../deploy/deploy.sh), [`deploy/server-setup.sh`](../deploy/server-setup.sh) — Skripte für die Server-Variante

## Docker-Eckdaten

- `Dockerfile`: `node:20-alpine`, `npm ci --production`, Start via `node server/index.js`
- Interner Port fest `3000` (nur per Dockerfile-Änderung anpassbar), externer Port über `docker-compose.yml` (`ports: "3050:3000"` aktuell)
- DB liegt im Volume `ecb-data` → `/app/data/calendar.db`, übersteht Redeploys
- `JWT_SECRET` ist Pflicht-Env-Var (`docker-compose.yml` bricht ohne sie ab); App selbst verweigert in `NODE_ENV=production` den Start ohne starkes Secret (siehe `server/config.js`)

## Zwei Punkte, die bei jedem Deploy-Test wieder auftauchen können

1. **Erstmaliges Setup / DB-Reset**: `node server/seed.js` läuft als separater
   Prozess und schreibt direkt in die DB-Datei. Der bereits laufende Server hält
   die DB aber im Speicher (`sql.js`) — **Container/Prozess nach dem Seed neu
   starten**, sonst kennt der Server den neuen User nicht und ein späterer
   Schreibvorgang überschreibt ihn wieder. Reihenfolge: seed → restart → einloggen.
2. **Portainer "Pull and redeploy"**: Die Option **"Re-pull image" nicht
   aktivieren** — das Image wird lokal aus dem `Dockerfile` gebaut, liegt in
   keiner Registry. Nur den Git-Stand neu holen lassen, Portainer baut selbst neu.

## Env-Variablen (siehe `.env.example`)

`JWT_SECRET` (Pflicht in production), `PORT`, `DB_PATH`, `CALENDAR_NAME`,
`START_HOUR`, `END_HOUR`, optional `CORS_ORIGIN` (nur nötig, wenn ein
Fremd-Origin die API aufruft — das gebündelte Frontend braucht kein CORS).
