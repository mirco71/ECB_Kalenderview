// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
//
// Der Abgleich mit Hallenplanung. Die zentrale Zusicherung: Er fasst
// ausschließlich eigene Zeilen an. Von Hand gepflegte Termine und die
// Trainings-Serien müssen jeden Lauf unverändert überstehen — daran hängt der
// ganze Entwurf.
const http = require('http');
const bcrypt = require('bcryptjs');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-sync';
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

/** Nutzlast im Format, das export/calendar_model.py erzeugt. */
function payload(events, { from = '2026-09-01', to = '2027-03-31' } = {}) {
  return {
    format: 'ecb-calendar',
    format_version: 1,
    timezone: 'Europe/Berlin',
    season: { name: '2026/27', date_from: from, date_to: to },
    events,
    training: [],
  };
}

function spiel(overrides = {}) {
  return {
    uid: 'hp-u17-1',
    kind: 'heimspiel',
    team: 'U17',
    team_abbrev: 'U17',
    title: 'U17 Heimspiel gegen Ratingen',
    date: '2026-10-03',
    start: '18:15',
    end: '20:30',
    all_day: false,
    location: 'Solingen',
    opponent: 'Ratingen',
    phase: 'regular',
    occupies_hall: true,
    ...overrides,
  };
}

function sync(events, { dryRun = false, ...opts } = {}) {
  const pfad = `/api/sync/calendar${dryRun ? '?dry_run=true' : ''}`;
  return req('POST', pfad, payload(events, opts), adminToken);
}

function alleEvents() {
  return db.prepare('SELECT * FROM events ORDER BY start_time').all();
}

