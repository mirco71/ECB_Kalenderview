# Deployment über Portainer Stacks (Synology DiskStation)

Diese Anleitung deployt ECB Kalenderview als Portainer-Stack aus dem GitHub-Repository
`mirco71/ECB_Kalenderview`. Der gleiche Ablauf funktioniert später 1:1 auf einem
produktiven Server mit Portainer — nur Domain/Reverse-Proxy kommen dann noch dazu
(siehe [deploy/README.md](README.md) für die Nginx+Certbot-Variante).

## Voraussetzungen

- Portainer CE ist auf der DiskStation installiert und erreichbar
  (Container Manager → Portainer-Container, meist unter `https://<nas-ip>:9443`)
- Du bist in Portainer als Admin eingeloggt
- Der Code liegt auf GitHub unter `https://github.com/mirco71/ECB_Kalenderview` (main-Branch).
  Das Repo ist **privat** — dafür brauchst du ein GitHub Personal Access Token (Schritt 1b)
- Ein freier TCP-Port auf der NAS für die App (diese Anleitung nutzt `3050`;
  in DSM unter Systemsteuerung → Info-Center prüfen, ob er frei ist)

## 1a. GitHub Personal Access Token (PAT) erstellen

Weil das Repo privat ist, braucht Portainer zum Klonen ein Token statt eines Passworts.

1. Auf [github.com](https://github.com) einloggen
2. Profilbild (oben rechts) → **Settings**
3. Ganz unten im linken Menü: **Developer settings**
4. **Personal access tokens** → **Tokens (classic)**
5. **Generate new token** → **Generate new token (classic)**
6. Ggf. Passwort/2FA bestätigen
7. Formular ausfüllen:
   - **Note**: z. B. `portainer-ecb-kalender`
   - **Expiration**: z. B. 1 Jahr (nicht "No expiration" — sicherer; GitHub erinnert
     dich per E-Mail rechtzeitig vor Ablauf)
   - **Scopes**: Häkchen bei **`repo`** setzen
8. **Generate token** → den angezeigten Wert (`ghp_...`) sofort in einen
   Passwort-Manager kopieren. Er wird **nur dieses eine Mal** angezeigt.

**Token-Verwaltung später:**
- Ablaufdatum jederzeit einsehbar unter Developer settings → Tokens (classic) → Spalte
  "Expires on ..." — der Token-**Wert** selbst wird aber nie wieder angezeigt.
- Ein bestehendes Token lässt sich **nicht verlängern**, ohne den Wert zu ändern. Erst
  kurz vor Ablauf per **"Regenerate token"** erneuern und den neuen Wert danach in
  Portainer (Stack → Authentication) nachtragen.
- Läuft das Token unbemerkt ab, schlägt der nächste "Pull and redeploy" fehl — Fix:
  neues Token erzeugen, in Portainer aktualisieren, erneut deployen.

## 1b. Stack anlegen

1. Portainer → **Stacks** → **Add stack**
2. **Name**: `ecb-kalender` (frei wählbar, nur zur Wiedererkennung in der
   Portainer-Oberfläche — hat keinen technischen Bezug zum Repo-Namen)
3. **Build method**: `Repository`
4. **Repository URL**: `https://github.com/mirco71/ECB_Kalenderview.git`
5. **Repository reference**: `refs/heads/main`
6. **Compose path**: `docker-compose.yml`
7. **Authentication**: aktivieren (Toggle an)
   - **Username**: `mirco71`
   - **Password**: das PAT aus Schritt 1a (`ghp_...`)
8. **Skip TLS Verification**: **aus lassen** (deaktiviert). Das ist nur für
   selbstgehostete Git-Server mit selbstsigniertem Zertifikat gedacht — GitHub hat
   ein gültiges Zertifikat, die Option würde hier nur unnötig Sicherheit kosten.

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
Einmal gesetzt nicht mehr ändern, sonst werden alle bestehenden Login-Sessions
ungültig. Trag den Wert nirgends sonst ein (nicht committen).

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

## 6. Port-Konfiguration

Der Port wird **nicht** in Portainer selbst konfiguriert, sondern in
`docker-compose.yml` im Repo:

```yaml
ports:
  - "3050:3000"
```

- **3000** (rechts) — interner Port, auf dem der Node-Server im Container lauscht
  (fest im `Dockerfile` gesetzt, nicht ohne Code-Änderung veränderbar)
- **3050** (links) — externer Port auf der DiskStation, frei wählbar

Weil der Stack per **Repository**-Methode läuft, ist die Datei im Repo die Quelle
der Wahrheit. Um den Port zu ändern:
1. `docker-compose.yml` im Repo anpassen und nach GitHub pushen
2. In Portainer: Stacks → `ecb-kalender` → **Pull and redeploy**

Manuelle Änderungen direkt im Portainer-Stack-Editor halten nur bis zum nächsten
"Pull and redeploy" — dann überschreibt Portainer sie wieder mit dem Stand aus Git.

## 7. Daten & Backup

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

## 8. Updates

Nach neuen Commits auf `main`:

Stacks → `ecb-kalender` → **Pull and redeploy** (Option "Re-pull image and redeploy").
Portainer zieht den aktuellen Repo-Stand (mit dem gespeicherten PAT), baut neu und
startet den Container neu. Die Datenbank im Volume bleibt erhalten.

## 9. Später: Produktivserver

Derselbe Stack (gleiches `docker-compose.yml`, gleiche Schritte 1–4) lässt sich
unverändert auf einem produktiven Portainer-Host wiederholen — inklusive PAT
(gleiches Token, falls noch gültig, sonst ein neues). Ergänzend braucht es dort
typischerweise noch:

- Reverse Proxy mit HTTPS (z. B. Nginx + Certbot, siehe `deploy/server-setup.sh`,
  oder Traefik als eigener Portainer-Stack) statt des direkten Port-Mappings
- DNS-Eintrag auf die Server-IP

## Troubleshooting

| Problem | Lösung |
|---|---|
| Port `3050` schon belegt | Linke Seite von `"3050:3000"` in `docker-compose.yml` ändern (Schritt 6), Stack neu deployen |
| Container startet nicht | Containers → `ecb-kalender` → **Logs** prüfen |
| "JWT_SECRET muss ... gesetzt werden" beim Deploy | Environment variable im Stack-Editor nachtragen |
| Login schlägt fehl nach Neuinstallation | Admin-Benutzer noch nicht geseedet — Schritt 4 durchführen |
| "Pull and redeploy" schlägt mit Auth-Fehler fehl | PAT abgelaufen — neues Token erzeugen (Schritt 1a) und in Portainer unter Authentication aktualisieren |
| Repo nicht auffindbar / 404 beim Klonen | Authentication nicht aktiviert oder falscher Username/Token — Schritt 1b prüfen |
