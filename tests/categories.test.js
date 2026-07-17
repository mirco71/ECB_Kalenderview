// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
const http = require('http');
const bcrypt = require('bcryptjs');

// Use in-memory test database
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-categories';
process.env.PORT = '0';

let server, baseUrl, adminToken, editorToken;

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

describe('Categories API', () => {
  beforeAll(async () => {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server')) delete require.cache[key];
    });

    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    const db = getDb();

    // Seed admin + editor
    const hash = bcrypt.hashSync('testpass', 4);
    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run('admin', hash, 'admin', 'Admin');
    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run('editor', hash, 'editor', 'Editor');

    const app = require('../server/index');

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    const adminLogin = await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass' });
    adminToken = adminLogin.body.token;

    const editorLogin = await req('POST', '/api/auth/login', { username: 'editor', password: 'testpass' });
    editorToken = editorLogin.body.token;
  });

  afterAll(() => { if (server) server.close(); });

  it('should list seeded categories without auth', async () => {
    const res = await req('GET', '/api/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(11);
    expect(res.body.find(c => c.name === 'ECB')).toBeDefined();
  });

  it('should allow admin to create a category', async () => {
    const res = await req('POST', '/api/categories', {
      name: 'Testkat',
      color_hex: '#ff0000',
      color_bg: 'rgba(255, 0, 0, 0.3)',
      sort_order: 99,
    }, adminToken);

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Testkat');
    expect(res.body.color_hex).toBe('#ff0000');
  });

  it('should reject editor from creating categories', async () => {
    const res = await req('POST', '/api/categories', {
      name: 'EditorCat',
      color_hex: '#00ff00',
      color_bg: 'rgba(0, 255, 0, 0.3)',
    }, editorToken);

    expect(res.status).toBe(403);
  });

  it('should reject duplicate category name', async () => {
    const res = await req('POST', '/api/categories', {
      name: 'ECB',
      color_hex: '#000000',
      color_bg: 'rgba(0, 0, 0, 0.3)',
    }, adminToken);

    expect(res.status).toBe(409);
  });

  it('should allow admin to update a category', async () => {
    const list = await req('GET', '/api/categories');
    const testCat = list.body.find(c => c.name === 'Testkat');

    const res = await req('PUT', `/api/categories/${testCat.id}`, {
      name: 'Testkat Updated',
    }, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Testkat Updated');
  });

  it('should allow admin to delete an unused category', async () => {
    const list = await req('GET', '/api/categories');
    const testCat = list.body.find(c => c.name === 'Testkat Updated');

    const res = await req('DELETE', `/api/categories/${testCat.id}`, null, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.erfolg).toBe(true);
  });

  it('should prevent deleting a category with events', async () => {
    // Create an event using category 7 (ECB)
    await req('POST', '/api/events', {
      title: 'Block Delete Test',
      start_time: '2026-04-10T10:00:00.000Z',
      end_time: '2026-04-10T12:00:00.000Z',
      category_id: 7,
    }, adminToken);

    const res = await req('DELETE', '/api/categories/7', null, adminToken);
    expect(res.status).toBe(409);
  });

  it('should reject invalid color hex', async () => {
    const res = await req('POST', '/api/categories', {
      name: 'BadColor',
      color_hex: 'not-a-color',
      color_bg: 'rgba(0,0,0,0.3)',
    }, adminToken);

    expect(res.status).toBe(400);
  });
});
