# Plan: Serientermine — eigene Eingabe, Serien-Verwaltung, Löschen im Kalender

## Problemstellung

Serien sind heute ein Nebeneffekt des Einzeltermin-Formulars und dadurch umständlich
und fehleranfällig:

- Der **Wochentag** ist nicht wählbar, er ergibt sich implizit aus dem Startdatum.
- Das Feld "Wöchentlich wiederholen bis" wird im Frontend still in eine Wochenzahl
  umgerechnet (`Math.ceil(diffMs / Woche) + 1`, gekappt auf 2–52, `admin.js:204`).
  Der Nutzer sieht vor dem Speichern nicht, was daraus wird.
- Eine Serie existiert nur als gemeinsame `series_id` auf den Einzelterminen —
  es gibt keine Serien-Definition, die man anzeigen oder ändern könnte.
- Löschen läuft über ein `prompt()`, in das "1" oder "2" getippt werden muss
  (`admin.js:253`).
- Der Kalender ist rein lesend; Termine lassen sich dort nicht löschen.

## Entscheidungen (mit dem Nutzer abgestimmt)

1. **Löschen im Kalender: Admins und Editoren.** Die API erlaubt Editoren das
   Löschen bereits (`requireAuth` ohne `requireAdmin` auf `DELETE /api/events/:id`);
   der Kalender bleibt damit konsistent zur bestehenden Berechtigung.
2. **Serie bekommt einen eigenen Datensatz** (`series`-Tabelle) statt die Definition
   aus den Einzelterminen zurückzurechnen. Grund: Einzeltermine sollen löschbar sein
   (Ableiten würde die angezeigte Serien-Definition verfälschen) und die Uhrzeit
   soll für die ganze Serie änderbar sein (braucht eine änderbare Regel).
3. **Serie als Ganzes änderbar: Titel, Kategorie und Uhrzeit.** Beim Ändern der
   Uhrzeit werden abweichend geänderte Einzeltermine überschrieben — der Nutzer
   wird davor gewarnt.

## Zeitzone

Serien-Termine werden serverseitig aus Wochentag + Uhrzeit + Zeitraum erzeugt.
Der Container läuft heute in UTC — "dienstags 18:00" würde dort zu 18:00 UTC
(= 20:00 deutscher Sommerzeit), und der DST-Wechsel Ende Oktober fiele mitten in
eine Wintersaison-Serie. Deshalb: **`TZ=Europe/Berlin` im `Dockerfile` und in
`docker-compose.yml` setzen.** Die Generierung nutzt lokale Zeit, `toISOString()`
speichert weiterhin absolut in UTC — bestehende Daten sind nicht betroffen.

## Datenbank

Neue Tabelle `series` (Migration nach bestehendem Muster in `migrate()`):

```sql
CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,            -- UUID, entspricht events.series_id
  title TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  weekday INTEGER NOT NULL,       -- 0=So .. 6=Sa (JS getDay())
  time_from TEXT NOT NULL,        -- "18:00"
  time_to TEXT NOT NULL,          -- "20:00"
  date_from TEXT NOT NULL,        -- "2026-09-01"
  date_to TEXT NOT NULL,          -- "2026-12-15"
  description TEXT DEFAULT '',
  location TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
```

**Backfill** für bestehende Serien: Für jede `series_id` in `events`, zu der noch
kein `series`-Datensatz existiert, einen aus dem ersten und letzten Termin der
Gruppe erzeugen. Läuft einmalig in `migrate()`, idempotent (`WHERE NOT EXISTS`).

Einzeltermine einer Serie behalten ihre `series_id` auch bei abweichender Uhrzeit —
sie bleiben Teil der Serie und werden in der Detailansicht als abweichend markiert.

