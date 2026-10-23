# Security-Fixes Oktober 2026

Branch: `security/findings-2026-10`. Ein Commit pro Paket (Präfix `security:`).
Vor der Arbeit `CLAUDE.md` lesen und die Regeln dort einhalten (Sprachgrenze,
express-validator, logAudit, Sicherheitskommentare nicht kommentarlos löschen,
sondern passend umschreiben).

## Regeln für alle Pakete

1. **Test zuerst.** Für jedes Verhalten unten zuerst einen Test schreiben, laufen
   lassen und zeigen, dass er fehlschlägt. Dann den Fix bauen, danach muss er grün sein.
2. **Ganze Testreihe:** Am Ende jedes Pakets `npm test`, alles grün.
3. **Bestehende Tests nicht abschwächen.** Keine Assertion löschen oder lockern.
   Ausnahmen nur dort, wo das Paket es ausdrücklich erlaubt.
4. **Keine neuen npm-Abhängigkeiten.**
5. Im Abschlussbericht: Liste der geänderten Dateien, Testergebnis vorher und
   nachher und Abweichungen vom Auftrag mit Begründung.

---

## Paket A: Anmeldung per HttpOnly-Cookie, Widerruf, kürzere Laufzeit (Finding 1)

### Server
- **`server/config.js`:** Neuer Wert `secureTransport`, gesetzt aus der
  Umgebungsvariable `SECURE_TRANSPORT`. `'true'` bzw. `'false'` gelten wörtlich,
  fehlt sie, gilt `nodeEnv === 'production'`. In `.env.example` dokumentieren.
  Zweck: Beim Test im LAN über `http://IP:Port` muss `SECURE_TRANSPORT=false`
  gesetzt werden, sonst setzt der Browser das Cookie nicht.
- **`server/database.js` → `migrate()`:** Spalte
  `users.token_version INTEGER NOT NULL DEFAULT 0` nach dem bestehenden
  `try { ALTER TABLE } catch {}`-Muster ergänzen. Den Tabellen-Neuaufbau in
  `migrateEismeisterRolle()` prüfen: Die Spalte darf dabei nicht verloren gehen.
- **`POST /api/auth/login`:**
  - JWT-Payload `{ id, username, role, tv: user.token_version }`, Laufzeit **8h**.
  - Das Token als Cookie `ecb_session` setzen: `HttpOnly`, `SameSite=Strict`,
    `Path=/`, `Max-Age=28800` und `Secure`, wenn `config.secureTransport` gilt.
  - Die Antwort enthält nur noch `{ user }`, **kein `token` mehr**.
- **Neu: `POST /api/auth/logout`** (requireAuth): `token_version` um 1 erhöhen,
  das Cookie löschen (gleiche Attribute, `Max-Age=0`), `logAudit`
  (`auth.logout`) aufrufen und `{ erfolg: true }` zurückgeben.
- **`PUT /api/auth/password`:** Nach der Änderung `token_version` um 1 erhöhen.
  Damit sind alle anderen Sitzungen ungültig. Der Benutzer bekommt ein neues
  Cookie, damit er angemeldet bleibt. Den Kommentar „Bereits ausgestellte Tokens
  bleiben …“ entsprechend anpassen.
- **`server/middleware/auth.js`:**
  - Token-Quelle: zuerst der Header `Authorization: Bearer …`, sonst das Cookie
    `ecb_session`. Den Cookie-Header selbst parsen (kleine Hilfsfunktion, kein
    cookie-parser).
  - Nach `jwt.verify` (Algorithmus-Pinning bleibt) den Benutzer aus der DB laden
    (`SELECT id, username, role, token_version FROM users WHERE id = ?`). Gibt es
    ihn nicht oder ist `tv !== token_version`, dann 401. `req.user` mit der
    **Rolle aus der DB** befüllen, nicht aus dem Token.
  - `optionalAuth`: dieselbe Logik, bei Fehlern ohne Abbruch weiter.
  - **CSRF-Zusatz:** Kommt das Token aus dem Cookie und ist die Methode nicht
    GET/HEAD/OPTIONS, dann muss der Header `Origin` vorhanden sein und
    `${req.protocol}://${req.get('host')}` entsprechen. Sonst 403. Alternativ
    reicht der Header `Sec-Fetch-Site: same-origin`. Mit Bearer-Header entfällt
    die Prüfung.
  - Die Logik nur einmal implementieren (gemeinsame Hilfsfunktion für
    requireAuth und optionalAuth).
- **`server/middleware/syncAuth.js`:** Sync-Tokens bleiben ausschließlich per
  Bearer-Header gültig. Verhalten nicht ändern.

