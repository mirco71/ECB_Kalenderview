# Frontend

Kein Framework, kein Build-Schritt. Drei statische HTML-Seiten, jede mit ihrem
eigenen JS-Entry-Point, plus ein gemeinsamer API-Wrapper.

```
public/
  index.html    öffentliche Kalenderansicht   → js/calendar.js  (~280 Zeilen)
  login.html    Login-Formular                 → js/login.js
  admin.html    Admin-Panel (Tabs)             → js/admin.js    (~670 Zeilen)
  js/api.js     zentraler fetch-Wrapper, von allen drei Seiten eingebunden
  css/calendar.css, css/admin.css
```

## `js/api.js`

Ein einziges `API`-Objekt mit einer `request(method, path, body)`-Basismethode,
die Token aus `localStorage` (`ecb_token`) anhängt und bei `!res.ok` wirft. Alle
anderen Methoden (`getEvents`, `createEvent`, `login`, …) sind dünne Wrapper
darüber. **Neue Endpunkte hier ergänzen**, nicht direkt `fetch()` in `calendar.js`/`admin.js` aufrufen.

Token + eingeloggter User liegen in `localStorage` unter `ecb_token` / `ecb_user`.

## `admin.html` / `admin.js`

Tab-basiertes Panel: Termine, Kategorien, Benutzer, Abrechnung. Formulare werden
per `id`-Selektoren ausgelesen (kein Data-Binding-Framework). Wiederkehrende
Muster in `admin.js`:
- `loadX()` lädt eine Liste und rendert eine `<table>`
- Submit-Handler unterscheiden Create/Edit anhand eines versteckten `editingId`-Felds
- `resetXForm()` setzt Formulare nach Submit/Cancel zurück

Beim Erweitern eines Formulars: HTML-Feld ergänzen → in `admin.js` beim Submit
auslesen und an `api.js` übergeben → Tabellen-Rendering ggf. um eine Spalte
erweitern.

### Termin-Formular: zwei Modi

`setEventMode('single'|'series')` blendet die jeweils passenden Felder ein und
setzt `required` um — versteckte Pflichtfelder würden den Submit sonst blockieren,
ohne dass der Browser das fehlende Feld fokussieren kann. Im Serien-Modus rechnet
`updateSeriesPreview()` live vor, wie viele Termine entstehen; `seriesOccurrences()`
spiegelt dafür die Server-Logik aus `server/datetime.js` (die Vorschau ist
unverbindlich — angelegt wird immer nach der Server-Berechnung).

### Serien in der Terminliste

`loadEvents()` fasst alle Termine mit gleicher `series_id` zu einer Zeile zusammen
(`renderSeriesRow`); Einzeltermine laufen über `renderEventRow`. Die dafür nötige
Serien-Definition liefert `/api/events` als `serie`-Objekt gleich mit. Ein Klick
öffnet `openSeriesModal()`, das die vollständige Serie über
`GET /api/events/series/:id` nachlädt — die Liste ist datumsgefiltert, die
Serienansicht zeigt bewusst alle Termine.

## `index.html` / `calendar.js`

Rendert eine Wochenansicht; Termine werden absolut positioniert (`style="top/height"`
inline, daher `style-src 'unsafe-inline'` in der CSP, siehe [ARCHITECTURE.md](ARCHITECTURE.md)).
Nutzt die deutschen Feldnamen aus der `/api/events`-Response direkt (`termin.titel`,
`termin.start`, …) ohne Umbenennung.

Die Ansicht ist öffentlich, kennt aber den Login-Status: Beim Start prüft
`API.me()` den Token (nicht nur sein Vorhandensein — ein abgelaufener Token
würde sonst Buttons zeigen, die nur 401 liefern) und setzt `darfBearbeiten`.
Nur dann rendert `loeschButton()` den Lösch-Button am Termin. Bei Serienterminen
weist die Rückfrage darauf hin, dass die ganze Serie im Admin-Bereich verwaltet
wird.

## Sicherheit

Kein Templating-Framework mit Auto-Escaping — Werte, die in HTML eingefügt werden
(Termin-Titel, Beschreibung etc.), müssen manuell escaped werden, bevor sie in
`innerHTML` landen. Die CSP verbietet `'unsafe-inline'` für `<script>`, daher gibt
es keine Inline-`<script>`-Blöcke; `onclick=`-Handler im HTML sind über
`script-src-attr 'unsafe-inline'` erlaubt und in Kombination mit strikter
Output-Escaping als unkritisch bewertet (siehe Kommentar in `server/index.js`).
Bei neuem Code, der User-Input in den DOM schreibt: escapen, nicht auf die CSP verlassen.
