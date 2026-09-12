# API-Referenz

Basis: same-origin, kein `/api`-Prefix-Wechsel nötig. Auth via `Authorization: Bearer <jwt>`.
JWT läuft nach 24h ab (`server/routes/auth.js`).

**Feld-Konvention**: `/api/events` und `/api/stats` antworten mit deutschen Feldnamen
(`termine`, `titel`, `start`, `ende`, `farbe`, …) — historisch aus der
Google-Apps-Script-Vorgängerversion übernommen, damit das Frontend kompatibel blieb.
Alle anderen Endpunkte (`users`, `categories` außer Response-Shape, `auth`) nutzen
die englischen DB-Spaltennamen direkt.

## Rollen und Kategorie-Kennzeichen

| Rolle | Rechte |
|---|---|
| `admin` | alles, inklusive Benutzer- und Kategorienverwaltung |
| `editor` | Termine und Serien aller Kategorien anlegen, bearbeiten, löschen |
| `eismeister` | dasselbe, aber **nur** in Kategorien mit `eismeister_managed = 1` |

Zwei Kennzeichen an der Kategorie steuern das (siehe [DATABASE.md](DATABASE.md)):
`login_required` blendet Termine für nicht angemeldete Abrufer aus,
`eismeister_managed` gibt die Kategorie für die Eismeister-Rolle frei. Beide sind
unabhängig voneinander schaltbar.

Verstößt eine Anfrage gegen die Kategorie-Beschränkung, antwortet die API mit
`403 { error: 'Für diese Kategorie fehlt die Berechtigung' }`. Bei `PUT` werden
alte **und** neue Kategorie geprüft — sonst könnte ein Eismeister Termine in
seine Kategorie hinein oder aus ihr heraus verschieben.

## Public (kein Auth)

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/events?start=ISO&end=ISO[&include_extern=1]` | Termine im Zeitraum (überlappend). Standardmäßig **nur Termine, die die Halle belegen** (`in_hall = 1`) — Auswärtsspiele finden woanders statt. `include_extern=1` liefert auch sie; die Admin-Terminliste nutzt das, die Kalenderansicht nicht. Response: `{ erfolg, kalenderName, termine[], startStunde, endStunde }` |
| GET | `/api/events/:id` | Einzelner Termin. Ein Termin aus einer Kategorie mit `login_required = 1` liefert ohne Anmeldung `404` |
| GET | `/api/categories` | Alle Kategorien, sortiert nach `sort_order`; ohne Anmeldung ohne die mit `login_required = 1` |
| GET | `/api/config` | `{ calendarName, startHour, endHour }` |

Diese drei Endpunkte laufen über `optionalAuth` (`server/middleware/auth.js`):
kommt ein gültiges Token mit, wird es ausgewertet, andernfalls antworten sie wie
für einen anonymen Abrufer — **nie** mit 401. Ein ungültiges oder abgelaufenes
Token wird wie „nicht angemeldet" behandelt.

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

### Warnung vor Überschneidungen

Jede Antwort enthält `ueberschneidungen` mit `{ anzahl, minuten, faelle[], weitere, text }`.
Gemeldet werden Termine der ausgewählten Kategorien, die sich zeitlich
überlagern — sie zählen doppelt, obwohl die Halle nur einmal belegt war.
Häufigste Ursache sind parallele Trainings, die nach dem Grundstock aus
Hallenplanung noch nicht zu einem Termin zusammengeführt wurden (siehe
„Gemeinsame Trainings" in [DATABASE.md](DATABASE.md)).

`minuten` beziffert, um wie viel die Gesamtsumme dadurch zu hoch liegt.
Termine, die sich nur berühren (einer endet 18:00, der nächste beginnt 18:00),
gelten nicht als Überschneidung. `faelle` ist auf 20 Einträge begrenzt, `weitere`
nennt den Rest. Ohne Überschneidungen ist `anzahl` 0 und `text` `null`.

### Aufschlüsselung nach Team

`group_by_team=1` ergänzt die Antwort um `teams[]` mit `{ team, anzahl, dauerMinuten }`.
Die Zuordnung wird aus dem Termin-Titel abgeleitet (`server/teams.js`, Details in
[DATABASE.md](DATABASE.md)), nicht aus einer Spalte.

Ein kombiniertes Training wie „U13/15" belegt die Halle **einmal**, erscheint in
der Aufschlüsselung aber unter **beiden** Teams. Die Summe der Team-Zeilen kann
deshalb größer sein als `gesamt.dauerMinuten`. `teamsHinweis` enthält dazu
`mehrfachZugeordnet` (Anzahl solcher Termine) und einen fertigen Hinweistext für
die Anzeige — ohne den wirkt die Auswertung fehlerhaft.

## iCalendar-Feeds (kein Auth)

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/feeds/halle.ics` | Alles, was die Halle belegt (`in_hall = 1`) |
| GET | `/feeds/<Team>.ics` | Alle Termine eines Teams, **inklusive Auswärtsspiele**. Groß-/Kleinschreibung egal |
| GET | `/feeds/` | Übersicht aller Feeds mit ihren URLs |

