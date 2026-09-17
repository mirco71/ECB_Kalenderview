# Datenbank

## Zeitzone

Serientermine werden aus Wochentag + Uhrzeit in **lokaler** Zeit erzeugt, deshalb
setzen `Dockerfile` und `docker-compose.yml` `TZ=Europe/Berlin`. Ohne das liefe der
Container in UTC und „dienstags 18:00" landete je nach Sommer-/Winterzeit ein bis
zwei Stunden daneben — inklusive Bruch beim DST-Wechsel mitten in einer Saison.
Gespeichert wird weiterhin absolut in UTC (`toISOString()`); nur die Berechnung
ist lokal. Helfer dafür in `server/datetime.js`.

SQLite über `sql.js` (WASM-Build, kein natives Kompilat — läuft überall, auch in
schlanken Docker-Images ohne Build-Toolchain). `server/database.js` implementiert
einen Wrapper, der die `better-sqlite3`-API nachbildet (`db.prepare(sql).get/all/run(...params)`),
damit die Routen-Files so aussehen wie mit einem "normalen" synchronen SQLite-Treiber.

**Wichtige Eigenheit**: Die komplette DB liegt im Prozessspeicher und wird nach
jedem `run()`/`exec()` komplett als Datei zurückgeschrieben (`fs.writeFileSync`,
siehe `DatabaseWrapper._save()`). Das heißt:
- Kein echtes Locking/Transaktionsverhalten wie bei einer Server-DB
- Ein zweiter Node-Prozess (z. B. `node server/seed.js`), der parallel zum
  laufenden Server schreibt, wird beim nächsten Server-Save überschrieben —
  deshalb muss der Server nach `seed.js` **neu gestartet** werden (siehe
  [DEPLOYMENT.md](DEPLOYMENT.md) und `deploy/portainer-synology.md` Schritt 4)
- Bei `DB_PATH=:memory:` (Tests) wird nie auf Disk geschrieben

## Schema

### `users`
| Spalte | Typ | Hinweise |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| username | TEXT UNIQUE NOT NULL | |
| password_hash | TEXT NOT NULL | bcrypt, 12 Runden |
| role | TEXT NOT NULL DEFAULT 'editor' | CHECK IN ('admin', 'editor', 'eismeister') |
| display_name | TEXT NOT NULL | |
| created_at / updated_at | TEXT | `datetime('now')` |

### `categories`
| Spalte | Typ | Hinweise |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | 11 Kategorien vorab geseedet (feste IDs 1–11) |
| name | TEXT UNIQUE NOT NULL | |
| color_hex | TEXT NOT NULL | `#rrggbb`, validiert per Regex in der Route |
| color_bg | TEXT NOT NULL | Hex oder `rgb()`/`rgba()`, validiert (verhindert CSS-Injection in inline `style=""`) |
| sort_order | INTEGER NOT NULL DEFAULT 0 | Anzeigereihenfolge |
| group_by_title | INTEGER NOT NULL DEFAULT 0 | Steuert Aufschlüsselung nach Titel in der Abrechnung (`/api/stats`); default an nur für *Hobbies* (id 5) |
| login_required | INTEGER NOT NULL DEFAULT 0 | Termine dieser Kategorie nur für angemeldete Benutzer sichtbar — sie fehlen in der öffentlichen Kalenderansicht **und in allen iCalendar-Feeds** (die kennen keine Anmeldung) |
| eismeister_managed | INTEGER NOT NULL DEFAULT 0 | Die Rolle `eismeister` darf Termine dieser Kategorie anlegen, bearbeiten und löschen |

Die beiden letzten Kennzeichen sind bewusst **getrennt** schaltbar: eine interne
Vermietung soll nicht automatisch in den Eismeister-Bereich fallen, und eine
Eismeister-Kategorie kann öffentlich sein. Die geseedete Kategorie *Eismeister*
hat beide gesetzt.

### `series`

Definition einer wöchentlichen Terminserie. Die Einzeltermine liegen in `events`
und verweisen über `events.series_id` hierauf.

| Spalte | Typ | Hinweise |
|---|---|---|
| id | TEXT PK | UUID, entspricht `events.series_id` |
| title | TEXT NOT NULL | gilt für alle Termine der Serie |
| category_id | INTEGER NOT NULL | FK → categories.id |
| weekday | INTEGER NOT NULL | 0=Sonntag .. 6=Samstag (wie `Date#getDay()`) |
| time_from / time_to | TEXT NOT NULL | Lokale Uhrzeit, `"18:00"` |
| date_from / date_to | TEXT NOT NULL | Erster bzw. letzter tatsächlicher Termin, `"2026-09-01"` |
| description / location | TEXT DEFAULT '' | |
| created_by | INTEGER | FK → users.id, `ON DELETE SET NULL` |
| created_at / updated_at | TEXT | |