describe('Abgleich mit Hallenplanung', () => {
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
  });

  it('verlangt Anmeldung', async () => {
    const res = await req('POST', '/api/sync/calendar', payload([]));
    expect(res.status).toBe(401);
  });

  it('legt neue Termine an', async () => {
    const res = await sync([spiel()]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ angelegt: 1, geaendert: 0, geloescht: 0, unveraendert: 0 });

    const [ev] = alleEvents();
    expect(ev.title).toBe('U17 Heimspiel gegen Ratingen');
    expect(ev.external_uid).toBe('hp-u17-1');
    expect(ev.source).toBe('hallenplanung');
    expect(ev.in_hall).toBe(1);
  });

  it('rechnet lokale Wandzeit in UTC um', async () => {
    // 3. Oktober liegt in der Sommerzeit: Europe/Berlin ist UTC+2.
    await sync([spiel({ date: '2026-10-03', start: '18:15', end: '20:30' })]);

    const [ev] = alleEvents();
    expect(ev.start_time).toBe('2026-10-03T16:15:00.000Z');
    expect(ev.end_time).toBe('2026-10-03T18:30:00.000Z');
  });

  it('rechnet auch über den Zeitumstellungs-Wechsel korrekt', async () => {
    // 5. Dezember liegt in der Winterzeit: UTC+1, also eine Stunde weniger Versatz.
    await sync([spiel({ date: '2026-12-05', start: '18:15', end: '20:30' })]);

    const [ev] = alleEvents();
    expect(ev.start_time).toBe('2026-12-05T17:15:00.000Z');
  });

  it('ist wiederholbar — der zweite Lauf ändert nichts', async () => {
    await sync([spiel()]);
    const res = await sync([spiel()]);

    expect(res.body).toMatchObject({ angelegt: 0, geaendert: 0, geloescht: 0, unveraendert: 1 });
    expect(alleEvents()).toHaveLength(1);
  });

  it('verschiebt ein Spiel, statt es zu doppeln', async () => {
    // Der Kern der stabilen UIDs: gleiches Spiel, neues Datum.
    await sync([spiel({ date: '2026-10-03' })]);
    const res = await sync([spiel({ date: '2026-11-21' })]);

    expect(res.body).toMatchObject({ angelegt: 0, geaendert: 1, geloescht: 0 });

    const events = alleEvents();
    expect(events).toHaveLength(1);
    expect(events[0].start_time).toBe('2026-11-21T17:15:00.000Z');
  });

  it('löscht Termine, die nicht mehr geliefert werden', async () => {
    await sync([spiel(), spiel({ uid: 'hp-u17-2', date: '2026-10-17' })]);
    const res = await sync([spiel()]);

    expect(res.body).toMatchObject({ geloescht: 1, unveraendert: 1 });
    expect(alleEvents()).toHaveLength(1);
  });

  // ---- Die zentrale Zusicherung ----

  it('lässt von Hand angelegte Termine unangetastet', async () => {
    await req('POST', '/api/events', {
      title: 'Eisdisco GmbH',
      start_time: '2026-10-03T16:00:00.000Z',
      end_time: '2026-10-03T17:30:00.000Z',
      category_id: 8,
    }, adminToken);

    // Ein Lauf ganz ohne Spiele: Alles, was der Abgleich "nicht mehr kennt",
    // wäre ein Löschkandidat — der manuelle Termin darf es nicht sein.
    const res = await sync([]);

    expect(res.body.geloescht).toBe(0);
    const events = alleEvents();
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Eisdisco GmbH');
    expect(events[0].source).toBeNull();
  });

  it('lässt Trainings-Serien unangetastet', async () => {
    await req('POST', '/api/events/series', {
      title: 'U13/15 Training',
      category_id: 7,
      weekday: 3,
      time_from: '17:00',
      time_to: '18:30',
      date_from: '2026-10-01',
      date_to: '2026-10-31',
    }, adminToken);

    const vorher = alleEvents().length;
    expect(vorher).toBeGreaterThan(0);

    await sync([]);
    expect(alleEvents()).toHaveLength(vorher);
  });

  it('fasst Termine außerhalb des Zeitraums nicht an', async () => {
    await sync([spiel({ uid: 'hp-alt', date: '2026-10-03' })]);

    // Lieferung für einen späteren Zeitraum — das Oktober-Spiel liegt davor
    // und gehört zu einer anderen Lieferung.
    const res = await sync([], { from: '2027-01-01', to: '2027-03-31' });

    expect(res.body.geloescht).toBe(0);
    expect(alleEvents()).toHaveLength(1);
  });

  // ---- Sonderfälle der Nutzlast ----

  it('markiert Auswärtsspiele als nicht hallenbelegend', async () => {
    await sync([spiel({
      uid: 'hp-ausw-1',
      kind: 'auswaertsspiel',
      title: 'U17 Auswärtsspiel in Neuss',
      location: 'Neuss',
      occupies_hall: false,
    })]);

    const [ev] = alleEvents();
    expect(ev.in_hall).toBe(0);
    expect(ev.location).toBe('Neuss');
  });

  it('legt ganztägige Termine von Mitternacht bis Mitternacht an', async () => {
    await sync([spiel({
      uid: 'hp-ganztags',
      date: '2026-10-10',
      start: null,
      end: null,
      all_day: true,
    })]);

    const [ev] = alleEvents();
    expect(ev.all_day).toBe(1);
    expect(ev.start_time).toBe('2026-10-09T22:00:00.000Z'); // 10.10. 00:00 lokal
    expect(ev.end_time).toBe('2026-10-10T22:00:00.000Z');   // 11.10. 00:00 lokal
  });

  it('überspringt Blocker', async () => {
    const res = await sync([spiel(), spiel({ uid: 'hp-blocker-1', kind: 'blocker' })]);

    expect(res.body.angelegt).toBe(1);
    expect(alleEvents()).toHaveLength(1);
  });

  // ---- Probelauf ----

  it('schreibt im Probelauf nichts, meldet aber dasselbe', async () => {
    const trocken = await sync([spiel()], { dryRun: true });

    expect(trocken.body.probelauf).toBe(true);
    expect(trocken.body.angelegt).toBe(1);
    expect(alleEvents()).toHaveLength(0);

    const echt = await sync([spiel()]);
    expect(echt.body.angelegt).toBe(trocken.body.angelegt);
    expect(alleEvents()).toHaveLength(1);
  });

  it('liefert Einzelposten für die Vorschau', async () => {
    const res = await sync([spiel()], { dryRun: true });

    expect(res.body.details.angelegt).toEqual([
      { titel: 'U17 Heimspiel gegen Ratingen', start: '2026-10-03T16:15:00.000Z' },
    ]);
  });

  // ---- Fehlerfälle ----

  it('lehnt ein fremdes Format ab', async () => {
    const res = await req('POST', '/api/sync/calendar',
      { ...payload([]), format: 'etwas-anderes' }, adminToken);
    expect(res.status).toBe(400);
  });

  it('lehnt eine unbekannte Formatversion ab', async () => {
    const res = await req('POST', '/api/sync/calendar',
      { ...payload([]), format_version: 99 }, adminToken);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Hallenplanung aktualisieren');
  });

  it('lehnt doppelte uids ab', async () => {
    const res = await sync([spiel(), spiel()]);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Doppelte uid');
  });

  it('lehnt eine unbekannte Kategorie ab', async () => {
    const res = await req('POST', '/api/sync/calendar',
      { ...payload([spiel()]), category: 'Gibtsnicht' }, adminToken);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('existiert nicht');
  });
});
