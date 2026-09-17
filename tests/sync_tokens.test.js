const http = require('http');
const bcrypt = require('bcryptjs');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-sync-tokens';
process.env.PORT = '0';

let server, baseUrl, db;
let adminToken, editorToken, syncToken, syncTokenId;

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

/** Nutzlast für den Spiele-Abgleich mit n Terminen. */
function nutzlast(anzahl, praefix = 'Spiel') {
  const events = [];
  for (let i = 0; i < anzahl; i++) {
    const tag = String(5 + i).padStart(2, '0');
    events.push({
      uid: `${praefix}-${i}`,
      kind: 'game',
      title: `${praefix} ${i}`,
      date: `2026-11-${tag}`,
      start: '18:00',
      end: '20:00',
      location: 'Solingen',
    });
  }
  return {
    format: 'ecb-calendar',
    format_version: 1,
    season: { date_from: '2026-11-01', date_to: '2026-11-30' },
    events,
  };
}

describe('Sync-Tokens', () => {
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
  });

  afterAll(() => { if (server) server.close(); });

  // ---- Verwaltung ----

  it('legt ein Token an und zeigt den Klartext genau einmal', async () => {
    const res = await req('POST', '/api/sync-tokens', { label: 'Hallenplanung Jugendobfrau' }, adminToken);

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^ecbsync_/);
    expect(res.body.label).toBe('Hallenplanung Jugendobfrau');
    syncToken = res.body.token;
    syncTokenId = res.body.id;

    // In der Liste taucht nur das Präfix auf, nie der volle Wert
    const liste = await req('GET', '/api/sync-tokens', null, adminToken);
    const eintrag = liste.body.find(t => t.id === syncTokenId);
    expect(eintrag.token).toBeUndefined();
    expect(syncToken.startsWith(eintrag.prefix)).toBe(true);
    expect(eintrag.created_by_name).toBe('Test Admin');
  });

  it('speichert das Token nicht im Klartext', () => {
    const zeile = db.prepare('SELECT token_hash FROM sync_tokens WHERE id = ?').get(syncTokenId);
    expect(zeile.token_hash).not.toBe(syncToken);
    expect(zeile.token_hash).toHaveLength(64); // SHA-256 als Hex
  });

  it('lässt nur Admins an die Token-Verwaltung', async () => {
    expect((await req('GET', '/api/sync-tokens', null, editorToken)).status).toBe(403);
    expect((await req('POST', '/api/sync-tokens', { label: 'X' }, editorToken)).status).toBe(403);
    expect((await req('GET', '/api/sync-tokens')).status).toBe(401);
  });

  it('verlangt eine Bezeichnung', async () => {
    const res = await req('POST', '/api/sync-tokens', { label: '  ' }, adminToken);
    expect(res.status).toBe(400);
  });

  // ---- Geltungsbereich ----

  it('akzeptiert das Sync-Token beim Abgleich', async () => {
    const res = await req('POST', '/api/sync/calendar?dry_run=true', nutzlast(3), syncToken);
    expect(res.status).toBe(200);
    expect(res.body.angelegt).toBe(3);
  });

  it('lehnt das Sync-Token außerhalb der Abgleich-Endpunkte ab', async () => {
    const termin = {
      title: 'Direkt angelegt',
      start_time: '2026-11-05T18:00:00.000Z',
      end_time: '2026-11-05T20:00:00.000Z',
      category_id: 7,
    };
    expect((await req('POST', '/api/events', termin, syncToken)).status).toBe(401);
    expect((await req('GET', '/api/users', null, syncToken)).status).toBe(401);
    expect((await req('GET', '/api/sync-tokens', null, syncToken)).status).toBe(401);
  });

  it('akzeptiert weiterhin das normale Anmelde-Token beim Abgleich', async () => {
    const res = await req('POST', '/api/sync/calendar?dry_run=true', nutzlast(2), adminToken);
    expect(res.status).toBe(200);
  });

  it('vermerkt die Benutzung des Tokens', async () => {
    const vorher = db.prepare('SELECT last_used_at FROM sync_tokens WHERE id = ?').get(syncTokenId);
    expect(vorher.last_used_at).toBeTruthy();
  });

  it('schreibt Termine auf das Konto, das das Token erzeugt hat', async () => {
    await req('POST', '/api/sync/calendar', nutzlast(2, 'Konto'), syncToken);
    const zeile = db.prepare("SELECT created_by FROM events WHERE external_uid = 'Konto-0'").get();
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
    expect(zeile.created_by).toBe(admin.id);
  });

  // ---- Notbremse ----

  it('bricht ab, wenn der Abgleich ungewöhnlich viel löschen würde', async () => {
    // Bestand aufbauen …
    const aufbau = await req('POST', '/api/sync/calendar', nutzlast(20, 'Bremse'), syncToken);
    expect(aufbau.status).toBe(200);
    expect(aufbau.body.angelegt).toBeGreaterThanOrEqual(20);

    // … und dann fast alles weglassen
    const res = await req('POST', '/api/sync/calendar', nutzlast(2, 'Bremse'), syncToken);
    expect(res.status).toBe(409);
    expect(res.body.bestaetigung_noetig).toBe(true);
    expect(res.body.geloescht_geplant).toBeGreaterThan(10);

    // Nichts wurde gelöscht
    const bestand = db.prepare("SELECT COUNT(*) c FROM events WHERE external_uid LIKE 'Bremse-%'").get();
    expect(bestand.c).toBe(20);
  });

  it('löscht trotzdem, wenn force gesetzt ist', async () => {
    const res = await req('POST', '/api/sync/calendar?force=true', nutzlast(2, 'Bremse'), syncToken);
    expect(res.status).toBe(200);
    expect(res.body.geloescht).toBeGreaterThan(10);

    const bestand = db.prepare("SELECT COUNT(*) c FROM events WHERE external_uid LIKE 'Bremse-%'").get();
    expect(bestand.c).toBe(2);
  });

  it('lässt den Probelauf trotz vieler Löschungen durchrechnen', async () => {
    await req('POST', '/api/sync/calendar?force=true', nutzlast(20, 'Probe'), syncToken);
    const res = await req('POST', '/api/sync/calendar?dry_run=true', nutzlast(0, 'Probe'), syncToken);

    expect(res.status).toBe(200);
    expect(res.body.probelauf).toBe(true);
    expect(res.body.geloescht).toBeGreaterThan(10);

    // Der Probelauf hat nichts angefasst
    const bestand = db.prepare("SELECT COUNT(*) c FROM events WHERE external_uid LIKE 'Probe-%'").get();
    expect(bestand.c).toBe(20);
  });

  it('greift bei kleinen Beständen nicht', async () => {
    // Drei Termine, danach keiner mehr: anteilig alles, absolut aber harmlos
    await req('POST', '/api/sync/calendar?force=true', nutzlast(3, 'Klein'), syncToken);
    const res = await req('POST', '/api/sync/calendar', {
      ...nutzlast(0),
      season: { date_from: '2026-11-01', date_to: '2026-11-30' },
    }, syncToken);

    expect(res.status).toBe(200);
  });

  // ---- Status ----

  it('meldet den letzten Abgleich samt Rechner', async () => {
    await req('POST', '/api/sync/calendar?force=true', nutzlast(2, 'Status'), syncToken);
    const res = await req('GET', '/api/sync/status', null, syncToken);

    expect(res.status).toBe(200);
    expect(res.body.letzterAbgleich.rechner).toBe('Hallenplanung Jugendobfrau');
    expect(res.body.letzterAbgleich.benutzer).toBe('Test Admin');
    expect(res.body.letzterAbgleich.endpunkt).toBe('calendar');
  });

  it('protokolliert den Probelauf nicht', async () => {
    const vorher = db.prepare('SELECT COUNT(*) c FROM sync_log').get().c;
    await req('POST', '/api/sync/calendar?dry_run=true', nutzlast(1, 'Egal'), syncToken);
    expect(db.prepare('SELECT COUNT(*) c FROM sync_log').get().c).toBe(vorher);
  });

  // ---- Widerruf ----

  it('widerruft ein Token, die Historie bleibt', async () => {
    const eintraegeVorher = db.prepare('SELECT COUNT(*) c FROM sync_log').get().c;

    const res = await req('DELETE', `/api/sync-tokens/${syncTokenId}`, null, adminToken);
    expect(res.status).toBe(200);

    const danach = await req('POST', '/api/sync/calendar?dry_run=true', nutzlast(1), syncToken);
    expect(danach.status).toBe(401);

    expect(db.prepare('SELECT COUNT(*) c FROM sync_log').get().c).toBe(eintraegeVorher);
  });

  it('meldet 404 beim Widerrufen eines unbekannten Tokens', async () => {
    const res = await req('DELETE', '/api/sync-tokens/9999', null, adminToken);
    expect(res.status).toBe(404);
  });

  it('lehnt ein erfundenes Sync-Token ab', async () => {
    const res = await req('POST', '/api/sync/calendar?dry_run=true', nutzlast(1), 'ecbsync_ausgedacht');
    expect(res.status).toBe(401);
  });
});