**Warum eine eigene Tabelle statt Ableiten aus den Terminen**: Einzelne Termine
dürfen gelöscht und in der Uhrzeit abweichend geändert werden. Würde die Regel
aus den vorhandenen Terminen zurückgerechnet, verschöbe sich der angezeigte
Zeitraum beim Löschen des ersten Termins, und für „Uhrzeit für alle ändern" gäbe
es keine änderbare Definition.

Beim Start füllt `backfillSeries()` fehlende Datensätze für Serien nach, die noch
aus der früheren `repeat_weeks`-Implementierung stammen (idempotent).

### `events`
| Spalte | Typ | Hinweise |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| title | TEXT NOT NULL | |
| start_time / end_time | TEXT NOT NULL | ISO-8601-Strings |
| category_id | INTEGER NOT NULL | FK → categories.id |
| all_day | INTEGER NOT NULL DEFAULT 0 | Bool als 0/1 |
| description / location | TEXT DEFAULT '' | |
| series_id | TEXT DEFAULT NULL | FK auf `series.id`; NULL bei Einzelterminen. Bleibt auch erhalten, wenn die Uhrzeit des Termins von der Serien-Definition abweicht |
| external_uid | TEXT DEFAULT NULL | Stabiler Fremdschlüssel aus Hallenplanung. NULL = von Hand angelegt |
| source | TEXT DEFAULT NULL | Herkunft, z. B. `hallenplanung`. NULL = von Hand angelegt |
| in_hall | INTEGER NOT NULL DEFAULT 1 | 0 = belegt keine Eiszeit in Solingen (Auswärtsspiele) |
| created_by | INTEGER | FK → users.id, `ON DELETE SET NULL` |
| created_at / updated_at | TEXT | |

Indizes auf `start_time`, `end_time`, `category_id`, `series_id` sowie ein
**partieller** Unique-Index auf `external_uid` (nur für Zeilen, die einen haben —
so bleiben beliebig viele manuelle Termine ohne Fremdschlüssel möglich).

#### `in_hall` — warum es das gibt

Auswärtsspiele stehen in dieser Datenbank, damit sie in den Team-Feeds und damit
in den Kalendern der Eltern erscheinen. Sie finden aber in fremden Hallen statt.
Deshalb filtern **zwei** Stellen auf `in_hall = 1`:

- `GET /api/events` (Hallenansicht) — mit `?include_extern=1` abschaltbar; die
  Admin-Terminliste nutzt das, sonst könnte sie Auswärtsspiele nicht verwalten
- `GET /api/stats` (Abrechnung) — **nicht** abschaltbar. Ohne diesen Filter wären
  die ausgewiesenen ECB-Stunden zu hoch, und zwar unauffällig, weil das Ergebnis
  plausibel aussähe

Der Default `1` sorgt dafür, dass alle bestehenden Zeilen unverändert zählen.

#### `external_uid` / `source`

Der Abgleich mit Hallenplanung fasst ausschließlich Zeilen mit `external_uid` an.
Von Hand angelegte Termine — STB, Vermietung, öffentliche Laufzeit, Hobbies — und
die Trainings-Serien bleiben dadurch unberührt. Trainings bekommen bewusst
**keine** `external_uid`: Sie werden einmalig aus Hallenplanung übernommen und
gehören danach Kalenderview, damit einzelne Einheiten hier abgesagt und
verschoben werden können.

### Team-Zuordnung (`server/teams.js`)

Die Zuordnung eines Termins zu Teams wird **aus dem Titel abgeleitet** und nicht
gespeichert. Benennt jemand ein Training um — etwa weil U13/15 und U17/20 ihre
Einheiten tauschen — wandert der Termin dadurch von selbst in die richtigen
Feeds; eine zweite gespeicherte Quelle könnte vom Titel abweichen.

Die Ableitung löst Kurzschreibweisen auf: `U13/15` ergibt *U13 und U15*, weil die
`15` ohne führendes `U` steht und ein reiner Wortabgleich sie übersähe — die
U15-Eltern bekämen den Termin sonst nie. `U11A`/`U11B` zählen beide als `U11`.
Unbekannte Kürzel werden verworfen, damit ein Vertipper keinen Feed für ein
Phantom-Team erzeugt.

#### Gemeinsame Trainings: ein Termin, zwei Feed-Einträge

Der Regelfall ist ein Team pro Termin. Trainieren zwei Mannschaften gemeinsam
auf demselben Eis, gilt bewusst eine andere Aufteilung:

| | Was dort steht | Warum |
|---|---|---|
| **Kalenderview** (Hallenansicht, Abrechnung) | **ein** Termin `U13/15 Training` | Die Halle war einmal belegt. Zwei getrennte Termine würden die Eiszeit in der Abrechnung doppelt zählen |
| **Team-Feeds** (Kalender der Eltern) | `U13 Training` im U13-Feed, `U15 Training` im U15-Feed | Eltern sollen ihr eigenes Team sehen. Wer beide Feeds abonniert hat, bekommt beide Einträge |

