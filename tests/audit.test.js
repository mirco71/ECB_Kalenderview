// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
const http = require('http');
const bcrypt = require('bcryptjs');

// Use in-memory test database
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-audit';
process.env.PORT = '0';

let server, baseUrl, db;
let adminToken, editorToken;

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
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

/** Protokoll als Admin abrufen; `query` ohne führendes ?. */
async function protokoll(query = 'art=alle') {
  const res = await req('GET', `/api/audit?${query}`, null, adminToken);
  expect(res.status).toBe(200);
  return res.body;
}

async function login(username, password, ip = '192.0.2.1') {
  return req('POST', '/api/auth/login', { username, password }, null, { 'CF-Connecting-IP': ip });
}

describe('Änderungsprotokoll', () => {
  beforeAll(async () => {
    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    db = getDb();

    const hash = bcrypt.hashSync('testpass123', 4);
    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run('admin', hash, 'admin', 'Test Admin');
    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run('editor', hash, 'editor', 'Test Editor');

    const app = require('../server/index');
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    adminToken = (await login('admin', 'testpass123')).body.token;
    editorToken = (await login('editor', 'testpass123')).body.token;
  });

  afterAll(() => { if (server) server.close(); });

  describe('Zugriff', () => {
    it('lehnt Anfragen ohne Anmeldung ab', async () => {
      const res = await req('GET', '/api/audit');
      expect(res.status).toBe(401);
    });

    it('ist für Editoren gesperrt', async () => {
      const res = await req('GET', '/api/audit', null, editorToken);
      expect(res.status).toBe(403);
    });

    it('lehnt unbekannte Filterwerte ab', async () => {
      const res = await req('GET', '/api/audit?art=quatsch', null, adminToken);
      expect(res.status).toBe(400);
    });
  });

  describe('Termine', () => {
    let eventId;

    it('protokolliert Anlegen, Ändern und Löschen mit dem handelnden Benutzer', async () => {
      const angelegt = await req('POST', '/api/events', {
        title: 'Audit Training',
        start_time: '2026-10-03T16:00:00.000Z',
        end_time: '2026-10-03T18:00:00.000Z',
        category_id: 7,
      }, editorToken);
      expect(angelegt.status).toBe(201);
      eventId = angelegt.body.id;

      const geaendert = await req('PUT', `/api/events/${eventId}`, {
        end_time: '2026-10-03T19:30:00.000Z',
        location: 'Halle 2',
      }, editorToken);
      expect(geaendert.status).toBe(200);

      const { eintraege } = await protokoll('art=termine');
      const zumTermin = eintraege.filter(e => e.objektId === String(eventId));
      expect(zumTermin.map(e => e.aktion)).toEqual(['event.update', 'event.create']);
      expect(zumTermin.every(e => e.benutzer === 'editor')).toBe(true);

      // Nur die geänderten Felder, in lokaler Wandzeit (TZ=Europe/Berlin im Container).
      const update = zumTermin[0];
      expect(Object.keys(update.details.aenderungen).sort()).toEqual(['Ende', 'Ort']);
      expect(update.details.aenderungen.Ort).toEqual(['', 'Halle 2']);
      expect(update.zusammenfassung).toContain('Audit Training');
    });

    it('legt ohne echte Änderung keinen Eintrag an', async () => {
      const vorher = (await protokoll()).gesamt;
      const res = await req('PUT', `/api/events/${eventId}`, { location: 'Halle 2' }, editorToken);
      expect(res.status).toBe(200);
      expect((await protokoll()).gesamt).toBe(vorher);
    });

    it('hält beim Löschen einen Schnappschuss fest', async () => {
      const res = await req('DELETE', `/api/events/${eventId}`, null, adminToken);
      expect(res.status).toBe(200);

      const [eintrag] = (await protokoll('art=termine')).eintraege;
      expect(eintrag.aktion).toBe('event.delete');
      expect(eintrag.benutzer).toBe('admin');
      expect(eintrag.details.daten.Titel).toBe('Audit Training');
      expect(eintrag.details.daten.Kategorie).toBe('ECB');
      expect(eintrag.details.daten.Ort).toBe('Halle 2');
    });

    it('protokolliert keine abgewiesenen Änderungen', async () => {
      const vorher = (await protokoll()).gesamt;
      const res = await req('PUT', '/api/events/999999', { title: 'x' }, editorToken);
      expect(res.status).toBe(404);
      expect((await protokoll()).gesamt).toBe(vorher);
    });

    it('fasst eine Serie in einem Eintrag zusammen', async () => {
      const res = await req('POST', '/api/events/series', {
        title: 'Audit Serie',
        category_id: 7,
        weekday: 2,
        time_from: '18:00',
        time_to: '20:00',
        date_from: '2026-11-01',
        date_to: '2026-11-30',
      }, adminToken);
      expect(res.status).toBe(201);

      const [eintrag] = (await protokoll('art=termine')).eintraege;
      expect(eintrag.aktion).toBe('series.create');
      expect(eintrag.details.daten.Termine).toBe(res.body.serie.anzahl);
    });
  });

  describe('Massenlöschung', () => {
    const auftrag = { date_from: '2026-11-01', date_to: '2026-11-30', category_ids: [7] };

    it('schreibt bei dry_run nichts und sonst genau einen Eintrag', async () => {
      const vorher = (await protokoll()).gesamt;

      const probe = await req('POST', '/api/events/bulk-delete?dry_run=true', auftrag, adminToken);
      expect(probe.status).toBe(200);
      expect((await protokoll()).gesamt).toBe(vorher);

      const echt = await req('POST', '/api/events/bulk-delete', auftrag, adminToken);
      expect(echt.status).toBe(200);
      expect(echt.body.anzahl).toBeGreaterThan(0);

      const daten = await protokoll();
      expect(daten.gesamt).toBe(vorher + 1);
      expect(daten.eintraege[0].aktion).toBe('events.bulk_delete');
      expect(daten.eintraege[0].details.liste).toHaveLength(echt.body.anzahl);
    });
  });

  describe('Geheimnisse', () => {
    it('speichert weder Passwort noch Hash eines Benutzers', async () => {
      const angelegt = await req('POST', '/api/users', {
        username: 'geheimtest', password: 'supergeheim1', role: 'editor', display_name: 'Geheim',
      }, adminToken);
      expect(angelegt.status).toBe(201);

      const geaendert = await req('PUT', `/api/users/${angelegt.body.id}`, {
        password: 'nochgeheimer2',
      }, adminToken);
      expect(geaendert.status).toBe(200);

      const hash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(angelegt.body.id).password_hash;
      const roh = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
      expect(roh).not.toContain('supergeheim1');
      expect(roh).not.toContain('nochgeheimer2');
      expect(roh).not.toContain(hash);

      const [update] = (await protokoll('art=benutzer')).eintraege;
      expect(update.details.aenderungen).toEqual({ Passwort: ['', 'neu gesetzt'] });
    });

    it('speichert den Klartext eines Sync-Tokens nicht', async () => {
      const res = await req('POST', '/api/sync-tokens', { label: 'Audit-Rechner' }, adminToken);
      expect(res.status).toBe(201);

      const roh = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
      expect(roh).not.toContain(res.body.token);

      const [eintrag] = (await protokoll('art=sync')).eintraege;
      expect(eintrag.aktion).toBe('sync_token.create');
      expect(eintrag.zusammenfassung).toContain('Audit-Rechner');
    });
  });

  describe('Anmeldungen', () => {
    it('protokolliert fehlgeschlagene und erfolgreiche Logins', async () => {
      await login('niemand', 'egal', '198.51.100.1');
      await login('editor', 'falsch', '198.51.100.1');

      const { eintraege } = await protokoll('art=fehlanmeldungen');
      expect(eintraege[0].benutzer).toBe('editor');
      expect(eintraege[0].zusammenfassung).toContain('Passwort falsch');
      expect(eintraege[0].ip).toBe('198.51.100.1');
      expect(eintraege[1].benutzer).toBe('niemand');
      expect(eintraege[1].zusammenfassung).toContain('Benutzer unbekannt');
      expect(eintraege.every(e => e.aktion === 'auth.login_failed')).toBe(true);

      const erfolgreich = (await protokoll('art=anmeldungen')).eintraege;
      expect(erfolgreich.some(e => e.aktion === 'auth.login' && e.benutzer === 'editor')).toBe(true);
    });

    it('blendet Anmeldungen in der Standardansicht aus', async () => {
      const res = await req('GET', '/api/audit', null, adminToken);
      expect(res.status).toBe(200);
      expect(res.body.eintraege.length).toBeGreaterThan(0);
      expect(res.body.eintraege.some(e => e.bereich === 'auth')).toBe(false);
    });
  });

  describe('Filter', () => {
    it('grenzt nach Benutzer ein', async () => {
      const editorId = db.prepare("SELECT id FROM users WHERE username = 'editor'").get().id;
      const { eintraege, gesamt } = await protokoll(`art=alle&user_id=${editorId}`);
      expect(gesamt).toBe(eintraege.length);
      expect(eintraege.length).toBeGreaterThan(0);
      expect(eintraege.every(e => e.benutzerId === editorId)).toBe(true);
    });

    it('sucht im Text und nimmt % wörtlich', async () => {
      const treffer = await protokoll('art=alle&q=Audit%20Serie');
      expect(treffer.gesamt).toBeGreaterThan(0);
      expect(treffer.eintraege.every(e => e.zusammenfassung.includes('Audit Serie'))).toBe(true);

      const prozent = await protokoll(`art=alle&q=${encodeURIComponent('%')}`);
      expect(prozent.gesamt).toBe(0);
    });

    it('grenzt nach Zeitraum ein', async () => {
      const heute = new Date();
      const tag = `${heute.getFullYear()}-${String(heute.getMonth() + 1).padStart(2, '0')}-${String(heute.getDate()).padStart(2, '0')}`;
      const alle = (await protokoll('art=alle')).gesamt;
      expect((await protokoll(`art=alle&from=${tag}&to=${tag}`)).gesamt).toBe(alle);
      expect((await protokoll('art=alle&to=2020-01-01')).gesamt).toBe(0);
    });

    it('blättert mit limit und offset', async () => {
      const seite1 = await protokoll('art=alle&limit=2&offset=0');
      const seite2 = await protokoll('art=alle&limit=2&offset=2');
      expect(seite1.eintraege).toHaveLength(2);
      expect(seite2.eintraege[0].id).toBeLessThan(seite1.eintraege[1].id);
    });
  });

  describe('Aufbewahrung', () => {
    it('entfernt Einträge, die älter als 6 Monate sind', () => {
      const { pruneAudit } = require('../server/audit');
      db.prepare(
        `INSERT INTO audit_log (created_at, action, entity_type, summary)
         VALUES (datetime('now', '-7 months'), 'event.create', 'event', 'uralt')`
      ).run();
      db.prepare(
        `INSERT INTO audit_log (created_at, action, entity_type, summary)
         VALUES (datetime('now', '-5 months'), 'event.create', 'event', 'jung')`
      ).run();

      pruneAudit(db);

      const texte = db.prepare('SELECT summary FROM audit_log').all().map(z => z.summary);
      expect(texte).not.toContain('uralt');
      expect(texte).toContain('jung');
    });
  });
});
