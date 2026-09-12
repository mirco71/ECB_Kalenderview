const http = require('http');
const bcrypt = require('bcryptjs');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-eismeister';
process.env.PORT = '0';

let server, baseUrl, db;
let adminToken, editorToken, eismeisterToken;

// Kategorien der Test-DB: 12 ist die geseedete Eismeister-Kategorie
// (login_required = 1, eismeister_managed = 1). 20 und 21 prüfen, dass die
// beiden Kennzeichen wirklich unabhängig voneinander wirken.
const KAT_ECB = 7;
const KAT_EISMEISTER = 12;
const KAT_NUR_INTERN = 20;      // login_required = 1, eismeister_managed = 0
const KAT_EISM_OEFFENTLICH = 21; // login_required = 0, eismeister_managed = 1

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

/** Legt einen Termin direkt in der DB an und liefert seine ID. */
function termin(titel, categoryId, tag = '2026-09-20') {
  const res = db
    .prepare(
      'INSERT INTO events (title, start_time, end_time, category_id) VALUES (?, ?, ?, ?)'
    )
    .run(titel, `${tag}T18:00:00.000Z`, `${tag}T20:00:00.000Z`, categoryId);
  return res.lastInsertRowid;
}

describe('Eismeister: Rolle, Kategorie-Kennzeichen, Sichtbarkeit', () => {
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

    db.prepare(
      'INSERT INTO categories (id, name, color_hex, color_bg, sort_order, login_required, eismeister_managed) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(KAT_NUR_INTERN, 'Nur intern', '#123456', 'rgba(1, 2, 3, 0.3)', 20, 1, 0);
    db.prepare(
      'INSERT INTO categories (id, name, color_hex, color_bg, sort_order, login_required, eismeister_managed) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(KAT_EISM_OEFFENTLICH, 'Eismeister offen', '#654321', 'rgba(3, 2, 1, 0.3)', 21, 0, 1);

    const app = require('../server/index');
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    const login = async (username) => {
      const res = await req('POST', '/api/auth/login', { username, password: 'testpass' });
      return res.body.token;
    };
    adminToken = await login('admin');
    editorToken = await login('editor');
    eismeisterToken = await login('eismeister');
  });

  afterAll(() => { if (server) server.close(); });

  it('legt die Kategorie "Eismeister" mit beiden Kennzeichen an', () => {
    const kat = db.prepare('SELECT * FROM categories WHERE name = ?').get('Eismeister');
    expect(kat).toBeDefined();
    expect(kat.login_required).toBe(1);
    expect(kat.eismeister_managed).toBe(1);
  });

  it('erlaubt die Rolle eismeister beim Anmelden', async () => {
    const res = await req('GET', '/api/auth/me', null, eismeisterToken);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('eismeister');
  });

  // ---- Rechte des Eismeisters (Anforderung 6) ----

  it('Eismeister darf in seiner Kategorie anlegen, bearbeiten und löschen', async () => {
    const angelegt = await req('POST', '/api/events', {
      title: 'Eisaufbereitung',
      start_time: '2026-09-21T06:00:00.000Z',
      end_time: '2026-09-21T07:00:00.000Z',
      category_id: KAT_EISMEISTER,
    }, eismeisterToken);
    expect(angelegt.status).toBe(201);

    const geaendert = await req('PUT', `/api/events/${angelegt.body.id}`, {
      title: 'Eisaufbereitung früh',
    }, eismeisterToken);
    expect(geaendert.status).toBe(200);
    expect(geaendert.body.titel).toBe('Eisaufbereitung früh');

    const geloescht = await req('DELETE', `/api/events/${angelegt.body.id}`, null, eismeisterToken);
    expect(geloescht.status).toBe(200);
  });

  it('Eismeister darf in keiner anderen Kategorie anlegen', async () => {
    const res = await req('POST', '/api/events', {
      title: 'Fremdes Training',
      start_time: '2026-09-21T18:00:00.000Z',
      end_time: '2026-09-21T20:00:00.000Z',
      category_id: KAT_ECB,
    }, eismeisterToken);
    expect(res.status).toBe(403);
  });

  it('Eismeister darf fremde Termine weder ändern noch löschen', async () => {
    const id = termin('ECB Training', KAT_ECB);

    const geaendert = await req('PUT', `/api/events/${id}`, { title: 'Gekapert' }, eismeisterToken);
    expect(geaendert.status).toBe(403);

    const geloescht = await req('DELETE', `/api/events/${id}`, null, eismeisterToken);
    expect(geloescht.status).toBe(403);

    // Unverändert in der DB
    const zeile = db.prepare('SELECT title FROM events WHERE id = ?').get(id);
    expect(zeile.title).toBe('ECB Training');
  });

  it('Eismeister darf Termine nicht in seine Kategorie hinein verschieben', async () => {
    const id = termin('Vermietung', KAT_ECB);
    const res = await req('PUT', `/api/events/${id}`, { category_id: KAT_EISMEISTER }, eismeisterToken);
    expect(res.status).toBe(403);
  });

  it('Eismeister darf Termine nicht aus seiner Kategorie heraus verschieben', async () => {
    const id = termin('Eiszeit', KAT_EISMEISTER);
    const res = await req('PUT', `/api/events/${id}`, { category_id: KAT_ECB }, eismeisterToken);
    expect(res.status).toBe(403);
  });

  it('Eismeister darf Serien in seiner Kategorie anlegen, sonst nicht', async () => {
    const erlaubt = await req('POST', '/api/events/series', {
      title: 'Wöchentliche Eisaufbereitung',
      category_id: KAT_EISMEISTER,
      weekday: 2,
      time_from: '06:00',
      time_to: '07:00',
      date_from: '2026-10-06',
      date_to: '2026-10-27',
    }, eismeisterToken);
    expect(erlaubt.status).toBe(201);

    const verboten = await req('POST', '/api/events/series', {
      title: 'Fremde Serie',
      category_id: KAT_ECB,
      weekday: 2,
      time_from: '18:00',
      time_to: '20:00',
      date_from: '2026-10-06',
      date_to: '2026-10-27',
    }, eismeisterToken);
    expect(verboten.status).toBe(403);
  });

  // ---- Anforderung 7: Editoren und Admins bleiben unbeschränkt ----

  it('Editor darf Eismeister-Termine ändern und löschen', async () => {
    const id = termin('Eisaufbereitung', KAT_EISMEISTER);

    const geaendert = await req('PUT', `/api/events/${id}`, { title: 'Verschoben' }, editorToken);
    expect(geaendert.status).toBe(200);
    expect(geaendert.body.titel).toBe('Verschoben');

    const geloescht = await req('DELETE', `/api/events/${id}`, null, editorToken);
    expect(geloescht.status).toBe(200);
  });

  it('Admin darf Eismeister-Termine anlegen', async () => {
    const res = await req('POST', '/api/events', {
      title: 'Sonderdienst',
      start_time: '2026-09-22T06:00:00.000Z',
      end_time: '2026-09-22T07:00:00.000Z',
      category_id: KAT_EISMEISTER,
    }, adminToken);
    expect(res.status).toBe(201);
  });

  // ---- Anforderung 5: Sichtbarkeit ----

  it('blendet anmeldepflichtige Termine für Anonyme aus, zeigt sie Angemeldeten', async () => {
    termin('Interner Dienst', KAT_EISMEISTER, '2026-09-23');
    const spanne = 'start=2026-09-23T00:00:00.000Z&end=2026-09-24T00:00:00.000Z';

    const anonym = await req('GET', `/api/events?${spanne}`);
    expect(anonym.status).toBe(200);
    expect(anonym.body.termine.filter(t => t.titel === 'Interner Dienst')).toHaveLength(0);

    const angemeldet = await req('GET', `/api/events?${spanne}`, null, eismeisterToken);
    expect(angemeldet.body.termine.filter(t => t.titel === 'Interner Dienst')).toHaveLength(1);
  });

  it('liefert einen anmeldepflichtigen Einzeltermin nur Angemeldeten', async () => {
    const id = termin('Geheimer Dienst', KAT_EISMEISTER, '2026-09-24');

    const anonym = await req('GET', `/api/events/${id}`);
    expect(anonym.status).toBe(404);

    const angemeldet = await req('GET', `/api/events/${id}`, null, editorToken);
    expect(angemeldet.status).toBe(200);
    expect(angemeldet.body.titel).toBe('Geheimer Dienst');
  });

  it('blendet anmeldepflichtige Kategorien in der öffentlichen Liste aus', async () => {
    const anonym = await req('GET', '/api/categories');
    expect(anonym.body.map(c => c.name)).not.toContain('Eismeister');

    const angemeldet = await req('GET', '/api/categories', null, eismeisterToken);
    expect(angemeldet.body.map(c => c.name)).toContain('Eismeister');
  });

  it('lässt anmeldepflichtige Termine nicht in den öffentlichen Hallen-Feed', async () => {
    termin('Dienst im Feed', KAT_EISMEISTER, '2026-09-25');
    termin('ECB im Feed', KAT_ECB, '2026-09-25');

    const res = await req('GET', '/feeds/halle.ics');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('Dienst im Feed');
    expect(res.body).toContain('ECB im Feed');
  });

  it('behandelt ein ungültiges Token wie "nicht angemeldet" statt mit 401', async () => {
    termin('Dienst mit Schrott-Token', KAT_EISMEISTER, '2026-09-26');
    const spanne = 'start=2026-09-26T00:00:00.000Z&end=2026-09-27T00:00:00.000Z';

    const res = await req('GET', `/api/events?${spanne}`, null, 'kein.gueltiges.token');
    expect(res.status).toBe(200);
    expect(res.body.termine.filter(t => t.titel === 'Dienst mit Schrott-Token')).toHaveLength(0);
  });

  // ---- Die beiden Kennzeichen wirken unabhängig ----

  it('zeigt eine Eismeister-Kategorie ohne Anmeldepflicht öffentlich', async () => {
    termin('Offener Dienst', KAT_EISM_OEFFENTLICH, '2026-09-27');
    const spanne = 'start=2026-09-27T00:00:00.000Z&end=2026-09-28T00:00:00.000Z';

    const anonym = await req('GET', `/api/events?${spanne}`);
    expect(anonym.body.termine.filter(t => t.titel === 'Offener Dienst')).toHaveLength(1);

    // Und der Eismeister darf sie trotzdem bearbeiten
    const angelegt = await req('POST', '/api/events', {
      title: 'Offen angelegt',
      start_time: '2026-09-27T06:00:00.000Z',
      end_time: '2026-09-27T07:00:00.000Z',
      category_id: KAT_EISM_OEFFENTLICH,
    }, eismeisterToken);
    expect(angelegt.status).toBe(201);
  });

  it('sperrt eine interne Kategorie ohne Eismeister-Kennzeichen für den Eismeister', async () => {
    const res = await req('POST', '/api/events', {
      title: 'Intern, aber nicht für Eismeister',
      start_time: '2026-09-28T18:00:00.000Z',
      end_time: '2026-09-28T20:00:00.000Z',
      category_id: KAT_NUR_INTERN,
    }, eismeisterToken);
    expect(res.status).toBe(403);

    // Für den Editor erlaubt, aber öffentlich unsichtbar
    const erlaubt = await req('POST', '/api/events', {
      title: 'Intern vom Editor',
      start_time: '2026-09-28T18:00:00.000Z',
      end_time: '2026-09-28T20:00:00.000Z',
      category_id: KAT_NUR_INTERN,
    }, editorToken);
    expect(erlaubt.status).toBe(201);

    const anonym = await req('GET', '/api/events?start=2026-09-28T00:00:00.000Z&end=2026-09-29T00:00:00.000Z');
    expect(anonym.body.termine.filter(t => t.titel === 'Intern vom Editor')).toHaveLength(0);
  });

  // ---- Benutzerverwaltung ----

  it('nimmt die Rolle eismeister bei der Benutzeranlage an', async () => {
    const res = await req('POST', '/api/users', {
      username: 'zweiter-eismeister',
      password: 'geheim123',
      role: 'eismeister',
      display_name: 'Zweiter Eismeister',
    }, adminToken);

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('eismeister');
  });

  it('lehnt eine unbekannte Rolle weiterhin ab', async () => {
    const res = await req('POST', '/api/users', {
      username: 'hausmeister',
      password: 'geheim123',
      role: 'hausmeister',
      display_name: 'Hausmeister',
    }, adminToken);

    expect(res.status).toBe(400);
  });
});
