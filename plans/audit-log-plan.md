# Änderungsprotokoll (Audit-Log) für Kalenderview

## Context

Bisher ist nicht nachvollziehbar, wer wann was in Kalenderview geändert hat. `events.created_by`
hält nur den Ersteller, `sync_log` nur Abgleich-Zähler. Gewünscht: ein Protokoll aller
Änderungen (Termine, Serien, Kategorien, Benutzer, Sync-Tokens, Abgleiche) inkl. der Aktionen
des Admins selbst, dazu erfolgreiche und fehlgeschlagene Logins. Sichtbar nur für Admins.

Vom Nutzer entschieden:
- **Vorher/Nachher**: Änderungen speichern die geänderten Felder mit altem und neuem Wert;
  Löschungen einen Schnappschuss des gelöschten Objekts.
- **Granularität**: eine Nutzeraktion = ein Eintrag. Einzeltermin anlegen/ändern/löschen je ein
  Eintrag; ein kompletter Abgleich über Sync-Token = **ein** Sammeleintrag.
- **Aufbewahrung**: 6 Monate, danach automatisch gelöscht.
- **Logins**: erfolgreiche und fehlgeschlagene (mit versuchtem Benutzernamen und IP).

## Leitplanke: Live-Daten bleiben unangetastet

Kalenderview ist live. Die Änderung ist **rein additiv**:
- Einzige Schemaänderung ist die **neue** Tabelle `audit_log` plus Index. Kein `ALTER TABLE`,
  kein `UPDATE`/`DELETE`, kein Backfill und kein Neuaufbau bestehender Tabellen (`events`,
  `series`, `categories`, `users`, `sync_tokens`, `sync_log`).
- In den Routen kommt nur ein zusätzliches `INSERT INTO audit_log` hinzu. Die bestehenden
  SQL-Befehle, Prüfungen und Antworten bleiben unverändert. Einzige Ausnahme: `DELETE /api/events/:id`
  liest vor dem Löschen `SELECT *` statt `SELECT id, category_id` (nur lesend).
- `pruneAudit()` löscht ausschließlich in `audit_log`.
- Schlägt das Protokollieren fehl, wird das nur geloggt. Die eigentliche Änderung läuft wie bisher.
- Nachweis vor dem Deploy: Kopie der lokalen `data/calendar.db` (nicht Produktion) vor und nach
  dem Serverstart per SQL-Dump der bestehenden Tabellen vergleichen, Ergebnis: identisch.
- Vor dem Deploy Backup der produktiven `calendar.db` ziehen. Rollback = altes Image, die
  zusätzliche Tabelle stört alten Code nicht.

## Umsetzung

### 1. Schema — `server/database.js` (`migrate()`)
Neue Tabelle, `CREATE TABLE IF NOT EXISTS`, nach dem Muster von `sync_log` **ohne
Fremdschlüssel** (Einträge müssen das Löschen eines Benutzers überdauern):

```sql
audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),  -- UTC
  user_id INTEGER DEFAULT NULL,
  username TEXT DEFAULT NULL,       -- Schnappschuss; bei Fehl-Login der versuchte Name
  action TEXT NOT NULL,             -- z. B. 'event.update', 'auth.login_failed'
  entity_type TEXT NOT NULL,        -- event | series | category | user | sync_token | sync | auth
  entity_id TEXT DEFAULT NULL,
  summary TEXT NOT NULL,            -- deutscher Einzeiler für die Liste
  details TEXT DEFAULT NULL,        -- JSON: { changes: {feld: [alt, neu]} } bzw. Schnappschuss
  ip TEXT DEFAULT NULL
)
```
Dazu `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)`.

### 2. Neues Modul `server/audit.js`
- `logAudit(db, req, { action, entityType, entityId, summary, details })`: liest
  `req.user` (id, username) und die IP (`CF-Connecting-IP || req.ip`, wie der `authLimiter`),
  schreibt eine Zeile. Fehler werden per `console.error` gemeldet und **nicht** geworfen: Das
  Protokoll darf eine erfolgreiche Änderung nicht mit 500 scheitern lassen.
- `diffFields(before, after, fields)`: liefert `{ feld: [alt, neu] }` nur für geänderte Felder.
- `pruneAudit(db)`: `DELETE FROM audit_log WHERE created_at < datetime('now', '-6 months')`.
  Läuft beim Start (Aufruf in `initDatabase()` nach `migrate()`) und höchstens einmal pro Tag
  aus `logAudit` heraus (Zeitstempel im Modul). Keine eigenen Timer.
