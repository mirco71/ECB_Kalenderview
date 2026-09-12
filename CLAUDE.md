# ECB Kalenderview — Arbeitsanweisung für Claude

Selbstgehosteter Kalender (Node.js/Express + SQLite) für die Eissporthalle
Solingen, ersetzt eine ehemalige Google-Apps-Script-Lösung. Öffentliche
Kalenderansicht ohne Login, Editor/Admin-Rollen für Termine, Kategorien,
Benutzer und eine Abrechnungs-Auswertung.

## Vertiefende Doku (bei Bedarf laden, nicht vorab)

- [Docs/ARCHITECTURE.md](Docs/ARCHITECTURE.md) — Stack, Projektstruktur, Request-Flow, Konventionen
- [Docs/API.md](Docs/API.md) — alle Endpunkte, Response-Shapes, Statuscodes
- [Docs/DATABASE.md](Docs/DATABASE.md) — Schema, sql.js-Besonderheiten, Migrationsmuster
- [Docs/FRONTEND.md](Docs/FRONTEND.md) — public/-Struktur, api.js-Konvention, XSS-Hinweise
- [Docs/DEPLOYMENT.md](Docs/DEPLOYMENT.md) — Kurzfassung; Details in [deploy/](deploy/)

## Befehle

```bash
npm run dev     # Dev-Server mit Auto-Reload (node --watch)
npm start       # Production-Start
npm test        # Vitest — echte HTTP-Requests gegen In-Memory-DB, kein Mocking
npm run seed    # Ersten Admin-User anlegen (admin/admin123 per Default)
```

## Bevor du etwas änderst

- **Sprachgrenze einhalten**: Code/Kommentare/Variablen Englisch, Fehlermeldungen
  und UI-Texte Deutsch. `/api/events` und `/api/stats` haben bewusst deutsche
  Feldnamen (`termine`, `titel`, `farbe`, …) — nicht "korrigieren", das Frontend
  erwartet sie so.
- **Keine ORM/Migrationstool-Einführung**: Rohes SQL über den
  `db.prepare().get/all/run()`-Wrapper in `server/database.js`. Schemaänderungen
  folgen dem bestehenden `try { ALTER TABLE ... } catch {}`-Muster in `migrate()`.
- **Validierung**: Jede schreibende Route bekommt ein `express-validator`-Array
  vor dem Handler, `validationResult` als erste Zeile im Handler. Bestehende
  Routen in `server/routes/` als Vorlage nehmen.
- **Sicherheitskommentare nicht kommentarlos entfernen** (CSP-Konfiguration in
  `server/index.js`, Farb-Validierung in `categories.js`, JWT-Algorithmus-Pinning
  in `middleware/auth.js`, JWT-Secret-Check in `config.js`) — sie stehen dort,
  weil an der Stelle schon mal eine Sicherheitslücke bewusst geschlossen wurde.
- **Frontend hat kein Auto-Escaping** — Werte, die per `innerHTML` in den DOM
  geschrieben werden, müssen manuell escaped werden.
- **sql.js-Falle**: Die DB lebt im Prozessspeicher und wird nach jedem Write
  komplett neu auf Disk geschrieben. Ein zweiter Prozess (z. B. `seed.js`), der
  parallel zum laufenden Server schreibt, wird vom nächsten Server-Save
  überschrieben — nach `seed.js` muss der Server/Container neu gestartet werden.
- **Neue Rolle = Tabellen-Neuaufbau**: Die Rollenliste steht in der CHECK-Constraint
  der `users`-Tabelle, und SQLite kann die nicht per `ALTER TABLE` ändern.
  `migrateEismeisterRolle()` in `server/database.js` baut die Tabelle deshalb um.
  Wer eine weitere Rolle ergänzt, muss drei Stellen anfassen (`CREATE TABLE users`,
  die Rebuild-Migration, `ROLLEN` in `server/routes/users.js`) — und vor dem Deploy
  ein Backup ziehen. Details in [Docs/DATABASE.md](Docs/DATABASE.md).
- **Nicht-öffentliche Termine haben zwei Austrittspfade**: `/api/events` (inkl. `/:id`)
  und die iCalendar-Feeds. Wer an der Sichtbarkeit arbeitet, muss `login_required`
  in beiden filtern — `server/routes/feeds.js` hat keine Anmeldung und ist der
  leichter zu übersehende Pfad.
- **Zeitzone**: Serientermine werden in lokaler Zeit gerechnet (`server/datetime.js`),
  der Container ist auf `TZ=Europe/Berlin` festgenagelt. Wer Datums-/Zeitlogik
  anfasst: `toISOString()` liefert UTC und ist für „welcher Kalendertag ist das"
  falsch — dafür die Helfer aus `datetime.js` bzw. `toLocalDate()` in `admin.js`.

## Tests

`npm test` vor jeder nicht-trivialen Änderung laufen lassen. Neue Endpunkte
bekommen ein Testfile nach dem Muster der bestehenden (`tests/*.test.js`):
eigener `http`-Client, `DB_PATH=:memory:`, kein Mocking der DB.

## Planungsstil

Für größere Features vor der Umsetzung einen kurzen Plan unter `plans/` ablegen
(Problem, aktueller Stand, Änderungen pro Datei, Ausführungsreihenfolge) — siehe
[`plans/recurring-events-plan.md`](plans/recurring-events-plan.md) als Beispiel.

## Deployment-Kontext

Läuft aktuell über Portainer-Stack (Repository-Build) auf einer Synology
DiskStation, Details in [deploy/portainer-synology.md](deploy/portainer-synology.md).
Bei Deployment-relevanten Änderungen (Dockerfile, docker-compose.yml, Env-Vars)
diese Doku mit aktualisieren.
