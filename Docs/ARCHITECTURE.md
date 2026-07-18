# Architektur

## Stack

- **Backend**: Node.js + Express 4
- **Datenbank**: SQLite über `sql.js` (WASM, kein natives Binary) — siehe [DATABASE.md](DATABASE.md)
- **Auth**: JWT (`jsonwebtoken`), Passwörter mit `bcryptjs` (12 Runden)
- **Validierung**: `express-validator` auf allen schreibenden Routen
- **Security-Header**: `helmet` (CSP), `express-rate-limit` auf `/api/auth`
- **Frontend**: Vanilla JS (kein Framework/Build-Step), CSS, statisch von Express ausgeliefert
- **Tests**: Vitest, führt echte HTTP-Requests gegen eine In-Memory-DB-Instanz (kein Mocking)

Kein Build-Schritt nötig — `public/` wird 1:1 ausgeliefert, `server/` läuft direkt unter Node.

## Projektstruktur

```
server/
  index.js              Express-App, Middleware-Verdrahtung, Server-Start
  config.js             Env-Vars → Config-Objekt, JWT-Secret-Validierung
  database.js            sql.js-Wrapper (better-sqlite3-kompatible API), Migrationen, Seed
  seed.js                CLI-Skript: ersten Admin-User anlegen
  middleware/auth.js     requireAuth (JWT prüfen), requireAdmin (Rolle prüfen)
  routes/
    auth.js               POST /login, GET /me
    events.js             CRUD Termine, inkl. Wochenserien (repeat_weeks)
    categories.js          CRUD Kategorien (admin-only außer GET)
    users.js               CRUD Benutzer (komplett admin-only)
    stats.js                Abrechnungs-Auswertung (GET, requireAuth)

public/
  index.html + js/calendar.js + css/calendar.css   Öffentliche Kalenderansicht
  login.html  + js/login.js                        Login
  admin.html  + js/admin.js + css/admin.css         Admin-Panel (Termine, Kategorien, Benutzer, Abrechnung)
  js/api.js                                          Zentraler Fetch-Wrapper für alle API-Calls

tests/            Vitest, ein File pro Ressource (auth/events/categories/stats)
deploy/           Deployment-Anleitungen (Portainer/Synology, Nginx+Certbot, Setup-Skripte)
plans/            Feature-Pläne (Markdown, vor größeren Änderungen angelegt)
data/             SQLite-DB-Datei (gitignored, wird zur Laufzeit erzeugt)
```

## Request-Flow

1. `server/index.js` verdrahtet Helmet → CORS (optional) → JSON-Body-Parser → Auth-Rate-Limiter (nur `/api/auth`) → Routen
2. Jede Route validiert mit `express-validator`, holt sich die DB per `getDb()` (wirft, falls `dbReady` noch nicht resolved ist)
3. Geschützte Routen hängen `requireAuth` (JWT prüfen) und ggf. `requireAdmin` (Rollen-Check) vor den Handler
4. Statische Dateien aus `public/` werden nach den API-Routen gemountet; ein Catch-all liefert `index.html` für alles außer `/api/*` (SPA-Fallback, wird aber aktuell nicht für echtes Client-Routing gebraucht, da es keine Client-Routen gibt)

## Wichtige Konventionen

- **Sprachgrenze**: Code, Kommentare, Variablennamen → Englisch. Fehlermeldungen, UI-Texte, DB-`CHECK`-Constraints-Werte → Deutsch. Die `/api/events`- und `/api/stats`-Response-Felder sind bewusst Deutsch (`termine`, `titel`, `farbe`, …) — historisch aus der Google-Apps-Script-Version übernommen, damit das Frontend kompatibel blieb.
- **Keine ORM**: Rohes SQL über den `db.prepare(sql).get/all/run(...params)`-Wrapper (better-sqlite3-Interface auf sql.js nachgebaut, siehe [DATABASE.md](DATABASE.md)).
- **Sicherheitskommentare im Code**: An sicherheitsrelevanten Stellen (CSP-Konfiguration, Farb-Validierung gegen CSS-Injection, JWT-Algorithmus-Pinning) steht ein kurzer Kommentar, *warum* — nicht entfernen, ohne den Grund zu verstehen.
- **Keine Abkürzungen bei Validierung**: Jede schreibende Route hat `express-validator`-Regeln; neue Routen sollten dem gleichen Muster folgen (Regeln als Array vor dem Handler, `validationResult` als erste Zeile im Handler).