### Frontend
- **`public/js/api.js`:** `ecb_token` vollständig entfernen, kein
  `Authorization`-Header mehr, `fetch` mit `credentials: 'same-origin'`.
  - `login()` speichert nur `ecb_user`. Das sind nur Anzeigedaten, nicht sicherheitsrelevant.
  - `logout()` wird `async`, ruft `POST /api/auth/logout` auf (Fehler ignorieren)
    und entfernt danach `ecb_user`. Beim Laden einmalig ein altes `ecb_token`
    aus dem localStorage löschen.
  - `isLoggedIn()` bedeutet jetzt nur noch: `ecb_user` ist vorhanden. Die
    eigentliche Prüfung macht der Server. Auf einen 401 von `request()` hin
    `ecb_user` entfernen.
- Aufrufer in `admin.js` (Z. 14, 25, 170), `calendar.js` (Z. 638) und `login.js`
  anpassen (`await API.logout()` vor der Weiterleitung).

### Tests
- **Erlaubte Änderung an bestehenden Tests:** Die Testdateien holen das Token
  heute aus `login.body.token`. Stattdessen den Wert aus dem `Set-Cookie`-Header
  (`ecb_session=…`) lesen und weiter als Bearer senden. Dafür den `req`-Helfer um
  die Rückgabe von `headers` erweitern. Nur diese Mechanik ändern, keine
  Assertion anfassen.
- **Neu in `tests/auth.test.js`:**
  - Login setzt ein Cookie mit `HttpOnly` und `SameSite=Strict`, der Body
    enthält kein `token`.
  - Anfrage nur mit Cookie (ohne Bearer) auf `/api/auth/me` ergibt 200.
  - Nach `POST /api/auth/logout` gibt dasselbe Token 401.
  - Nach der Passwortänderung gibt das alte Token 401, das neue Cookie gilt.
  - Rolle wird in der DB von editor auf admin oder zurück geändert, das alte
    Token bekommt die neue Rolle.
  - Gelöschter Benutzer: Sein Token gibt 401.
  - Schreibende Anfrage mit Cookie und fremdem `Origin` ergibt 403, mit
    passendem `Origin` 2xx.
  - Das Token läuft nach 8h ab (`exp - iat === 28800`).
  - Sync-Token im Cookie statt im Header: `/api/sync` lehnt ab.

---

## Paket B: Inline-Event-Handler entfernen (Finding 1, Teil CSP)

Erst nach Paket A, gleiche Dateien.
- Alle `on*="…"`-Attribute in `public/*.html` und in den HTML-Strings in
  `public/js/*.js` entfernen (admin.html 22×, index.html 7×, admin.js,
  calendar.js; Fundstellen per `grep -n 'on[a-z]*="'`).
- **Statische Elemente:** `id` oder `data-action` vergeben und in den
  JS-Dateien `addEventListener` registrieren.
- **Dynamische Listen:** `data-action="edit-event" data-id="${t.id}"`
  bzw. `data-series-id`, dazu **ein** delegierter Click- bzw. Change-Listener
  pro Container. `event.stopPropagation()` aus Z. 339 per Delegation nachbilden
  (Klick auf den Button öffnet nur einmal). Die Werte in `data-*`-Attributen
  weiter mit `escapeHtml` escapen. Das ist im Attributkontext korrekt.
- **`server/index.js`:** `scriptSrcAttr: ["'none'"]` setzen und den Kommentar
  darüber anpassen.
- **Tests:** In einem neuen `tests/static_frontend.test.js` per `fs` prüfen,
  dass `public/**/*.html` und `public/js/*.js` keinen Treffer für
  `/\son[a-z]+\s*=\s*["']/i` enthalten. Ein Header-Test prüft, dass die CSP
  `script-src-attr 'none'` enthält.
- **Manuelle Prüfung** übernimmt der Reviewer im Browser.

---

## Paket C: Routing, Kopfzeilen, CSP (Findings 3, 5, 6)

Nur `server/index.js`, `public/`, neue Tests in `tests/http_hardening.test.js`.

- **404 statt index.html (F3):** Der SPA-Fallback darf nur noch für GET-Pfade
  **ohne Dateiendung** (letztes Pfadsegment ohne `.`) `index.html` liefern.
  Pfade mit Endung, die `express.static` nicht gefunden hat, bekommen
  `404` mit `text/plain` „Nicht gefunden“. `/api/*` bleibt wie bisher.
- **`public/robots.txt`:** `User-agent: *`, `Disallow: /admin.html`,
  `Disallow: /login.html`, `Disallow: /api/`.
- **`/.well-known/security.txt`:** Route in `index.js`. Ist
  `process.env.SECURITY_CONTACT` gesetzt (über config), wird `text/plain` mit
  `Contact: <wert>`, `Expires: <heute + 1 Jahr, ISO>` und
  `Preferred-Languages: de, en` ausgeliefert. Sonst 404. In `.env.example`
  dokumentieren.
- **`X-Robots-Tag: noindex, nofollow`** für `/login.html` und `/admin.html`
  (per `setHeaders` von express.static oder vorgeschalteter Middleware).
- **Cache-Control (F5):** Middleware vor allen `/api`-Routen setzt
  `Cache-Control: no-store` auf jede `/api/*`-Antwort.