Ohne `/api`-Präfix, weil die URL in Kalender-Apps von Hand eingetragen wird.
Öffentlich wie die Kalenderansicht: Wer den Kalender sehen darf, darf ihn auch
abonnieren.

**Anmeldepflichtige Kategorien bleiben draußen.** `loadEvents()` in
`server/routes/feeds.js` filtert `login_required = 1` grundsätzlich weg — für
alle Feeds an einer Stelle. Feeds werden von Kalender-Apps ohne Anmeldung
abgerufen; wer die URL kennt, käme sonst an interne Termine. Wer solche Termine
abonnierbar machen will, braucht einen eigenen, tokengeschützten Feed — den gibt
es bewusst noch nicht.

**Team-Feed gegen Hallen-Feed.** Der Hallen-Feed zeigt die Belegung und lässt
Auswärtsspiele weg. Der Team-Feed zeigt die Termine einer Mannschaft und nimmt
Auswärtsspiele mit — sie belegen die Halle nicht, sind für die Eltern aber
genauso Termine. Ein gemeinsames Training heißt im Hallen-Feed weiter
`U13/15 Training`, im U13-Feed dagegen `U13 Training` (siehe `titleForTeam` in
[DATABASE.md](DATABASE.md)).

**Format.** Erzeugt ohne Bibliothek in `server/routes/feeds.js`; die drei
Regeln, an denen Kalender-Apps stillschweigend scheitern, stehen dort als
Hilfsfunktionen:

- **CRLF** als Zeilenende
- **Faltung bei 75 Oktetten**, Folgezeilen mit führendem Leerzeichen. Gezählt
  werden Bytes — Umlaute belegen in UTF-8 zwei
- **Escaping** von `\`, `;`, `,` und Zeilenumbrüchen in Textwerten

Dazu ein `VTIMEZONE`-Block für `Europe/Berlin`, damit die Termine auch über den
Sommer-/Winterzeit-Wechsel richtig liegen, und `DTSTART;TZID=Europe/Berlin`
statt UTC. Ganztägige Termine als `DTSTART;VALUE=DATE`.

**UID**: der Fremdschlüssel aus Hallenplanung, sonst `kv-<id>`. Dadurch erkennen
Abonnenten eine Verschiebung als Änderung und nicht als neuen Termin.

**Umfang**: Termine ab einem Jahr in der Vergangenheit, ohne Ende nach vorn.
`Cache-Control: max-age=300` — der Feed wird von vielen Geräten abgerufen, soll
nach einer Absage aber nicht lange veraltet ausgeliefert werden.

## Abgleich mit Hallenplanung (JWT)

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/api/sync/calendar[?dry_run=true]` | Gleicht die **Spiele** aus Hallenplanung gegen den Bestand ab: neue anlegen, geänderte aktualisieren, im Zeitraum fehlende löschen |
| POST | `/api/sync/training[?dry_run=true]` | **Einmalige** Grundstock-Übertragung der Trainingszeiten als Serien. Ein zweiter Aufruf wird mit `409` abgelehnt |

