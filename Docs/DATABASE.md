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
| role | TEXT NOT NULL DEFAULT 'editor' | CHECK IN ('admin', 'editor') |
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
| created_by | INTEGER | FK → users.id, `ON DELETE SET NULL` |
| created_at / updated_at | TEXT | |

Indizes auf `start_time`, `end_time`, `category_id`, `series_id`.

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