- **CSP (F6):**
  - `fontSrc: ["'self'"]`
  - `styleSrc: ["'self'"]`, `styleSrcAttr: ["'unsafe-inline'"]`. Begründung im
    Kommentar: Die Kalenderpositionen kommen aus `style=""`-Attributen, der
    Farbwert wird serverseitig geprüft (Paket D).
  - Den `<style>`-Block aus `public/login.html` (Z. 7–93) nach
    `public/css/login.css` verschieben und per `<link>` einbinden. Andere
    `<style>`-Blöcke in `public/` ebenso behandeln, falls vorhanden.
  - `upgradeInsecureRequests: config.secureTransport ? [] : null`. Ist Paket A
    noch nicht gemergt, `secureTransport` hier in config.js anlegen, mit
    derselben Definition wie in Paket A.
  - **Reporting:** `reportUri: ['/api/csp-report']` und Header
    `Reporting-Endpoints: csp="/api/csp-report"` sowie `reportTo: ['csp']`.
    Neue Route `POST /api/csp-report`: `express.json` mit
    `type: ['application/csp-report', 'application/reports+json', 'application/json']`
    und `limit: '10kb'`, eigener rateLimit (60/15 min pro IP, Schlüssel wie
    authLimiter), `console.warn` mit auf 500 Zeichen gekürztem JSON, Antwort
    `204`. Nicht ins audit_log.
- **Permissions-Policy:** Header auf alle Antworten:
  `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()`.
  Andere Funktionen nicht sperren.
- **Tests:**
  - `/robots.txt` gibt 200 text/plain, `/favicon.ico` und `/irgendwas.php`
    geben 404, `/irgendwas` (ohne Endung) gibt 200 HTML.
  - security.txt mit und ohne env.
  - X-Robots-Tag auf beiden Seiten, nicht auf `/`.
  - `no-store` auf `/api/config` und `/api/events?...`.
  - CSP enthält `font-src 'self'`, `style-src 'self'` ohne `unsafe-inline`
    und `report-uri`. `upgrade-insecure-requests` mit `SECURE_TRANSPORT=true`
    vorhanden, mit `false` nicht. Da die Tests den Server einmal pro Datei
    laden, genügt hier ein Test für den Standardfall.
  - Permissions-Policy ist vorhanden.
  - csp-report gibt 204, Body > 10kb gibt 413.

---

## Paket D: Öffentliche API und Farbwerte (Findings 4, 7) und Audit-IP (Finding 10)

- **`server/routes/events.js`:**
  - `mapEventToTermin(row, user)`: `created_by` nur ausgeben, wenn `user`
    gesetzt ist. Alle Aufrufer anpassen. Zuerst prüfen, ob das Frontend
    `created_by` nutzt (`grep -n created_by public/js`). Falls ja, nur im
    angemeldeten Pfad.
  - `includeExtern` nur, wenn `req.user` gesetzt ist. Anonym wird der Parameter
    ignoriert (`in_hall = 1` gilt dann immer, entfallene Trainings werden
    gefiltert).
  - **Farben beim Ausgeben absichern:** `farbHex` nur ausgeben, wenn es
    `/^#[0-9a-fA-F]{6}$/` entspricht, `farbBg` nur bei `COLOR_PATTERN` aus
    categories.js. Dazu die Regex nach `server/colors.js` auslagern und in
    categories.js und events.js nutzen. Sonst einen festen Standardwert
    (`#888888` bzw. `rgba(136,136,136,0.2)`) ausgeben. `rgb()`/`rgba()` mit
    rein numerischem Muster bleibt ausdrücklich erlaubt, das ist sicher.
  - Gleiche Prüfung dort, wo Farben sonst noch nach außen gehen
    (`grep -n "color_hex\|color_bg" server/routes`), z. B. stats.
- **`server/audit.js` (F10):** Zusätzlich zum bestehenden Löschen nach 6 Monaten
  setzt `pruneAudit` für Einträge älter als **90 Tage** `ip = NULL`. Den
  Kopfkommentar um die Fristen ergänzen. `Docs/DATABASE.md` beim audit_log
  ergänzen: „IP-Adressen werden nach 90 Tagen entfernt, Einträge nach 6 Monaten
  gelöscht.“
- **Tests:**
  - anonym `/api/events` und `/api/events/:id` ohne `created_by`, angemeldet mit.
  - anonym mit `include_extern=1` keine `in_hall = 0`-Termine, angemeldet ja.
  - Kategorie mit per SQL eingeschleustem Farbwert `red;background:url(x)`:
    Die Ausgabe enthält den Standardwert.
  - Audit-Eintrag mit `created_at` vor 100 Tagen: Nach `pruneAudit` ist `ip`
    NULL, der Eintrag existiert noch. Bei 10 Tagen bleibt die IP erhalten.
    `pruneAudit` dafür exportieren, falls nötig.
