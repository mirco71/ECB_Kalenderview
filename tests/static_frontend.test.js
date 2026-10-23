// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
//
// Paket B: keine Inline-Event-Handler mehr im Frontend; die CSP verbietet sie
// (script-src-attr 'none').
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-static-frontend';
process.env.PORT = '0';
process.env.SECURE_TRANSPORT = 'false';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INLINE_HANDLER = /\son[a-z]+\s*=\s*["']/i;

function frontendFiles() {
  const files = fs.readdirSync(PUBLIC_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(PUBLIC_DIR, f));
  const jsDir = path.join(PUBLIC_DIR, 'js');
  for (const f of fs.readdirSync(jsDir)) {
    if (f.endsWith('.js')) files.push(path.join(jsDir, f));
  }
  return files;
}

describe('Paket B — keine Inline-Event-Handler', () => {
  for (const file of frontendFiles()) {
    it(`${path.relative(PUBLIC_DIR, file).split(path.sep).join('/')} enthält kein on*=-Attribut`, () => {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const hits = lines
        .map((l, i) => (INLINE_HANDLER.test(l) ? `${i + 1}: ${l.trim()}` : null))
        .filter(Boolean);
      expect(hits).toEqual([]);
    });
  }

  describe('CSP-Header', () => {
    let server, port;

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

    it('setzt script-src-attr \'none\'', async () => {
      const headers = await new Promise((resolve, reject) => {
        http.get({ hostname: 'localhost', port, path: '/' }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.headers));
        }).on('error', reject);
      });
      const csp = headers['content-security-policy'];
      expect(csp).toContain("script-src-attr 'none'");
      expect(csp).not.toMatch(/script-src-attr[^;]*unsafe-inline/);
    });
  });
});