- Hilfsfunktion für die Datumsdarstellung im `summary` über `toLocalDateString`/`toLocalTimeString`
  aus `server/datetime.js` (nicht `toISOString()`, Zeitzonen-Hinweis in CLAUDE.md).
- Kategorie-IDs werden in `details` zusätzlich als Namen abgelegt, damit das Log lesbar bleibt,
  auch wenn die Kategorie später gelöscht wird.

### 3. Anbindung der schreibenden Routen
Aufruf jeweils **nach** dem erfolgreichen Schreiben, vor `res.json`. Kein Eintrag bei
Validierungsfehlern, 403/404 oder Dry-Runs.

| Datei | Route | action | Inhalt von details |
|---|---|---|---|
| `routes/events.js` | POST `/` | `event.create` | Titel, Start, Ende, Kategorie |
| | PUT `/:id` | `event.update` | Diff über title, start_time, end_time, category, all_day, description, location; kein Eintrag, wenn Diff leer |
| | DELETE `/:id` | `event.delete` | Schnappschuss (dafür `SELECT *` statt nur id/category_id) |
| | POST `/bulk-delete` (nicht dry_run) | `events.bulk_delete` | Zeitraum, Kategorien, Anzahl, Serien entfernt, erste 50 Treffer (`MAX_DETAILS`) |
| | POST `/series` | `series.create` | Definition + Anzahl Termine |
| | PUT `/series/:id` | `series.update` | Diff der Serien-Definition + Anzahl betroffener Termine |
| | DELETE `/series/:id` | `series.delete` | Titel, Definition, Anzahl gelöschter Termine |
| `routes/categories.js` | POST/PUT/DELETE | `category.*` | Werte bzw. Diff (name, Farben, sort_order, group_by_title, login_required, eismeister_managed) |
| `routes/users.js` | POST/PUT/DELETE | `user.*` | username, role, display_name bzw. Diff; bei neuem Passwort nur `passwort: "neu gesetzt"`, **nie** Hash oder Klartext |
| `routes/auth.js` | POST `/login` | `auth.login` / `auth.login_failed` | Fehlgrund (`Benutzer unbekannt` / `Passwort falsch`); versuchter Name auf 100 Zeichen gekürzt |
| | PUT `/password` | `auth.password_change` | nur die Tatsache, keine Werte |
| `routes/syncTokens.js` | POST/DELETE | `sync_token.create` / `.revoke` | Bezeichnung, Präfix; **nie** den Token-Klartext |
| `routes/sync.js` | POST `/calendar`, `/training` (nicht dry_run) | `sync.calendar` / `sync.training` | Token-Bezeichnung, Zähler, erste 50 Titel je Liste (vorhandene `kurz()`-Listen) |

Fehl-Logins, die der `authLimiter` mit 429 abweist, erreichen den Handler nicht, deshalb
kann ein Brute-Force-Versuch das Log nicht fluten.

### 4. API — neue Datei `server/routes/audit.js`, eingebunden in `server/index.js`
`GET /api/audit`, `router.use(requireAuth, requireAdmin)` wie in `users.js`.
Query-Validierung per `express-validator`: `limit` (1–200, Default 50), `offset`, dazu die
Filter (alle serverseitig, damit Paging und Gesamtzahl stimmen, kombinierbar):
- `art`: `aenderungen` (**Default**: alles außer Anmeldungen), `termine` (event + series +
  bulk_delete), `kategorien`, `benutzer`, `sync` (Abgleich + Sync-Tokens), `anmeldungen`
  (erfolgreiche Logins + Passwortwechsel), `fehlanmeldungen`, `alle`.
- `user_id`: nur Einträge dieses Benutzers.
- `from`/`to`: YYYY-MM-DD, lokale Kalendertage über `localDateTime` wie beim Bulk-Delete.
- `q`: Freitextsuche in `summary` (LIKE mit escaptem `%`/`_`, max. 100 Zeichen), z. B. ein
  Termintitel.
Antwort: `{ erfolg: true, gesamt, eintraege: [{ id, zeitpunkt, benutzer, aktion, bereich,
objektId, zusammenfassung, details, ip }] }`, neueste zuerst; `details` als geparstes JSON.