## API

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/events/series` | Serie anlegen: `{ title, category_id, weekday, time_from, time_to, date_from, date_to, description?, location? }` → erzeugt Serie + alle Einzeltermine |
| GET | `/api/events/series/:id` | Serie + alle zugehörigen Termine (unabhängig vom Datumsfilter der Liste), inkl. `abweichend`-Flag je Termin |
| PUT | `/api/events/series/:id` | Titel/Kategorie (immer für alle) und optional `time_from`/`time_to` (überschreibt alle Termine) |
| DELETE | `/api/events/series/:id` | vorhanden — zusätzlich den `series`-Datensatz löschen |

`repeat_weeks` auf `POST /api/events` **entfällt**; der Endpunkt legt wieder
ausschließlich Einzeltermine an. `GET /api/events` liefert `series_id` weiterhin mit.

## Änderungen pro Datei

### `server/database.js`
- `series`-Tabelle in `migrate()` anlegen, Index auf `events(series_id)` besteht bereits
- Backfill für bestehende `series_id`-Gruppen

### `server/routes/events.js`
- `repeat_weeks`-Logik aus `POST /` entfernen (inkl. `crypto.randomUUID`-Zweig)
- `POST /series`, `GET /series/:id`, `PUT /series/:id` ergänzen; `DELETE /series/:id`
  um das Löschen des `series`-Datensatzes erweitern
- Helper `generateSeriesDates(weekday, dateFrom, dateTo)` → Liste lokaler Termine;
  Obergrenze (z. B. 200) gegen versehentliche Riesen-Serien
- **Reihenfolge beachten**: `/series`-Routen müssen vor `/:id` stehen, sonst greift
  die `:id`-Route (bestehendes `DELETE /series/:seriesId` steht bereits korrekt)

### `public/admin.html`
- Umschalter "Einzeltermin | Serientermin" über dem Formular
- Serien-Felder: Wochentag (Select), Startzeit, Endzeit (`type="time"`), Serie von/bis (`type="date"`)
- Vorschau-Zeile unter den Serien-Feldern
- Terminliste: Spalte "Serie" entfällt, Serien erscheinen als eigene, klickbare Zeile
- Serien-Detail als Modal-Markup (ausgeblendet, kein `position: fixed` nötig — Overlay im Flow)

### `public/js/admin.js`
- Modus-Umschaltung, Live-Vorschau (Anzahl Termine, erster/letzter Termin)
- `loadEvents()`: Termine mit `series_id` zu einer Zeile je Serie zusammenfassen;
  Einzeltermine unverändert
- Serien-Modal: laden, Einzeltermin-Zeit ändern (`PUT /api/events/:id`),
  Einzeltermin löschen, ganze Serie löschen, Serien-Kopf ändern
- `prompt()`-Dialog beim Löschen entfernen — Serien werden jetzt im Modal verwaltet

### `public/js/api.js`
- `createSeries`, `getSeries`, `updateSeries` ergänzen (`deleteEventSeries` besteht)

### `public/js/calendar.js`
- Auth-Status prüfen (`API.isLoggedIn()`); für angemeldete Nutzer Lösch-Button am Termin
- Bei Serien-Terminen: Rückfrage "nur dieser Termin" / "ganze Serie"
- Nach dem Löschen `ladeKalender()` erneut aufrufen
- Termin-Titel/Zeiten weiterhin escapen (kein Auto-Escaping, siehe Docs/FRONTEND.md)

### `Dockerfile`, `docker-compose.yml`
- `TZ=Europe/Berlin` setzen

### `tests/events.test.js`
- Serie anlegen: korrekte Anzahl und Wochentage
- Einzeltermin einer Serie löschen: Serie bleibt bestehen
- Uhrzeit für ganze Serie ändern: alle Termine angepasst
- Serie löschen: Termine und `series`-Datensatz weg
- `repeat_weeks` wird nicht mehr ausgewertet

### Doku
- `Docs/API.md`, `Docs/DATABASE.md`, `README.md` auf den neuen Stand bringen

## Reihenfolge

1. `database.js` — Tabelle + Backfill
2. `routes/events.js` — Endpunkte
3. `tests/events.test.js` — Tests, `npm test` grün
4. `api.js` → `admin.html` → `admin.js` — Eingabe und Serien-Verwaltung
5. `calendar.js` — Löschen im Kalender
6. `Dockerfile` / `docker-compose.yml` — Zeitzone
7. Doku nachziehen, Ende-zu-Ende im Browser prüfen
