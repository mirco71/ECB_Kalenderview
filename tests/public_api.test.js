// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
//
// Paket D: Die öffentliche API gibt keine internen Felder (created_by) und keine
// Auswärtstermine heraus, Farbwerte aus der Datenbank gehen nur validiert nach
// außen, und IP-Adressen im Änderungsprotokoll werden nach 90 Tagen entfernt.
const http = require('http');
const bcrypt = require('bcryptjs');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-public-api';
process.env.PORT = '0';

let server, baseUrl, adminToken, db, audit;

function sessionToken(res) {
  const cookies = [].concat(res.headers['set-cookie'] || []);
  const treffer = cookies.map(c => /^ecb_session=([^;]*)/.exec(c)).find(Boolean);
  return treffer ? treffer[1] : undefined;
}

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
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const range = 'start=2026-10-01T00:00:00.000Z&end=2026-11-01T00:00:00.000Z';
let adminId, heimId, externId, evilCatId, evilCatEventId;

describe('Paket D — öffentliche API, Farben, Audit-IP', () => {
  beforeAll(async () => {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server')) delete require.cache[key];
    });
    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    db = getDb();
    audit = require('../server/audit');

    const hash = bcrypt.hashSync('testpass', 4);
    adminId = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run('admin', hash, 'admin', 'Test Admin').lastInsertRowid;

    const app = require('../server/index');
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
    const loginRes = await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass' });
    adminToken = sessionToken(loginRes);

    const ins = (title, start, end, cat, inHall) => db.prepare(
      `INSERT INTO events (title, start_time, end_time, category_id, in_hall, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(title, start, end, cat, inHall, adminId).lastInsertRowid;
    heimId = ins('Heimtraining', '2026-10-07T15:00:00.000Z', '2026-10-07T17:00:00.000Z', 7, 1);
    externId = ins('Auswärts Neuss', '2026-10-10T15:00:00.000Z', '2026-10-10T17:00:00.000Z', 7, 0);

    db.prepare(
      `INSERT INTO categories (name, color_hex, color_bg, sort_order) VALUES (?, ?, ?, 99)`
    ).run('Eingeschleust', 'red;background:url(x)', 'red;background:url(y)');
    evilCatId = db.prepare("SELECT id FROM categories WHERE name = 'Eingeschleust'").get().id;
    evilCatEventId = ins('Termin mit Fremdfarbe', '2026-10-12T15:00:00.000Z', '2026-10-12T16:00:00.000Z', evilCatId, 1);
  });

  afterAll(() => { if (server) server.close(); });

  // ---- created_by ----

  it('gibt created_by anonym in der Terminliste nicht aus', async () => {
    const res = await req('GET', `/api/events?${range}`);
    expect(res.body.termine.length).toBeGreaterThan(0);
    for (const t of res.body.termine) expect(t).not.toHaveProperty('created_by');
  });

  it('gibt created_by angemeldet in der Terminliste aus', async () => {
    const res = await req('GET', `/api/events?${range}`, null, adminToken);
    const t = res.body.termine.find(x => x.id === heimId);
    expect(t.created_by).toBe(adminId);
  });

  it('gibt created_by anonym bei /api/events/:id nicht aus, angemeldet schon', async () => {
    const anon = await req('GET', `/api/events/${heimId}`);
    expect(anon.status).toBe(200);
    expect(anon.body).not.toHaveProperty('created_by');
    const auth = await req('GET', `/api/events/${heimId}`, null, adminToken);
    expect(auth.body.created_by).toBe(adminId);
  });

  // ---- include_extern ----

  it('ignoriert include_extern anonym', async () => {
    const res = await req('GET', `/api/events?${range}&include_extern=1`);
    const titel = res.body.termine.map(t => t.titel);
    expect(titel).toContain('Heimtraining');
    expect(titel).not.toContain('Auswärts Neuss');
  });

  it('liefert include_extern angemeldet mit Auswärtsterminen', async () => {
    const res = await req('GET', `/api/events?${range}&include_extern=1`, null, adminToken);
    expect(res.body.termine.map(t => t.titel)).toContain('Auswärts Neuss');
  });

  // ---- Farben ----

  it('gibt eingeschleuste Farbwerte nicht aus, sondern den Standardwert', async () => {
    const res = await req('GET', `/api/events?${range}`);
    const t = res.body.termine.find(x => x.id === evilCatEventId);
    expect(t.farbHex).toBe('#888888');
    expect(t.farbBg).toBe('rgba(136,136,136,0.2)');
    const einzeln = await req('GET', `/api/events/${evilCatEventId}`);
    expect(einzeln.body.farbHex).toBe('#888888');
    expect(einzeln.body.farbBg).toBe('rgba(136,136,136,0.2)');
  });

  it('lässt gültige Farben unverändert', async () => {
    const res = await req('GET', `/api/events?${range}`);
    const t = res.body.termine.find(x => x.id === heimId);
    expect(t.farbHex).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(t.farbBg).toMatch(/^(#|rgba?\()/);
  });

  it('gibt eingeschleuste Farbwerte auch über /api/categories nicht aus', async () => {
    const res = await req('GET', '/api/categories');
    const k = res.body.find(c => c.name === 'Eingeschleust');
    expect(k.color_hex).toBe('#888888');
    expect(k.color_bg).toBe('rgba(136,136,136,0.2)');
  });

  it('gibt eingeschleuste Farbwerte auch in der Abrechnung nicht aus', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=${evilCatId}`, null, adminToken);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('url(');
    expect(JSON.stringify(res.body)).toContain('#888888');
  });

  // ---- Audit-IP ----

  it('entfernt die IP nach 90 Tagen, behält den Eintrag', () => {
    const ins = (tage) => db.prepare(
      `INSERT INTO audit_log (created_at, action, entity_type, summary, ip)
       VALUES (datetime('now', ?), 'test', 'test', ?, '203.0.113.7')`
    ).run(`-${tage} days`, `alt ${tage}`).lastInsertRowid;
    const alt = ins(100);
    const neu = ins(10);
    audit.pruneAudit(db);
    expect(db.prepare('SELECT ip FROM audit_log WHERE id = ?').get(alt).ip).toBeNull();
    expect(db.prepare('SELECT ip FROM audit_log WHERE id = ?').get(neu).ip).toBe('203.0.113.7');
  });
});