**Nutzlast** im Format `ecb-calendar` (erzeugt von `export/calendar_model.py` in
Hallenplanung):

```json
{
  "format": "ecb-calendar",
  "format_version": 1,
  "timezone": "Europe/Berlin",
  "season": { "name": "2026/27", "date_from": "2026-09-01", "date_to": "2027-03-31" },
  "events": [
    { "uid": "hp-…", "kind": "heimspiel", "title": "U17 Heimspiel gegen Ratingen",
      "date": "2026-10-03", "start": "18:15", "end": "20:30", "all_day": false,
      "location": "Solingen", "occupies_hall": true }
  ],
  "training": []
}
```

Optional `category` (Name, Vorgabe `ECB`) für die Kategorie der angelegten Termine.

**Was angefasst wird:** ausschließlich Zeilen mit `source = 'hallenplanung'`,
deren `start_time` im gelieferten Zeitraum liegt. Von Hand angelegte Termine und
die Trainings-Serien bleiben unberührt — das ist die zentrale Zusicherung und
durch Tests abgesichert.

**Was übersprungen wird:** Einträge mit `kind = "blocker"`. Sie reisen in der
Nutzlast mit, damit Hallenplanung nicht entscheiden muss, wer sie braucht.

**Zeiten** kommen als lokale Wandzeit plus `timezone` und werden hier nach UTC
umgerechnet (`localDateTime()` aus `server/datetime.js`). Ganztägige Termine
laufen von Mitternacht bis Mitternacht des Folgetags.

**`dry_run=true`** rechnet denselben Abgleich durch, schreibt aber nichts. Die
Vorschau in Hallenplanung ist damit derselbe Endpunkt in einem anderen Modus —
es gibt keinen zweiten Codepfad, der auseinanderlaufen könnte.

**Antwort**: `{ erfolg, probelauf, zeitraum, angelegt, geaendert, geloescht,
unveraendert, details }`. `details` enthält je Rubrik bis zu 50 Einzelposten mit
Titel und Startzeit für die Anzeige im Vorschau-Dialog.

Statuscodes: `400` bei fremdem `format`, nicht unterstützter `format_version`,
doppelten `uid`s oder unbekannter Kategorie.

### Trainings-Grundstock — genau einmal je Saison

`POST /api/sync/training` legt je Eintrag in `training[]` eine Serie an. Jeder
Eintrag: `{ title, weekday (0=So..6=Sa), time_from, time_to, date_from, date_to,
closures[] }`. Tage in `closures` (Hallenschließungen) werden **vor** dem
Anlegen aussortiert, damit der Termin gar nicht erst entsteht.

Serie und Termine bekommen `source = 'hallenplanung-training'` — bewusst
verschieden von `'hallenplanung'`, damit der Spiele-Abgleich sie nie anfasst.
Eine `external_uid` bekommen sie **nicht**: Trainings werden nach der
Übertragung nie wieder abgeglichen.

**Ein zweiter Aufruf wird mit `409` abgelehnt**, statt zu ersetzen. Nach dem
Grundstock gehören die Trainings Kalenderview; ein Ersetzen würde jede dort
gepflegte Absage und Verschiebung vernichten — und die zu schützen ist der Zweck
der ganzen Aufteilung. Die Antwort enthält dann `vorhanden[]` mit den bereits
angelegten Serien. Kommt später ein Team dazu, wird dessen Serie von Hand
angelegt.

**Antwort**: `{ erfolg, probelauf, serien, termine, wegenSchliessung, details[] }`.

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
