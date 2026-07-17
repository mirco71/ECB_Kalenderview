# Deployment über Portainer Stacks (Synology DiskStation)

Diese Anleitung deployt ECB Kalenderview als Portainer-Stack aus dem GitHub-Repository
`mirco71/ECB_Kalenderview`. Der gleiche Ablauf funktioniert später 1:1 auf einem
produktiven Server mit Portainer — nur Domain/Reverse-Proxy kommen dann noch dazu
(siehe [deploy/README.md](README.md) für die Nginx+Certbot-Variante).

## Voraussetzungen

- Portainer CE ist auf der DiskStation installiert und erreichbar
  (Container Manager → Portainer-Container, meist unter `https://<nas-ip>:9443`)
- Du bist in Portainer als Admin eingeloggt
- Der Code liegt auf GitHub unter `https://github.com/mirco71/ECB_Kalenderview` (main-Branch)
- Ein freier TCP-Port auf der NAS für die App (diese Anleitung nutzt `3050`;
  in DSM unter Systemsteuerung → Info-Center → Dienst prüfen, ob er frei ist)

## 1. Stack anlegen

1. Portainer → **Stacks** → **Add stack**
2. **Name**: `ecb-kalender`
3. **Build method**: `Repository`
4. **Repository URL**: `https://github.com/mirco71/ECB_Kalenderview.git`
5. **Repository reference**: `refs/heads/main`
6. **Compose path**: `docker-compose.yml`

## 2. Umgebungsvariablen setzen

Im Stack-Editor unter **Environment variables** hinzufügen:

| Name | Wert |
|------|------|
| `JWT_SECRET` | ein zufälliger, langer String — lokal erzeugen z. B. mit `openssl rand -hex 32` (Git Bash) |
| `CALENDAR_NAME` | optional, Standard: `Eisbelegung Eissporthalle Solingen` |
| `START_HOUR` | optional, Standard: `6` |
| `END_HOUR` | optional, Standard: `23` |

`JWT_SECRET` ist **pflicht** — der Stack bricht das Deployment bewusst ab, wenn die
Variable fehlt, damit nicht versehentlich ein unsicherer Default verwendet wird.

## 3. Deploy

**Deploy the stack** klicken. Portainer klont das Repo auf die DiskStation und baut
das Image aus dem `Dockerfile` im Projekt-Root. Das dauert beim ersten Mal ein bis
zwei Minuten (npm-Install im Build).

Prüfen: Stacks → `ecb-kalender` → Container sollte `running` sein, ohne Restart-Loop.

## 4. Ersten Admin-Benutzer anlegen

Der Container startet mit einer leeren Datenbank (Kategorien werden automatisch
angelegt, aber **kein Benutzer**). Über die Portainer-Konsole:

1. **Containers** → `ecb-kalender` → **Console**-Icon (`>_`)
2. Command: `/bin/sh` → **Connect**
3. Im Terminal:
   ```
   node server/seed.js
   ```
   Erstellt `admin` / `admin123`. Für eigene Zugangsdaten:
   ```
   node server/seed.js --username myadmin --password meinPasswort --name "Max Mustermann"
   ```

## 5. Zugriff

```
http://<nas-ip>:3050
```

Login/Admin-Panel unter `/login.html` bzw. `/admin.html`.

## 6. Daten & Backup

Die SQLite-Datenbank liegt im benannten Volume `ecb-kalender_ecb-data`
(`/app/data/calendar.db` im Container). Optionen:

- **Portainer Volumes**-Ansicht zum Browsen/Exportieren
- Alternativ im `docker-compose.yml` auf einen Bind-Mount umstellen
  (auskommentierte Zeile `/volume1/docker/ecb-kalender/data:/app/data`),
  dann ist der Ordner direkt im Synology-Dateisystem sichtbar und lässt sich
  mit Hyper Backup sichern
- Manuelles Backup per Konsole/SSH:
  ```
  docker cp ecb-kalender:/app/data/calendar.db ./calendar-backup.db
  ```

## 7. Updates

Nach neuen Commits auf `main`:

Stacks → `ecb-kalender` → **Pull and redeploy** (Option "Re-pull image and redeploy").
Portainer zieht den aktuellen Repo-Stand, baut neu und startet den Container neu.
Die Datenbank im Volume bleibt erhalten.

## 8. Später: Produktivserver

Derselbe Stack (gleiches `docker-compose.yml`, gleiche Schritte 1–4) lässt sich
unverändert auf einem produktiven Portainer-Host wiederholen. Ergänzend braucht
es dort typischerweise noch:

- Reverse Proxy mit HTTPS (z. B. Nginx + Certbot, siehe `deploy/server-setup.sh`,
  oder Traefik als eigener Portainer-Stack)
- DNS-Eintrag auf die Server-IP

## Troubleshooting

| Problem | Lösung |
|---|---|
| Port `3050` schon belegt | Linke Seite von `"3050:3000"` in `docker-compose.yml` ändern, Stack neu deployen |
| Container startet nicht | Containers → `ecb-kalender` → **Logs** prüfen |
| "JWT_SECRET muss ... gesetzt werden" beim Deploy | Environment variable im Stack-Editor nachtragen |
| Login schlägt fehl nach Neuinstallation | Admin-Benutzer noch nicht geseedet — Schritt 4 durchführen |
