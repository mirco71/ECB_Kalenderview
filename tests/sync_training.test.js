// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
//
// Die einmalige Grundstock-Übertragung der Trainingszeiten. Danach gehören die
// Trainings Kalenderview: Hier werden Einheiten abgesagt und verschoben, und
// kein späterer Aufruf darf das überschreiben.
const http = require('http');
const bcrypt = require('bcryptjs');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-sync-training';
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

/** Serie im Format, das export/calendar_model.py liefert (weekday: 0 = Sonntag). */
function serie(overrides = {}) {
  return {
    team: 'U17',
    team_abbrev: 'U17',
    title: 'U17 Training',
    weekday: 3, // Mittwoch in Kalenderviews Zählung
    time_from: '17:00',
    time_to: '18:30',
    date_from: '2026-10-01',
    date_to: '2026-10-31',
    closures: [],
    ...overrides,
  };
}

function uebertrage(training, { dryRun = false } = {}) {
  const pfad = `/api/sync/training${dryRun ? '?dry_run=true' : ''}`;
  return req('POST', pfad, {
    format: 'ecb-calendar',
    format_version: 1,
    timezone: 'Europe/Berlin',
    season: { name: '2026/27', date_from: '2026-09-01', date_to: '2027-03-31' },
    events: [],
    training,
  }, adminToken);
}

const alleEvents = () => db.prepare('SELECT * FROM events ORDER BY start_time').all();
const alleSerien = () => db.prepare('SELECT * FROM series').all();

describe('Grundstock-Übertragung der Trainings', () => {
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

    const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass' });
    adminToken = login.body.token;
  });

  afterAll(() => { if (server) server.close(); });

  beforeEach(() => {
    db.exec('DELETE FROM events');
    db.exec('DELETE FROM series');
  });

  it('verlangt Anmeldung', async () => {
    const res = await req('POST', '/api/sync/training', { format: 'ecb-calendar' });
    expect(res.status).toBe(401);
  });

  it('legt je Team und Wochentag eine Serie an', async () => {
    const res = await uebertrage([serie(), serie({ title: 'U13 Training', weekday: 5 })]);

    expect(res.status).toBe(200);
    expect(res.body.serien).toBe(2);
    expect(alleSerien()).toHaveLength(2);
  });

  it('erzeugt die Termine auf dem richtigen Wochentag', async () => {
    // Oktober 2026: Mittwoche sind der 7., 14., 21. und 28.
    await uebertrage([serie()]);
    const tage = alleEvents().map(e => new Date(e.start_time).getDay());

    expect(tage).toHaveLength(4);
    expect(new Set(tage)).toEqual(new Set([3]));
  });

  it('rechnet lokale Wandzeit in UTC um', async () => {
    await uebertrage([serie()]);
    // 7. Oktober liegt in der Sommerzeit: 17:00 lokal ist 15:00 UTC.
    expect(alleEvents()[0].start_time).toBe('2026-10-07T15:00:00.000Z');
  });

  it('lässt Termine an Hallenschließungen gar nicht erst entstehen', async () => {
    const res = await uebertrage([serie({ closures: ['2026-10-14', '2026-10-21'] })]);

    expect(res.body.termine).toBe(2);
    expect(res.body.wegenSchliessung).toBe(2);

    const daten = alleEvents().map(e => e.start_time.slice(0, 10));
    expect(daten).toEqual(['2026-10-07', '2026-10-28']);
  });

  it('setzt die Serien-Grenzen auf den ersten und letzten echten Termin', async () => {
    await uebertrage([serie({ closures: ['2026-10-07'] })]);
    const [s] = alleSerien();

    expect(s.date_from).toBe('2026-10-14');
    expect(s.date_to).toBe('2026-10-28');
  });

  it('markiert Serien und Termine mit eigener Herkunft', async () => {
    await uebertrage([serie()]);

    expect(alleSerien()[0].source).toBe('hallenplanung-training');
    expect(alleEvents()[0].source).toBe('hallenplanung-training');
    // Kein Fremdschlüssel: Trainings werden nie abgeglichen.
    expect(alleEvents()[0].external_uid).toBeNull();
  });

  // ---- Der zweite Aufruf ----

  it('bricht beim zweiten Aufruf ab, statt zu ersetzen', async () => {
    await uebertrage([serie()]);
    const res = await uebertrage([serie()]);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('bereits');
    expect(res.body.vorhanden).toEqual([
      { titel: 'U17 Training', von: '2026-10-07', bis: '2026-10-28' },
    ]);
  });

  it('lässt beim abgebrochenen zweiten Aufruf alles unverändert', async () => {
    await uebertrage([serie()]);
    // Die Jugendobfrau sagt eine Einheit ab.
    const [erster] = alleEvents();
    db.prepare('DELETE FROM events WHERE id = ?').run(erster.id);
    const nachher = alleEvents().length;

    await uebertrage([serie()]);

    expect(alleEvents()).toHaveLength(nachher);
    expect(alleSerien()).toHaveLength(1);
  });

  it('ignoriert von Hand angelegte Serien bei der Prüfung', async () => {
    // Eine manuell gepflegte Serie darf den Grundstock nicht blockieren.
    await req('POST', '/api/events/series', {
      title: 'Eislaufschule',
      category_id: 7,
      weekday: 6,
      time_from: '10:00',
      time_to: '11:00',
      date_from: '2026-10-01',
      date_to: '2026-10-31',
    }, adminToken);

    const res = await uebertrage([serie()]);
    expect(res.status).toBe(200);
  });

  // ---- Probelauf ----

  it('schreibt im Probelauf nichts, meldet aber dasselbe', async () => {
    const trocken = await uebertrage([serie()], { dryRun: true });

    expect(trocken.body.probelauf).toBe(true);
    expect(trocken.body.termine).toBe(4);
    expect(alleSerien()).toHaveLength(0);
    expect(alleEvents()).toHaveLength(0);

    const echt = await uebertrage([serie()]);
    expect(echt.body.termine).toBe(trocken.body.termine);
  });

  it('liefert Einzelposten für die Vorschau', async () => {
    const res = await uebertrage([serie()], { dryRun: true });

    expect(res.body.details).toEqual([
      { titel: 'U17 Training', anzahl: 4, von: '2026-10-07', bis: '2026-10-28', entfallen: 0 },
    ]);
  });

  // ---- Zusammenspiel mit dem Spiele-Abgleich ----

  it('bleibt vom Spiele-Abgleich unangetastet', async () => {
    await uebertrage([serie()]);
    const vorher = alleEvents().length;

    // Abgleich ohne ein einziges Spiel — alles wäre ein Löschkandidat.
    const res = await req('POST', '/api/sync/calendar', {
      format: 'ecb-calendar',
      format_version: 1,
      timezone: 'Europe/Berlin',
      season: { name: '2026/27', date_from: '2026-09-01', date_to: '2027-03-31' },
      events: [],
      training: [],
    }, adminToken);

    expect(res.body.geloescht).toBe(0);
    expect(alleEvents()).toHaveLength(vorher);
  });

  // ---- Fehlerfälle ----

  it('überspringt Serien ohne Termin im Zeitraum', async () => {
    const res = await uebertrage([serie({ closures: ['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28'] })]);

    expect(res.body.serien).toBe(0);
    expect(alleSerien()).toHaveLength(0);
  });

  it('lehnt eine unbekannte Formatversion ab', async () => {
    const res = await req('POST', '/api/sync/training', {
      format: 'ecb-calendar',
      format_version: 99,
      training: [],
    }, adminToken);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Hallenplanung aktualisieren');
  });
});
