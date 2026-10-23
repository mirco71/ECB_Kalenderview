// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
//
// Paket C: 404 statt index.html für Dateipfade, robots.txt, security.txt,
// X-Robots-Tag, no-store auf /api, CSP (self-only Fonts/Styles, Reporting),
// Permissions-Policy und der CSP-Report-Endpunkt.
const http = require('http');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-http-hardening';
process.env.PORT = '0';
process.env.SECURITY_CONTACT = 'mailto:sicherheit@example.de';
process.env.SECURE_TRANSPORT = 'false';

let server, port;

function request(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: 'localhost', port, path: urlPath, method, headers },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    r.on('error', reject);
    if (body !== null) r.write(body);
    r.end();
  });
}
const get = (p) => request('GET', p);

describe('Paket C — Routing, Kopfzeilen, CSP', () => {
  beforeAll(async () => {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server')) delete require.cache[key];
    });
    const { dbReady } = require('../server/database');
    await dbReady;
    const app = require('../server/index');
    await new Promise((resolve) => {
      server = app.listen(0, () => { port = server.address().port; resolve(); });
    });
  });

  afterAll(() => { if (server) server.close(); });

  describe('Routing', () => {
    it('liefert robots.txt als text/plain', async () => {
      const res = await get('/robots.txt');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.body).toContain('User-agent: *');
      expect(res.body).toContain('Disallow: /admin.html');
      expect(res.body).toContain('Disallow: /login.html');
      expect(res.body).toContain('Disallow: /api/');
    });

    it('antwortet auf unbekannte Dateipfade mit 404 text/plain', async () => {
      for (const p of ['/favicon.ico', '/irgendwas.php', '/a/b/c.js']) {
        const res = await get(p);
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(/text\/plain/);
        expect(res.body).toBe('Nicht gefunden');
      }
    });

    it('liefert für Pfade ohne Endung weiter index.html', async () => {
      const res = await get('/irgendwas');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    });

    it('lässt /api/* bei 404 als JSON', async () => {
      const res = await get('/api/gibt-es-nicht');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
    });

    it('liefert Feeds weiterhin mit 200', async () => {
      const res = await get('/feeds/halle.ics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/calendar/);
    });

    it('liefert statische CSS-Dateien weiterhin aus', async () => {
      expect((await get('/css/calendar.css')).status).toBe(200);
      const lc = await get('/css/login.css');
      expect(lc.status).toBe(200);
      expect(lc.headers['content-type']).toMatch(/text\/css/);
    });
  });

  describe('security.txt', () => {
    it('liefert sie mit gesetztem SECURITY_CONTACT', async () => {
      const res = await get('/.well-known/security.txt');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.body).toContain('Contact: mailto:sicherheit@example.de');
      expect(res.body).toMatch(/Expires: \d{4}-\d{2}-\d{2}T/);
      expect(res.body).toContain('Preferred-Languages: de, en');
      const expires = new Date(/Expires: (\S+)/.exec(res.body)[1]);
      expect(expires.getTime()).toBeGreaterThan(Date.now() + 300 * 24 * 3600 * 1000);
    });

    it('antwortet ohne SECURITY_CONTACT mit 404', async () => {
      const alt = process.env.SECURITY_CONTACT;
      delete process.env.SECURITY_CONTACT;
      try {
        const res = await get('/.well-known/security.txt');
        expect(res.status).toBe(404);
      } finally {
        process.env.SECURITY_CONTACT = alt;
      }
    });
  });

  describe('X-Robots-Tag', () => {
    it('steht auf login.html und admin.html', async () => {
      for (const p of ['/login.html', '/admin.html']) {
        const res = await get(p);
        expect(res.status).toBe(200);
        expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      }
    });

    it('steht nicht auf der Startseite', async () => {
      expect((await get('/')).headers['x-robots-tag']).toBeUndefined();
      expect((await get('/index.html')).headers['x-robots-tag']).toBeUndefined();
    });
  });

  describe('Cache-Control', () => {
    it('setzt no-store auf /api/config und /api/events', async () => {
      const cfg = await get('/api/config');
      expect(cfg.status).toBe(200);
      expect(cfg.headers['cache-control']).toBe('no-store');
      const ev = await get('/api/events?start=2026-10-01T00:00:00.000Z&end=2026-11-01T00:00:00.000Z');
      expect(ev.headers['cache-control']).toBe('no-store');
    });

    it('setzt no-store auch auf 404 unter /api', async () => {
      expect((await get('/api/gibt-es-nicht')).headers['cache-control']).toBe('no-store');
    });
  });

  describe('Kopfzeilen', () => {
    it('sendet die erwartete CSP', async () => {
      const res = await get('/');
      const csp = res.headers['content-security-policy'];
      console.log('CSP:', csp);
      const dir = Object.fromEntries(csp.split(';').map(s => {
        const [k, ...v] = s.trim().split(/\s+/);
        return [k, v.join(' ')];
      }));
      expect(dir['font-src']).toBe("'self'");
      expect(dir['style-src']).toBe("'self'");
      expect(dir['style-src-attr']).toBe("'unsafe-inline'");
      expect(csp).toContain('report-uri /api/csp-report');
      expect(csp).toContain('report-to csp');
      expect(csp).not.toContain('upgrade-insecure-requests');
      expect(res.headers['reporting-endpoints']).toBe('csp="/api/csp-report"');
    });

    it('sendet die Permissions-Policy auf allen Antworten', async () => {
      const erwartet = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';
      for (const p of ['/', '/api/config', '/irgendwas.php']) {
        expect((await get(p)).headers['permissions-policy']).toBe(erwartet);
      }
    });

    it('enthält kein inline <style> mehr in den HTML-Seiten', () => {
      const fs = require('fs');
      const path = require('path');
      for (const f of ['index.html', 'admin.html', 'login.html']) {
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
        expect(html).not.toMatch(/<style[\s>]/i);
      }
      const login = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
      expect(login).toContain('href="/css/login.css"');
    });
  });

  describe('POST /api/csp-report', () => {
    const report = JSON.stringify({ 'csp-report': { 'blocked-uri': 'inline', 'violated-directive': 'style-src' } });

    it('antwortet mit 204', async () => {
      const res = await request('POST', '/api/csp-report', report, { 'Content-Type': 'application/csp-report' });
      expect(res.status).toBe(204);
      const res2 = await request('POST', '/api/csp-report', report, { 'Content-Type': 'application/json' });
      expect(res2.status).toBe(204);
    });

    it('lehnt Bodies über 10kb mit 413 ab', async () => {
      const gross = JSON.stringify({ 'csp-report': { x: 'a'.repeat(11 * 1024) } });
      const res = await request('POST', '/api/csp-report', gross, { 'Content-Type': 'application/json' });
      expect(res.status).toBe(413);
    });
  });
});
