// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
const http = require('http');
const bcrypt = require('bcryptjs');

// Use in-memory test database
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-auth';
process.env.PORT = '0';

let server, baseUrl;

// Das Anmelde-Token kommt als HttpOnly-Cookie (ecb_session), nicht mehr im Body.
function sessionToken(res) {
  const cookies = [].concat(res.headers['set-cookie'] || []);
  const treffer = cookies.map(c => /^ecb_session=([^;]*)/.exec(c)).find(Boolean);
  return treffer ? treffer[1] : undefined;
}

function req(method, urlPath, body = null, token = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: new URL(baseUrl).port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
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
    expect(sessionToken(res)).toBeDefined();
    expect(res.body.user.username).toBe('admin');
    expect(res.body.user.role).toBe('admin');
  });

  it('should return user info with valid token', async () => {
    const login = await req('POST', '/api/auth/login', {
      username: 'admin', password: 'testpass123',
    });
    const res = await req('GET', '/api/auth/me', null, sessionToken(login));
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

  // Behind the Cloudflare tunnel all requests arrive from cloudflared; the limit
  // must count per real client (CF-Connecting-IP), not lock everyone out at once.
  it('should rate-limit logins per CF-Connecting-IP', async () => {
    const angreifer = { 'CF-Connecting-IP': '203.0.113.7' };
    const falsch = { username: 'admin', password: 'wrongpassword' };

    for (let i = 0; i < 20; i++) {
      await req('POST', '/api/auth/login', falsch, null, angreifer);
    }
    const gesperrt = await req('POST', '/api/auth/login', falsch, null, angreifer);
    expect(gesperrt.status).toBe(429);

    const andererClient = await req('POST', '/api/auth/login', {
      username: 'admin', password: 'testpass123',
    }, null, { 'CF-Connecting-IP': '198.51.100.23' });
    expect(andererClient.status).toBe(200);
  });

  // Successful logins and /me checks (every page load) must not fill the quota.
  it('should not count successful auth requests against the limit', async () => {
    const client = { 'CF-Connecting-IP': '198.51.100.77' };
    const richtig = { username: 'admin', password: 'testpass123' };

    for (let i = 0; i < 25; i++) {
      const login = await req('POST', '/api/auth/login', richtig, null, client);
      expect(login.status).toBe(200);
      const me = await req('GET', '/api/auth/me', null, sessionToken(login), client);
      expect(me.status).toBe(200);
    }
  });

  describe('eigenes Passwort ändern', () => {
    // Eigener Limiter-Topf: Fehlgeschlagene /api/auth-Aufrufe zählen gegen die
    // Login-Sperre, ohne eigene Adresse teilten sich diese Tests das Kontingent.
    const client = { 'CF-Connecting-IP': '192.0.2.50' };
    let token;

    const anmelden = (password) =>
      req('POST', '/api/auth/login', { username: 'editor', password }, null, client);

    beforeAll(async () => {
      const { getDb } = require('../server/database');
      getDb()
        .prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
        .run('editor', bcrypt.hashSync('altesPasswort', 4), 'editor', 'Test Editor');
      token = sessionToken(await anmelden('altesPasswort'));
    });

    it('ändert das Passwort, danach gilt nur noch das neue', async () => {
      const res = await req('PUT', '/api/auth/password', {
        current_password: 'altesPasswort',
        new_password: 'neuesPasswort',
      }, token, client);
      expect(res.status).toBe(200);
      // Die Passwortänderung widerruft das alte Token; die Antwort liefert ein neues Cookie.
      token = sessionToken(res);

      expect((await anmelden('neuesPasswort')).status).toBe(200);
      expect((await anmelden('altesPasswort')).status).toBe(401);
    });

    it('lehnt ein falsches aktuelles Passwort ab', async () => {
      const res = await req('PUT', '/api/auth/password', {
        current_password: 'geraten',
        new_password: 'nochNeuer1',
      }, token, client);
      expect(res.status).toBe(401);

      // Unverändert: das zuletzt gesetzte Passwort gilt weiter
      expect((await anmelden('neuesPasswort')).status).toBe(200);
    });

    it('lehnt ein zu kurzes neues Passwort ab', async () => {
      const res = await req('PUT', '/api/auth/password', {
        current_password: 'neuesPasswort',
        new_password: '123',
      }, token, client);
      expect(res.status).toBe(400);
    });

    it('verlangt eine Anmeldung', async () => {
      const res = await req('PUT', '/api/auth/password', {
        current_password: 'neuesPasswort',
        new_password: 'egalWas1',
      }, null, client);
      expect(res.status).toBe(401);
    });

    it('lehnt ein Sync-Token ab', async () => {
      const res = await req('PUT', '/api/auth/password', {
        current_password: 'neuesPasswort',
        new_password: 'egalWas1',
      }, 'ecbsync_irgendwas', client);
      expect(res.status).toBe(401);
    });
  });

  describe('Sitzung per HttpOnly-Cookie, Widerruf, Laufzeit', () => {
    let nr = 0;
    // Eigene Client-Adresse je Aufruf: Fehlversuche zählen gegen die Login-Sperre.
    const ip = () => ({ 'CF-Connecting-IP': `192.0.2.${100 + (nr++)}` });
    const anmelden = (username, password = 'testpass123') =>
      req('POST', '/api/auth/login', { username, password }, null, ip());

    function legeBenutzerAn(username, role) {
      const { getDb } = require('../server/database');
      const db = getDb();
      db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
        .run(username, bcrypt.hashSync('testpass123', 4), role, username);
      return db;
    }

    it('setzt beim Login ein HttpOnly/SameSite=Strict-Cookie und liefert kein token im Body', async () => {
      const res = await anmelden('admin');
      expect(res.status).toBe(200);
      expect(res.body.token).toBeUndefined();
      expect(res.body.user.username).toBe('admin');

      const cookie = [].concat(res.headers['set-cookie'] || []).find(c => c.startsWith('ecb_session='));
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/(;|$)/);
      expect(cookie).toMatch(/Max-Age=28800/);
    });

    it('akzeptiert eine Anfrage nur mit Cookie (ohne Bearer)', async () => {
      const token = sessionToken(await anmelden('admin'));
      const res = await req('GET', '/api/auth/me', null, null, { Cookie: `ecb_session=${token}` });
      expect(res.status).toBe(200);
      expect(res.body.username).toBe('admin');
    });

    it('läuft nach 8 Stunden ab', async () => {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.decode(sessionToken(await anmelden('admin')));
      expect(decoded.exp - decoded.iat).toBe(28800);
      expect(decoded.tv).toBe(0);
    });

    it('widerruft die Sitzung beim Abmelden und löscht das Cookie', async () => {
      const token = sessionToken(await anmelden('admin'));
      const res = await req('POST', '/api/auth/logout', {}, token);
      expect(res.status).toBe(200);
      expect(res.body.erfolg).toBe(true);

      const cookie = [].concat(res.headers['set-cookie'] || []).find(c => c.startsWith('ecb_session='));
      expect(cookie).toMatch(/Max-Age=0/);
      expect(cookie).toMatch(/HttpOnly/i);

      expect((await req('GET', '/api/auth/me', null, token)).status).toBe(401);
    });

    it('verlangt für das Abmelden eine Anmeldung', async () => {
      expect((await req('POST', '/api/auth/logout', {})).status).toBe(401);
    });

    it('macht nach einer Passwortänderung alte Token ungültig, das neue Cookie gilt', async () => {
      legeBenutzerAn('wechsler', 'editor');
      const alt = sessionToken(await anmelden('wechsler'));
      const res = await req('PUT', '/api/auth/password', {
        current_password: 'testpass123', new_password: 'brandNeu12345',
      }, alt);
      expect(res.status).toBe(200);

      const neu = sessionToken(res);
      expect(neu).toBeDefined();
      expect(neu).not.toBe(alt);
      expect((await req('GET', '/api/auth/me', null, alt)).status).toBe(401);
      expect((await req('GET', '/api/auth/me', null, neu)).status).toBe(200);
    });

    it('übernimmt Rollenänderungen aus der Datenbank, nicht aus dem Token', async () => {
      const db = legeBenutzerAn('aufsteiger', 'editor');
      const token = sessionToken(await anmelden('aufsteiger'));
      // /api/users ist nur für Administratoren
      expect((await req('GET', '/api/users', null, token)).status).toBe(403);

      db.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run('aufsteiger');
      expect((await req('GET', '/api/users', null, token)).status).toBe(200);

      db.prepare("UPDATE users SET role = 'editor' WHERE username = ?").run('aufsteiger');
      expect((await req('GET', '/api/users', null, token)).status).toBe(403);
    });

    it('lehnt das Token eines gelöschten Benutzers ab', async () => {
      const db = legeBenutzerAn('verschwindet', 'editor');
      const token = sessionToken(await anmelden('verschwindet'));
      expect((await req('GET', '/api/auth/me', null, token)).status).toBe(200);

      db.prepare('DELETE FROM users WHERE username = ?').run('verschwindet');
      expect((await req('GET', '/api/auth/me', null, token)).status).toBe(401);
    });

    it('lehnt schreibende Cookie-Anfragen mit fremdem Origin ab, mit passendem Origin nicht', async () => {
      const token = sessionToken(await anmelden('admin'));
      const cookie = { Cookie: `ecb_session=${token}` };

      const fremd = await req('POST', '/api/auth/logout', {}, null,
        { ...cookie, Origin: 'http://boese.example' });
      expect(fremd.status).toBe(403);

      // Ohne Origin-Header ebenfalls abgelehnt
      expect((await req('POST', '/api/auth/logout', {}, null, cookie)).status).toBe(403);

      // Das Token ist durch die abgelehnten Anfragen nicht widerrufen worden
      expect((await req('GET', '/api/auth/me', null, null, cookie)).status).toBe(200);

      const passend = await req('POST', '/api/auth/logout', {}, null, { ...cookie, Origin: baseUrl });
      expect(passend.status).toBeGreaterThanOrEqual(200);
      expect(passend.status).toBeLessThan(300);
    });

    it('vergleicht den Origin nur über den Host, nicht über das Protokoll', async () => {
      const token = sessionToken(await anmelden('admin'));
      const host = new URL(baseUrl).host;
      const cookie = { Cookie: `ecb_session=${token}` };
      const logout = (origin) => req('POST', '/api/auth/logout', {}, null, { ...cookie, Origin: origin });

      expect((await logout('http://evil.example')).status).toBe(403);
      expect((await logout('null')).status).toBe(403);
      expect((await logout('kein url')).status).toBe(403);

      // https-Origin gegen den http-Testserver: Proxys terminieren TLS
      const res = await logout(`https://${host}`);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });

    it('beendet Sitzungen, wenn ein Admin das Passwort über /api/users zurücksetzt', async () => {
      const db = legeBenutzerAn('zuruecksetzen', 'editor');
      const admin = sessionToken(await anmelden('admin'));
      const editor = sessionToken(await anmelden('zuruecksetzen'));
      const id = db.prepare("SELECT id FROM users WHERE username = 'zuruecksetzen'").get().id;

      // Nur der Anzeigename: Token bleibt gültig
      expect((await req('PUT', `/api/users/${id}`, { display_name: 'Neuer Name' }, admin)).status).toBe(200);
      expect((await req('GET', '/api/auth/me', null, editor)).status).toBe(200);

      const res = await req('PUT', `/api/users/${id}`, { password: 'zurueckgesetzt1' }, admin);
      expect(res.status).toBe(200);
      expect((await req('GET', '/api/auth/me', null, editor)).status).toBe(401);
      expect((await anmelden('zuruecksetzen', 'zurueckgesetzt1')).status).toBe(200);
      // Der Admin bleibt angemeldet (anderer Benutzer, kein neues Cookie nötig)
      expect((await req('GET', '/api/auth/me', null, admin)).status).toBe(200);
    });

    it('gibt dem Admin ein neues Cookie, wenn er sein eigenes Passwort über /api/users ändert', async () => {
      const db = legeBenutzerAn('selbstadmin', 'admin');
      const alt = sessionToken(await anmelden('selbstadmin'));
      const id = db.prepare("SELECT id FROM users WHERE username = 'selbstadmin'").get().id;

      const res = await req('PUT', `/api/users/${id}`, { password: 'selbstNeu12' }, alt);
      expect(res.status).toBe(200);
      const neu = sessionToken(res);
      expect(neu).toBeDefined();
      expect((await req('GET', '/api/auth/me', null, alt)).status).toBe(401);
      expect((await req('GET', '/api/auth/me', null, neu)).status).toBe(200);
    });

    it('erlaubt schreibende Cookie-Anfragen mit Sec-Fetch-Site: same-origin', async () => {
      const token = sessionToken(await anmelden('admin'));
      const res = await req('POST', '/api/auth/logout', {}, null,
        { Cookie: `ecb_session=${token}`, 'Sec-Fetch-Site': 'same-origin' });
      expect(res.status).toBe(200);
    });

    it('prüft den Origin nicht bei Bearer-Header', async () => {
      const token = sessionToken(await anmelden('admin'));
      const res = await req('POST', '/api/auth/logout', {}, token, { Origin: 'http://boese.example' });
      expect(res.status).toBe(200);
    });

    it('akzeptiert ein Sync-Token nur im Bearer-Header, nicht im Cookie', async () => {
      const { getDb } = require('../server/database');
      const adminId = getDb().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
      const { erzeugeToken } = require('../server/synctoken');
      const { token } = erzeugeToken('Cookie-Test', adminId);

      expect((await req('GET', '/api/sync/status', null, token)).status).toBe(200);
      expect((await req('GET', '/api/sync/status', null, null,
        { Cookie: `ecb_session=${token}` })).status).toBe(401);
    });
  });
});
