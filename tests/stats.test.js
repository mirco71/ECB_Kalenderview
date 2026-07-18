// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
const http = require('http');
const bcrypt = require('bcryptjs');

// Use in-memory test database
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-stats';
process.env.PORT = '0';

let server, baseUrl, adminToken;

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

describe('Stats API', () => {
  beforeAll(async () => {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server')) delete require.cache[key];
    });

    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    const db = getDb();

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

    // Kategorie 8 = Vermietung (group_by_title = 0 → eine Summe)
    // Kategorie 5 = Hobbies    (group_by_title = 1 → nach Titel aufgeschlüsselt)
    // Kategorie 7 = ECB        (group_by_title = 0)
    const fixtures = [
      ['Eisdisco GmbH', '2026-06-05T18:00:00.000Z', '2026-06-05T19:30:00.000Z', 8], //  90
      ['Eisdisco GmbH', '2026-06-12T18:00:00.000Z', '2026-06-12T19:30:00.000Z', 8], //  90
      ['Firmenfeier', '2026-06-20T10:00:00.000Z', '2026-06-20T12:00:00.000Z', 8],   // 120
      ['Training', '2026-06-10T17:00:00.000Z', '2026-06-10T19:00:00.000Z', 7],      // 120
      ['Kurs A', '2026-06-08T09:00:00.000Z', '2026-06-08T10:00:00.000Z', 5],        //  60
      ['Kurs A', '2026-06-15T09:00:00.000Z', '2026-06-15T10:00:00.000Z', 5],        //  60
      ['Kurs B', '2026-06-22T09:00:00.000Z', '2026-06-22T10:30:00.000Z', 5],        //  90
      ['Außerhalb', '2026-07-10T17:00:00.000Z', '2026-07-10T19:00:00.000Z', 2],
    ];
    for (const [title, start_time, end_time, category_id] of fixtures) {
      await req('POST', '/api/events', { title, start_time, end_time, category_id }, adminToken);
    }
  });

  afterAll(() => { if (server) server.close(); });

  const range = 'start=2026-06-01T00:00:00.000Z&end=2026-07-01T00:00:00.000Z';

  it('should require authentication', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=7,8`);
    expect(res.status).toBe(401);
  });

  it('should aggregate durations per category', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=7,8`, null, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.erfolg).toBe(true);

    expect(res.body.gesamt.anzahl).toBe(4);
    expect(res.body.gesamt.dauerMinuten).toBe(90 + 90 + 120 + 120);

    const ecb = res.body.gruppen.find(g => g.category_id === 7);
    expect(ecb.anzahl).toBe(1);
    expect(ecb.dauerMinuten).toBe(120);
  });

  it('should sum Vermietung into a single row without title breakdown', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=8`, null, adminToken);

    expect(res.body.gruppen).toHaveLength(1);
    const vermietung = res.body.gruppen[0];
    expect(vermietung.category_id).toBe(8);
    expect(vermietung.anzahl).toBe(3);
    expect(vermietung.dauerMinuten).toBe(300);
    // Vermietung läuft bewusst in einer Summe zusammen — keine Mieter-Aufschlüsselung
    expect(vermietung.titel).toBeNull();
  });

  it('should break down categories flagged with group_by_title', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=5`, null, adminToken);
    const hobbies = res.body.gruppen.find(g => g.category_id === 5);

    expect(hobbies.anzahl).toBe(3);
    expect(hobbies.dauerMinuten).toBe(210);
    expect(hobbies.titel).toHaveLength(2);

    const kursA = hobbies.titel.find(t => t.titel === 'Kurs A');
    expect(kursA.anzahl).toBe(2);
    expect(kursA.dauerMinuten).toBe(120);
    const kursB = hobbies.titel.find(t => t.titel === 'Kurs B');
    expect(kursB.anzahl).toBe(1);
    expect(kursB.dauerMinuten).toBe(90);
  });

  it('should follow the group_by_title flag when it changes', async () => {
    // Vermietung auf Aufschlüsselung umstellen
    await req('PUT', '/api/categories/8', { group_by_title: true }, adminToken);

    const res = await req('GET', `/api/stats?${range}&category_ids=8`, null, adminToken);
    const vermietung = res.body.gruppen[0];
    expect(vermietung.titel).toHaveLength(2);
    expect(vermietung.titel.find(t => t.titel === 'Eisdisco GmbH').dauerMinuten).toBe(180);

    // wieder zurücksetzen
    await req('PUT', '/api/categories/8', { group_by_title: false }, adminToken);
    const res2 = await req('GET', `/api/stats?${range}&category_ids=8`, null, adminToken);
    expect(res2.body.gruppen[0].titel).toBeNull();
  });

  it('should only include requested categories', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=7`, null, adminToken);
    expect(res.body.gruppen).toHaveLength(1);
    expect(res.body.gruppen[0].category_id).toBe(7);
    expect(res.body.gesamt.anzahl).toBe(1);
  });

  it('should exclude events outside the range', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=2`, null, adminToken);
    expect(res.body.gruppen).toHaveLength(0);
    expect(res.body.gesamt.anzahl).toBe(0);
  });

  it('should reject invalid category_ids', async () => {
    const res = await req('GET', `/api/stats?${range}&category_ids=7;DROP`, null, adminToken);
    expect(res.status).toBe(400);
  });

  it('should reject end before start', async () => {
    const res = await req(
      'GET',
      '/api/stats?start=2026-07-01T00:00:00.000Z&end=2026-06-01T00:00:00.000Z&category_ids=7',
      null,
      adminToken
    );
    expect(res.status).toBe(400);
  });
});
