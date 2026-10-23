// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
//
// Login-Schleife durch veraltetes api.js im Browser-Cache ("Bearer undefined")
// und Cache-Busting der JS/CSS-Referenzen in den HTML-Seiten.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-login-cache';
process.env.PORT = '0';
process.env.SECURE_TRANSPORT = 'false';

let server, port;

function sessionToken(res) {
  const cookies = [].concat(res.headers['set-cookie'] || []);
  const treffer = cookies.map(c => /^ecb_session=([^;]*)/.exec(c)).find(Boolean);
  return treffer ? treffer[1] : undefined;
}

function request(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== null) h['Content-Type'] = 'application/json';
    const r = http.request({ hostname: 'localhost', port, path: urlPath, method, headers: h }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch { /* HTML etc. */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
      });
    });
    r.on('error', reject);
    if (body !== null) r.write(JSON.stringify(body));
    r.end();
  });
}

const login = () => request('POST', '/api/auth/login', { username: 'admin', password: 'testpass123' });

describe('Login-Schleife durch veraltete Skripte', () => {
  beforeAll(async () => {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server')) delete require.cache[key];
    });
    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    const hash = bcrypt.hashSync('testpass123', 4);
    getDb().prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run('admin', hash, 'admin', 'Test Admin');
    const app = require('../server/index');
    await new Promise((resolve) => {
      server = app.listen(0, () => { port = server.address().port; resolve(); });
    });
  });

  afterAll(() => { if (server) server.close(); });

  describe('Cookie als Rückfall', () => {
    it('akzeptiert das Cookie trotz "Bearer undefined"', async () => {
      const token = sessionToken(await login());
      const res = await request('GET', '/api/auth/me', null, {
        Authorization: 'Bearer undefined',
        Cookie: `ecb_session=${token}`,
      });
      expect(res.status).toBe(200);
      expect(res.body.username).toBe('admin');
    });

    it('akzeptiert das Cookie trotz widerrufenem Bearer-JWT', async () => {
      const alt = sessionToken(await login());
      const out = await request('POST', '/api/auth/logout', {}, {
        Cookie: `ecb_session=${alt}`,
        Origin: `http://localhost:${port}`,
      });
      expect(out.status).toBe(200);
      const neu = sessionToken(await login());
      const res = await request('GET', '/api/auth/me', null, {
        Authorization: `Bearer ${alt}`,
        Cookie: `ecb_session=${neu}`,
      });
      expect(res.status).toBe(200);
      // Der widerrufene Token allein bleibt abgelehnt.
      const nurAlt = await request('GET', '/api/auth/me', null, { Authorization: `Bearer ${alt}` });
      expect(nurAlt.status).toBe(401);
    });

    it('lehnt "Bearer undefined" ohne Cookie mit 401 ab', async () => {
      const res = await request('GET', '/api/auth/me', null, { Authorization: 'Bearer undefined' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Ungültiger oder abgelaufener Token');
    });

    it('prüft beim Rückfall auf das Cookie die Herkunft schreibender Anfragen', async () => {
      const token = sessionToken(await login());
      const headers = { Authorization: 'Bearer undefined', Cookie: `ecb_session=${token}` };
      const kat = (name) => ({ name, color_hex: '#ff0000', color_bg: '#ffeeee' });

      const fremd = await request('POST', '/api/categories', kat('Fremd'), {
        ...headers, Origin: 'https://boese.example',
      });
      expect(fremd.status).toBe(403);

      const eigen = await request('POST', '/api/categories', kat('Eigen'), {
        ...headers, Origin: `http://localhost:${port}`,
      });
      expect(eigen.status).toBeGreaterThanOrEqual(200);
      expect(eigen.status).toBeLessThan(300);
    });
  });

  describe('Cache-Busting', () => {
    const REF = /(?:src|href)="(\/(?:js|css)\/[^"]*)"/g;

    for (const p of ['/', '/login.html', '/admin.html', '/irgendwas']) {
      it(`versioniert alle JS/CSS-Referenzen auf ${p}`, async () => {
        const res = await request('GET', p);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html; charset=utf-8/i);
        expect(res.headers['cache-control']).toBe('no-cache');
        expect(res.headers['content-security-policy']).toBeDefined();
        const refs = [...res.raw.matchAll(REF)].map(m => m[1]);
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) expect(ref).toMatch(/^\/(?:js|css)\/[\w.-]+\.(?:js|css)\?v=[0-9a-f]{10}$/);
      });
    }

    it('lässt X-Robots-Tag auf login/admin, nicht auf /', async () => {
      expect((await request('GET', '/login.html')).headers['x-robots-tag']).toBe('noindex, nofollow');
      expect((await request('GET', '/admin.html')).headers['x-robots-tag']).toBe('noindex, nofollow');
      expect((await request('GET', '/')).headers['x-robots-tag']).toBeUndefined();
    });

    it('liefert versionierte Skripte weiterhin aus', async () => {
      const home = await request('GET', '/');
      const ref = [...home.raw.matchAll(REF)].map(m => m[1]).find(r => r.startsWith('/js/api.js'));
      expect(ref).toBeDefined();
      const res = await request('GET', ref);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/javascript/);
    });
  });

  describe('computeAssetVersion', () => {
    let dir;
    const write = (rel, content) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };

    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecb-assets-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('liefert bei gleichem Inhalt dieselbe, bei geändertem Inhalt eine andere Version', () => {
      const { computeAssetVersion } = require('../server/assets');
      write('js/a.js', 'one');
      write('css/a.css', 'two');
      const v1 = computeAssetVersion(dir);
      expect(v1).toMatch(/^[0-9a-f]{10}$/);
      expect(computeAssetVersion(dir)).toBe(v1);
      write('js/a.js', 'changed');
      expect(computeAssetVersion(dir)).not.toBe(v1);
    });
  });
});