### 5. Frontend
- `public/admin.html`: neuer Tab `<div class="admin-tab admin-only" data-tab="audit">📜 Protokoll</div>`
  und ein `tab-audit`-Panel mit Filterzeile und Tabelle. Filter: **Art** (Auswahl wie `art` oben,
  vorausgewählt „Änderungen", also ohne Anmeldungen, damit Fehl-Logins die Ansicht nicht
  zumüllen), **Benutzer**, **Von/Bis**, **Suche**. Jede Filteränderung lädt ab Seite 1 neu.
  Tabelle
  (Zeitpunkt · Benutzer · Aktion · Zusammenfassung). Klick auf eine Zeile klappt die Details
  auf (Feld: alt → neu). Button „Weitere laden" für Paging.
- `public/js/api.js`: `getAuditLog(params)`.
- `public/js/admin.js`: `loadAuditLog()` im bestehenden `if (currentUser.role === 'admin')`-Block
  und beim Tab-Wechsel neu laden. **Alle Werte über `escapeHtml()`**, weil die Details
  Nutzereingaben enthalten (Titel, Beschreibungen, versuchte Benutzernamen).
  ISO-Zeiten in `start_time`/`end_time`-Änderungen über das vorhandene `formatDatetime()` anzeigen.
  Fehl-Logins farblich hervorheben.

### 6. Tests — neues `tests/audit.test.js` (Muster `tests/auth.test.js`)
- Nicht-Admin (Editor) bekommt 403 auf `/api/audit`, ohne Token 401.
- Termin anlegen/ändern/löschen → drei Einträge mit richtigem Benutzer; der Update-Eintrag enthält
  genau die geänderten Felder mit alt/neu.
- PUT ohne echte Änderung → kein Eintrag.
- Fehl-Login → `auth.login_failed` mit versuchtem Namen, erfolgreicher Login → `auth.login`.
- Benutzer mit Passwort anlegen/ändern → `details` enthält weder Passwort noch Hash.
- Sync-Token erzeugen → Klartext-Token nicht im Log.
- Bulk-Delete mit dry_run → kein Eintrag; ohne → genau ein Eintrag.
- `pruneAudit`: künstlich 7 Monate alten Eintrag einfügen → wird entfernt, frischer bleibt.
- Filter: Default liefert keine `auth.*`-Einträge; `art=fehlanmeldungen` nur Fehl-Logins;
  `user_id`, `from`/`to` und `q` grenzen korrekt ein (inkl. `%` im Suchbegriff wörtlich);
  `gesamt` entspricht der gefilterten Anzahl.
- Bestehende Tests laufen unverändert weiter.

### 7. Doku
- `plans/audit-log-plan.md`: diesen Plan dort ablegen (Projektkonvention).
- `Docs/API.md` (neuer Endpunkt), `Docs/DATABASE.md` (Tabelle, Aufbewahrung).
- `CLAUDE.md`, Abschnitt „Bevor du etwas änderst": „Jede neue schreibende Route ruft `logAudit()`
  auf; Passwörter, Hashes und Token-Klartexte gehören nie in `details`."

## Reihenfolge
1. Plan nach `plans/` kopieren
2. Schema + `server/audit.js`
3. `GET /api/audit` + Tests für Zugriffsschutz
4. Routen anbinden (events → categories → users → auth → syncTokens → sync) mit Tests
5. Frontend-Tab
6. Doku, `npm test` komplett

## Verifikation
- `npm test`: alle bestehenden Tests plus `tests/audit.test.js` grün.
- Datenschutz der Live-Daten: Kopie der lokalen `calendar.db` in den Scratchpad, Dump von
  `events`, `series`, `categories`, `users`, `sync_tokens`, `sync_log` vor und nach einem Start des
  neuen Servers gegen die Kopie vergleichen; es darf nur `audit_log` hinzukommen.
- Manuell (du, weil ich mich nicht einloggen darf): `npm run dev`, als Editor einen Termin anlegen
  und ändern, einmal falsches Passwort eingeben, als Admin den Tab „Protokoll" öffnen und
  Einträge, Vorher/Nachher-Details und Filter prüfen; als Editor ist der Tab nicht sichtbar.
- Vor dem Deploy: Backup der `calendar.db`. Die Migration legt nur eine neue Tabelle an, ein
  Rollback der Anwendung bleibt also gefahrlos.
