// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
//
// Auswärtsspiele stehen in der Datenbank, damit sie in den Team-Feeds und damit
// in den Kalendern der Eltern erscheinen. Sie belegen aber keine Eiszeit in
// Solingen. Diese Tests sichern die beiden Stellen ab, an denen das zählt:
// die Hallenansicht und — wichtiger — die Abrechnung.
const http = require('http');
const bcrypt = require('bcryptjs');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-in-hall';
process.env.PORT = '0';

let server, baseUrl, adminToken, db;

function req(method, urlPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: new URL(baseUrl).port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;

    const r = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function insertEvent({ title, start, end, category = 7, inHall = 1, uid = null }) {
  db.prepare(
    `INSERT INTO events (title, start_time, end_time, category_id, in_hall, external_uid, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(title, start, end, category, inHall, uid, uid ? 'hallenplanung' : null);
}

describe('in_hall — Hallenbelegung vs. Team-Kalender', () => {
  beforeAll(async () => {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server')) delete require.cache[key];
    });

    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    db = getDb();

    const hash = bcrypt.hashSync('testpass', 4);
    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run('admin', hash, 'admin', 'Test Admin');

    const app = require('../server/index');
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    const loginRes = await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass' });
    adminToken = loginRes.body.token;

    // Kategorie 7 = ECB. Zwei Stunden Heimspiel, zwei Stunden Training,
    // zwei Stunden Auswärtsspiel — letzteres darf nirgends mitzählen.
    insertEvent({
      title: 'U17 Heimspiel gegen Ratingen',
      start: '2026-10-03T16:15:00.000Z',
      end: '2026-10-03T18:15:00.000Z',
      uid: 'hp-heim-1',
    });
    insertEvent({
      title: 'U13/15 Training',
      start: '2026-10-07T15:00:00.000Z',
      end: '2026-10-07T17:00:00.000Z',
    });
    insertEvent({
      title: 'U17 Auswärtsspiel in Neuss',
      start: '2026-10-10T15:00:00.000Z',
      end: '2026-10-10T17:00:00.000Z',
      inHall: 0,
      uid: 'hp-ausw-1',
    });
    // Fremdmieter, unverändert wie bisher — der Regressionsschutz.
    insertEvent({
      title: 'Eisdisco GmbH',
      start: '2026-10-09T18:00:00.000Z',
      end: '2026-10-09T19:30:00.000Z',
      category: 8,
    });
  });

  afterAll(() => { if (server) server.close(); });

  const range = 'start=2026-10-01T00:00:00.000Z&end=2026-11-01T00:00:00.000Z';

  // ---- Hallenansicht ----

  it('blendet Auswärtsspiele in der Kalenderansicht aus', async () => {
    const res = await req('GET', `/api/events?${range}`);
    const titel = res.body.termine.map(t => t.titel ?? t.title);

    expect(res.status).toBe(200);
    expect(titel).toContain('U17 Heimspiel gegen Ratingen');
    expect(titel).toContain('U13/15 Training');
    expect(titel).not.toContain('U17 Auswärtsspiel in Neuss');
  });

  it('zeigt sie mit include_extern für die Verwaltung', async () => {
    const res = await req('GET', `/api/events?${range}&include_extern=1`);
    const titel = res.body.termine.map(t => t.titel ?? t.title);

    expect(titel).toContain('U17 Auswärtsspiel in Neuss');
    expect(titel).toHaveLength(4);
  });

  it('lässt bestehende Termine unverändert sichtbar', async () => {
    // in_hall hat den Default 1 — Fremdmieter dürfen nicht verschwinden.
    const res = await req('GET', `/api/events?${range}`);
    const titel = res.body.termine.map(t => t.titel ?? t.title);
    expect(titel).toContain('Eisdisco GmbH');
  });

  // ---- Abrechnung (Befund B1) ----

  it('zählt Auswärtsspiele NICHT in die Abrechnung', async () => {
    // Der wichtigste Test dieses Vorhabens: Ohne den Filter wären es 360
    // Minuten statt 240, und der Fehler fiele nicht auf, weil das Ergebnis
    // plausibel aussieht.
    const res = await req('GET', `/api/stats?${range}&category_ids=7`, null, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.gesamt.anzahl).toBe(2);
    expect(res.body.gesamt.dauerMinuten).toBe(240);
  });

  it('lässt die Zahlen der Fremdmieter unangetastet', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=8`, null, adminToken);

    expect(res.body.gesamt.anzahl).toBe(1);
    expect(res.body.gesamt.dauerMinuten).toBe(90);
  });

  // ---- Aufschlüsselung nach Team (Befund B2) ----

  it('schlüsselt auf Wunsch nach Team auf', async () => {
    const res = await req(
      'GET', `/api/stats?${range}&category_ids=7&group_by_team=1`, null, adminToken
    );

    const nach = Object.fromEntries(res.body.teams.map(t => [t.team, t.dauerMinuten]));
    expect(nach).toEqual({ U13: 120, U15: 120, U17: 120 });
  });

  it('weist auf die Doppelzählung kombinierter Trainings hin', async () => {
    const res = await req(
      'GET', `/api/stats?${range}&category_ids=7&group_by_team=1`, null, adminToken
    );

    // U13/15 belegt die Halle einmal, erscheint aber unter beiden Teams:
    // 360 Team-Minuten gegenüber 240 tatsächlichen Hallenminuten.
    const summeTeams = res.body.teams.reduce((s, t) => s + t.dauerMinuten, 0);
    expect(summeTeams).toBeGreaterThan(res.body.gesamt.dauerMinuten);
    expect(res.body.teamsHinweis.mehrfachZugeordnet).toBe(1);
  });

  it('liefert ohne group_by_team keine Team-Aufschlüsselung', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=7`, null, adminToken);
    expect(res.body.teams).toBeUndefined();
  });

  it('meldet keine Überschneidungen, wenn es keine gibt', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=7,8`, null, adminToken);
    expect(res.body.ueberschneidungen.anzahl).toBe(0);
    expect(res.body.ueberschneidungen.text).toBeNull();
  });

  // Verschachtelt, damit Server und Datenbank aus dem äußeren beforeAll/afterAll
  // noch stehen — ein eigener describe auf Dateiebene liefe nach dem Schließen.
  describe('Überschneidungswarnung', () => {
    const range = 'start=2026-11-01T00:00:00.000Z&end=2026-12-01T00:00:00.000Z';

    beforeAll(() => {
      // Zwei parallele Trainings — der Fall, den die Warnung abfangen soll:
      // beim Grundstock aus Hallenplanung kamen U13 und U15 getrennt herein und
      // wurden noch nicht zu einem Termin zusammengeführt.
      insertEvent({
        title: 'U13 Training',
        start: '2026-11-04T16:00:00.000Z',
        end: '2026-11-04T17:30:00.000Z',
      });
      insertEvent({
        title: 'U15 Training',
        start: '2026-11-04T16:00:00.000Z',
        end: '2026-11-04T17:30:00.000Z',
      });
      // Direkt anschließend, aber ohne Überlappung — darf nicht gemeldet werden.
      insertEvent({
        title: 'U17 Training',
        start: '2026-11-04T17:30:00.000Z',
        end: '2026-11-04T19:00:00.000Z',
      });
    });

    it('erkennt gleichzeitige Termine und beziffert die Doppelzählung', async () => {
      const res = await req('GET', `/api/stats?${range}&category_ids=7`, null, adminToken);
      const ueb = res.body.ueberschneidungen;

      expect(ueb.anzahl).toBe(1);
      expect(ueb.minuten).toBe(90);
      expect(ueb.text).toContain('Überschneidung');

      const titel = [ueb.faelle[0].titelA, ueb.faelle[0].titelB].sort();
      expect(titel).toEqual(['U13 Training', 'U15 Training']);
      expect(ueb.faelle[0].datum).toBe('2026-11-04');
    });

    it('wertet direkt aneinandergrenzende Termine nicht als Überschneidung', async () => {
      // U17 beginnt exakt, wenn die anderen enden — das ist der Normalfall
      // hintereinander liegender Einheiten und keine Doppelzählung.
      const res = await req('GET', `/api/stats?${range}&category_ids=7`, null, adminToken);
      const beteiligt = res.body.ueberschneidungen.faelle.flatMap(f => [f.titelA, f.titelB]);
      expect(beteiligt).not.toContain('U17 Training');
    });

    it('weist die belegte Zeit aus, nicht die Summe der Einheiten', async () => {
      // 3 × 90 Minuten als Einheiten, aber U13 und U15 liegen deckungsgleich:
      // belegt war das Eis nur 180 Minuten. Genau die werden abgerechnet.
      const res = await req('GET', `/api/stats?${range}&category_ids=7`, null, adminToken);
      expect(res.body.gesamt.dauerMinuten).toBe(180);
      expect(res.body.gesamt.dauerBruttoMinuten).toBe(270);
      // Die Differenz ist genau die gemeldete Überschneidung.
      expect(res.body.gesamt.dauerBruttoMinuten - res.body.ueberschneidungen.minuten)
        .toBe(res.body.gesamt.dauerMinuten);
    });
  });
});
