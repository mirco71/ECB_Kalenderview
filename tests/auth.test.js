// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
const http = require('http');
const bcrypt = require('bcryptjs');

// Use in-memory test database
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-auth';
process.env.PORT = '0';

let server, baseUrl;

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

describe('Auth API', () => {
  beforeAll(async () => {
    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    const db = getDb();

    // Seed admin user
    const hash = bcrypt.hashSync('testpass123', 4);
    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run('admin', hash, 'admin', 'Test Admin');

    const app = require('../server/index');

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  afterAll(() => { if (server) server.close(); });

  it('should reject login with wrong credentials', async () => {
    const res = await req('POST', '/api/auth/login', {
      username: 'admin', password: 'wrongpassword',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('should login with correct credentials', async () => {
    const res = await req('POST', '/api/auth/login', {
      username: 'admin', password: 'testpass123',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.username).toBe('admin');
    expect(res.body.user.role).toBe('admin');
  });

  it('should return user info with valid token', async () => {
    const login = await req('POST', '/api/auth/login', {
      username: 'admin', password: 'testpass123',
    });
    const res = await req('GET', '/api/auth/me', null, login.body.token);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('admin');
  });

  it('should reject requests without token', async () => {
    const res = await req('GET', '/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('should reject requests with invalid token', async () => {
    const res = await req('GET', '/api/auth/me', null, 'invalid-token');
    expect(res.status).toBe(401);
  });

  it('should reject login with missing fields', async () => {
    const res = await req('POST', '/api/auth/login', { username: 'admin' });
    expect(res.status).toBe(400);
  });
});