Die Umschrift macht `titleForTeam()`. Titel mit einem einzelnen Kürzel und
Wort-Teams bleiben dabei unverändert.

> **Abhängigkeit vom Arbeitsablauf:** Hallenplanung führt U13 und U15 als
> getrennte Teams und überträgt beim Grundstock deshalb **zwei** Serien. Laufen
> die Einheiten parallel, müssen sie in Kalenderview von Hand zu einer
> zusammengeführt werden (eine löschen, die andere auf `U13/15` umbenennen).
> Unterbleibt das, zählt die Abrechnung die Eiszeit doppelt.

### `sync_tokens`

Dauerhafte Tokens für den Abgleich aus Hallenplanung, je Rechner eines.

| Spalte | Typ | Hinweise |
|---|---|---|
| id | INTEGER PK | |
| label | TEXT NOT NULL | freie Bezeichnung, z. B. „Hallenplanung Jugendobfrau"; dient dem Wiedererkennen beim Widerrufen |
| token_hash | TEXT UNIQUE NOT NULL | SHA-256 des Tokens. **Kein bcrypt**: Der Wert ist zufällig und lang, ein langsamer Hash würde nur jeden Abgleich bremsen |
| prefix | TEXT NOT NULL | erste Zeichen des Tokens für die Anzeige in der Liste |
| created_by | INTEGER | FK → users.id; auf dieses Konto laufen die per Token angelegten Termine |
| created_at / last_used_at | TEXT | `last_used_at` beantwortet „wird dieser Rechner noch benutzt" |

Der Klartext existiert nur einmal, in der Antwort von `POST /api/sync-tokens`.
Erzeugung und Prüfung in `server/synctoken.js`.

### `sync_log`

Ein Eintrag je **ausgeführtem** Abgleich (Probeläufe nicht). Speist
`GET /api/sync/status` und damit die Anzeige „zuletzt veröffentlicht von … am …"
in der Vorschau von Hallenplanung.

| Spalte | Typ | Hinweise |
|---|---|---|
| id | INTEGER PK | |
| ran_at | TEXT | |
| endpoint | TEXT NOT NULL | `calendar` oder `training` |
| token_id / token_label | INTEGER / TEXT | **ohne Fremdschlüssel** und mit kopierter Bezeichnung: Der Eintrag soll ein widerrufenes Token überdauern, sonst verschwände die Historie mit ihm |
| user_id | INTEGER | |
| angelegt / geaendert / geloescht | INTEGER | |

## Rollen-Migration: Tabellen-Neuaufbau

SQLite kann eine `CHECK`-Constraint nicht per `ALTER TABLE` ändern, und
`CREATE TABLE IF NOT EXISTS` fasst bestehende Tabellen nicht an. In gewachsenen
Datenbanken steckt deshalb noch `CHECK (role IN ('admin','editor'))`, und das
Anlegen eines Eismeisters würde dort scheitern — lokal im Test (frische
In-Memory-DB) dagegen funktionieren.

`migrateEismeisterRolle()` in `server/database.js` baut die Tabelle deshalb einmalig
neu: neue Tabelle anlegen, Daten kopieren, alte löschen, umbenennen. Die
Fremdschlüssel müssen dabei aus sein (`PRAGMA foreign_keys = OFF`), weil
`events.created_by` und `series.created_by` auf `users(id)` verweisen. Die
Migration erkennt am DDL in `sqlite_master`, ob sie schon gelaufen ist, und ist
damit idempotent. **Vor einem Deploy, der diese Migration mitbringt, ein Backup
des Volumes ziehen.**

Gleiches Muster gilt für künftige Rollen: die Rollenliste steht an drei Stellen —
`CREATE TABLE users` und `migrateEismeisterRolle()` in `server/database.js` sowie
`ROLLEN` in `server/routes/users.js`.

## Migrationen

`migrate()` in `server/database.js` läuft bei jedem Start und ist idempotent:
`CREATE TABLE IF NOT EXISTS` für neue Tabellen, `ALTER TABLE ... ADD COLUMN` in
`try/catch` für Spalten, die auf bestehenden DBs nachgezogen werden müssen (schlägt
beim zweiten Lauf gewollt fehl und wird verschluckt). **Neue Schemaänderungen
folgen diesem Muster** — kein separates Migrationstool, kein Down-Migration-Konzept.

## Seed

`server/seed.js` legt den ersten Admin-User an (`admin`/`admin123` per Default,
überschreibbar per CLI-Flags). Kategorien werden automatisch beim ersten
DB-Init geseedet (`seedCategories()`), unabhängig vom User-Seed.
