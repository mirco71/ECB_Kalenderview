const http = require('http');
const bcrypt = require('bcryptjs');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-bulk-delete';
process.env.PORT = '0';

let server, baseUrl, db;
let adminToken, editorToken, eismeisterToken;

const KAT_STB = 2;
const KAT_ECB = 7;
const KAT_VERMIETUNG = 8;

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

/**
 * Legt einen Termin um 18 Uhr Ortszeit an. Bewusst lokale Zeit wie im
 * Endpunkt, sonst verrutschen die Tagesgrenzen um den UTC-Versatz.
 */
function termin(titel, kategorie, tag, extra = {}) {
  const [y, m, d] = tag.split('-').map(Number);
  const start = new Date(y, m - 1, d, 18, 0);
  const ende = new Date(y, m - 1, d, 20, 0);
  return db
    .prepare(
      `INSERT INTO events (title, start_time, end_time, category_id, series_id, source, external_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      titel, start.toISOString(), ende.toISOString(), kategorie,
      extra.series_id || null, extra.source || null, extra.external_uid || null
    ).lastInsertRowid;
}

function serie(id, titel, kategorie) {
  db.prepare(
    `INSERT INTO series (id, title, category_id, weekday, time_from, time_to, date_from, date_to)
     VALUES (?, ?, ?, 2, '18:00', '20:00', '2026-10-01', '2026-10-31')`
  ).run(id, titel, kategorie);
}

const vorhanden = id => !!db.prepare('SELECT id FROM events WHERE id = ?').get(id);
const serieVorhanden = id => !!db.prepare('SELECT id FROM series WHERE id = ?').get(id);

function loeschen(body, token = adminToken, probelauf = false) {
  return req('POST', `/api/events/bulk-delete${probelauf ? '?dry_run=true' : ''}`, body, token);
}

describe('Termine im Zeitraum löschen', () => {
  beforeAll(async () => {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server')) delete require.cache[key];
    });

    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    db = getDb();

    const hash = bcrypt.hashSync('testpass', 4);
    const anlegen = db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)'
    );
    anlegen.run('admin', hash, 'admin', 'Test Admin');
    anlegen.run('editor', hash, 'editor', 'Test Editor');
    anlegen.run('eismeister', hash, 'eismeister', 'Test Eismeister');

    const app = require('../server/index');
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    const login = async (username) =>
      (await req('POST', '/api/auth/login', { username, password: 'testpass' })).body.token;
    adminToken = await login('admin');
    editorToken = await login('editor');
    eismeisterToken = await login('eismeister');
  });

  afterAll(() => { if (server) server.close(); });

  it('rechnet im Probelauf nur und löscht nichts', async () => {
    const a = termin('Probe A', KAT_ECB, '2026-11-02');
    const b = termin('Probe B', KAT_VERMIETUNG, '2026-11-03');

    const res = await loeschen(
      { date_from: '2026-11-01', date_to: '2026-11-05', category_ids: [KAT_ECB, KAT_VERMIETUNG] },
      adminToken, true
    );

    expect(res.status).toBe(200);
    expect(res.body.probelauf).toBe(true);
    expect(res.body.anzahl).toBe(2);
    expect(res.body.nachKategorie).toEqual(
      expect.arrayContaining([{ name: 'ECB', anzahl: 1 }, { name: 'Vermietung', anzahl: 1 }])
    );
    expect(vorhanden(a)).toBe(true);
    expect(vorhanden(b)).toBe(true);
  });

  it('löscht nur die gewählten Kategorien', async () => {
    const ecb = termin('Nur ECB weg', KAT_ECB, '2026-12-02');
    const stb = termin('STB bleibt', KAT_STB, '2026-12-02');

    const res = await loeschen({ date_from: '2026-12-01', date_to: '2026-12-05', category_ids: [KAT_ECB] });

    expect(res.status).toBe(200);
    expect(res.body.anzahl).toBe(1);
    expect(vorhanden(ecb)).toBe(false);
    expect(vorhanden(stb)).toBe(true);
  });

  it('zählt erster und letzter Tag mit, der Tag danach bleibt', async () => {
    const vorher = termin('Tag davor', KAT_ECB, '2027-01-09');
    const erster = termin('Erster Tag', KAT_ECB, '2027-01-10');
    const letzter = termin('Letzter Tag', KAT_ECB, '2027-01-12');
    const danach = termin('Tag danach', KAT_ECB, '2027-01-13');

    await loeschen({ date_from: '2027-01-10', date_to: '2027-01-12', category_ids: [KAT_ECB] });

    expect(vorhanden(vorher)).toBe(true);
    expect(vorhanden(erster)).toBe(false);
    expect(vorhanden(letzter)).toBe(false);
    expect(vorhanden(danach)).toBe(true);
  });

  it('lässt eine Serie mit Terminen außerhalb des Zeitraums bestehen', async () => {
    serie('serie-rest', 'Training mit Rest', KAT_ECB);
    const drin = termin('Training mit Rest', KAT_ECB, '2027-02-02', { series_id: 'serie-rest' });
    const draussen = termin('Training mit Rest', KAT_ECB, '2027-02-20', { series_id: 'serie-rest' });

    const res = await loeschen({ date_from: '2027-02-01', date_to: '2027-02-10', category_ids: [KAT_ECB] });

    expect(res.body.serienBetroffen).toBe(1);
    expect(res.body.serienEntfernt).toBe(0);
    expect(vorhanden(drin)).toBe(false);
    expect(vorhanden(draussen)).toBe(true);
    expect(serieVorhanden('serie-rest')).toBe(true);
  });

  it('entfernt eine Serie, von der nichts übrig bleibt', async () => {
    serie('serie-leer', 'Training komplett weg', KAT_ECB);
    termin('Training komplett weg', KAT_ECB, '2027-03-02', { series_id: 'serie-leer' });
    termin('Training komplett weg', KAT_ECB, '2027-03-09', { series_id: 'serie-leer' });

    const res = await loeschen({ date_from: '2027-03-01', date_to: '2027-03-31', category_ids: [KAT_ECB] });

    expect(res.body.serienEntfernt).toBe(1);
    expect(serieVorhanden('serie-leer')).toBe(false);
  });

  it('löscht Spiele aus Hallenplanung mit und weist sie aus', async () => {
    const spiel = termin('Heimspiel', KAT_ECB, '2027-04-03', {
      source: 'hallenplanung', external_uid: 'hp-bulk-1',
    });

    const vorschau = await loeschen(
      { date_from: '2027-04-01', date_to: '2027-04-05', category_ids: [KAT_ECB] }, adminToken, true
    );
    expect(vorschau.body.ausHallenplanung).toBe(1);

    await loeschen({ date_from: '2027-04-01', date_to: '2027-04-05', category_ids: [KAT_ECB] });
    expect(vorhanden(spiel)).toBe(false);
  });

  it('lässt nur Admins löschen', async () => {
    const t = termin('Geschützt', KAT_ECB, '2027-05-02');
    const body = { date_from: '2027-05-01', date_to: '2027-05-05', category_ids: [KAT_ECB] };

    expect((await loeschen(body, editorToken)).status).toBe(403);
    expect((await loeschen(body, eismeisterToken)).status).toBe(403);
    expect((await loeschen(body, null)).status).toBe(401);
    expect(vorhanden(t)).toBe(true);
  });

  it('lehnt ein Enddatum vor dem Startdatum ab', async () => {
    const res = await loeschen({ date_from: '2027-06-10', date_to: '2027-06-01', category_ids: [KAT_ECB] });
    expect(res.status).toBe(400);
  });

  it('verlangt mindestens eine Kategorie', async () => {
    const res = await loeschen({ date_from: '2027-06-01', date_to: '2027-06-10', category_ids: [] });
    expect(res.status).toBe(400);
  });

  it('meldet einen leeren Zeitraum ohne Fehler', async () => {
    const res = await loeschen({ date_from: '2030-01-01', date_to: '2030-01-31', category_ids: [KAT_ECB] });
    expect(res.status).toBe(200);
    expect(res.body.anzahl).toBe(0);
  });
});
