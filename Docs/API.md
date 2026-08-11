# API-Referenz

Basis: same-origin, kein `/api`-Prefix-Wechsel nötig. Auth via `Authorization: Bearer <jwt>`.
JWT läuft nach 24h ab (`server/routes/auth.js`).

**Feld-Konvention**: `/api/events` und `/api/stats` antworten mit deutschen Feldnamen
(`termine`, `titel`, `start`, `ende`, `farbe`, …) — historisch aus der
Google-Apps-Script-Vorgängerversion übernommen, damit das Frontend kompatibel blieb.
Alle anderen Endpunkte (`users`, `categories` außer Response-Shape, `auth`) nutzen
die englischen DB-Spaltennamen direkt.

## Public (kein Auth)

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/events?start=ISO&end=ISO[&include_extern=1]` | Termine im Zeitraum (überlappend). Standardmäßig **nur Termine, die die Halle belegen** (`in_hall = 1`) — Auswärtsspiele finden woanders statt. `include_extern=1` liefert auch sie; die Admin-Terminliste nutzt das, die Kalenderansicht nicht. Response: `{ erfolg, kalenderName, termine[], startStunde, endStunde }` |
| GET | `/api/events/:id` | Einzelner Termin |
| GET | `/api/categories` | Alle Kategorien, sortiert nach `sort_order` |
| GET | `/api/config` | `{ calendarName, startHour, endHour }` |

## Authenticated (JWT, `requireAuth`)

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/api/auth/login` | `{ username, password }` → `{ token, user }`. Rate-limited (20/15min). |
| GET | `/api/auth/me` | Aktueller User aus Token |
| POST | `/api/events` | Einzeltermin erstellen (kein Serien-Parameter — dafür `/api/events/series`) |
| PUT | `/api/events/:id` | Termin aktualisieren (Partial Update, betrifft nur diesen einen Termin, auch bei Serien) |
| DELETE | `/api/events/:id` | Einzelnen Termin löschen — bei einem Serientermin bleibt die Serie bestehen |
| GET | `/api/stats?start=ISO&end=ISO&category_ids=5,7,8[&group_by_team=1]` | Abrechnung: Anzahl + Gesamtdauer je Kategorie im Zeitraum, optional nach Titel aufgeschlüsselt (siehe `group_by_title` in [DATABASE.md](DATABASE.md)). Zählt **ausschließlich** Termine mit `in_hall = 1` — Auswärtsspiele belegen keine Eiszeit in Solingen und dürfen die Abrechnung nicht erhöhen. Response: `{ erfolg, zeitraum, termineGesamt, gruppen[], gesamt }`, mit `group_by_team=1` zusätzlich `teams[]` und `teamsHinweis` |

## Serientermine (JWT)

Eine Serie ist eine wöchentliche Wiederholung, definiert durch Wochentag,
Uhrzeit und Zeitraum. Sie besitzt einen eigenen Datensatz (`series`) und erzeugt
daraus die Einzeltermine in `events`, die über `series_id` darauf verweisen.

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/api/events/series` | Serie anlegen: `{ title, category_id, weekday (0=So..6=Sa), time_from "18:00", time_to "20:00", date_from "2026-09-01", date_to "2026-12-15", description?, location? }` → legt Serie + alle Termine an. `date_from`/`date_to` werden auf den ersten bzw. letzten tatsächlichen Termin normalisiert. Max. 200 Termine. |
| GET | `/api/events/series/:seriesId` | Serie + alle Termine (unabhängig vom Datumsfilter). Jeder Termin trägt `abweichend: true`, wenn seine Uhrzeit von der Serien-Definition abweicht. |
| PUT | `/api/events/series/:seriesId` | Titel/Kategorie/Beschreibung/Ort gelten immer für alle Termine. `time_from`/`time_to` nur bei Angabe — sie überschreiben dann **auch abweichend geänderte Einzeltermine**. |
| DELETE | `/api/events/series/:seriesId` | Serie und alle zugehörigen Termine löschen |

Einzelne Termine einer Serie werden über die normalen Event-Endpunkte geändert
oder gelöscht (`PUT`/`DELETE /api/events/:id`); sie behalten dabei ihre `series_id`.

`GET /api/events` liefert bei Serienterminen zusätzlich ein `serie`-Objekt mit
`{ wochentag, zeitVon, zeitBis, datumVon, datumBis, anzahl }` mit, damit die
Admin-Liste eine Serie ohne Zusatz-Request zu einer Zeile zusammenfassen kann.

### Aufschlüsselung nach Team

`group_by_team=1` ergänzt die Antwort um `teams[]` mit `{ team, anzahl, dauerMinuten }`.
Die Zuordnung wird aus dem Termin-Titel abgeleitet (`server/teams.js`, Details in
[DATABASE.md](DATABASE.md)), nicht aus einer Spalte.

Ein kombiniertes Training wie „U13/15" belegt die Halle **einmal**, erscheint in
der Aufschlüsselung aber unter **beiden** Teams. Die Summe der Team-Zeilen kann
deshalb größer sein als `gesamt.dauerMinuten`. `teamsHinweis` enthält dazu
`mehrfachZugeordnet` (Anzahl solcher Termine) und einen fertigen Hinweistext für
die Anzeige — ohne den wirkt die Auswertung fehlerhaft.

## Admin only (`requireAuth` + `requireAdmin`)

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET/POST/PUT/DELETE | `/api/users` bzw. `/api/users/:id` | Nutzerverwaltung. Self-Delete blockiert. Passwort optional bei PUT (nur bei Angabe neu gehasht). |
| POST/PUT/DELETE | `/api/categories` bzw. `/api/categories/:id` | Kategorien anlegen/ändern/löschen. DELETE schlägt fehl (409), wenn noch Termine die Kategorie referenzieren. |

## Validierungsmuster

Jede schreibende Route hat ein `express-validator`-Array vor dem Handler; der
Handler prüft `validationResult(req)` als erste Zeile und gibt bei Fehlern
`400 { error: <erste Fehlermeldung> }` zurück. Neue Endpunkte sollten diesem
Muster 1:1 folgen (siehe z. B. `server/routes/events.js` POST-Handler als Vorlage).

Statuscodes: `400` Validierung, `401` fehlende/ungültige Auth, `403` fehlende
Admin-Rolle, `404` nicht gefunden, `409` Konflikt (Duplicate-Name, Kategorie in
Benutzung), `500` unerwarteter Fehler (zentraler Error-Handler in `server/index.js`).
