// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
//
// Öffentliche iCalendar-Feeds. Diese Tests prüfen vor allem die Formatregeln,
// an denen Kalender-Apps stillschweigend scheitern: CRLF-Zeilenenden, Faltung
// bei 75 Byte, Escaping in Textwerten und die Zeitzonen-Angabe.
const http = require('http');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-feeds';
process.env.PORT = '0';
process.env.CALENDAR_NAME = 'Eisbelegung Solingen';

let server, baseUrl, db;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: 'localhost', port: new URL(baseUrl).port, path: urlPath, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

function insertEvent({ title, start, end, allDay = 0, location = '', inHall = 1, uid = null }) {
  db.prepare(
    `INSERT INTO events (title, start_time, end_time, category_id, all_day, location,
                         in_hall, external_uid, source)
     VALUES (?, ?, ?, 7, ?, ?, ?, ?, ?)`
  ).run(title, start, end, allDay, location, inHall, uid, uid ? 'hallenplanung' : null);
}

/** Termin in naher Zukunft, damit er im Feed-Fenster liegt. */
function inDays(days, hour) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

describe('iCalendar-Feeds', () => {
  beforeAll(async () => {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server')) delete require.cache[key];
    });

    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    db = getDb();

    const app = require('../server/index');
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    insertEvent({
      title: 'U17 Heimspiel gegen Ratingen',
      start: inDays(7, 16), end: inDays(7, 18),
      location: 'Solingen', uid: 'hp-heim-1',
    });
    insertEvent({
      title: 'U17 Auswärtsspiel in Neuss',
      start: inDays(14, 15), end: inDays(14, 17),
      location: 'Neuss', inHall: 0, uid: 'hp-ausw-1',
    });
    insertEvent({
      title: 'U13/15 Training',
      start: inDays(3, 15), end: inDays(3, 17),
    });
    insertEvent({
      title: 'Eisdisco GmbH; Sonderveranstaltung, groß',
      start: inDays(5, 18), end: inDays(5, 20),
    });
    insertEvent({
      title: 'U20 Turnier',
      start: inDays(21, 0), end: inDays(22, 0), allDay: 1,
    });
    // Lange in der Vergangenheit — außerhalb des Feed-Fensters.
    insertEvent({
      title: 'U17 Heimspiel gegen Alt',
      start: inDays(-500, 16), end: inDays(-500, 18),
    });
  });

  afterAll(() => { if (server) server.close(); });

  // ---- Grundgerüst ----

  it('liefert einen gültigen Kalender mit der richtigen Kopfzeile', async () => {
    const res = await get('/feeds/halle.ics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(res.body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(res.body).toContain('X-WR-CALNAME:Eisbelegung Solingen');
  });

  it('nutzt CRLF als Zeilenende', async () => {
    // Ein reines \n lassen manche Kalender-Apps kommentarlos scheitern.
    const res = await get('/feeds/halle.ics');
    const nackteZeilenumbrueche = res.body.split('\n').filter(z => !z.endsWith('\r'));

    expect(nackteZeilenumbrueche.filter(z => z.length > 0)).toEqual([]);
  });

  it('bringt die Zeitzone mit', async () => {
    const res = await get('/feeds/halle.ics');

    expect(res.body).toContain('BEGIN:VTIMEZONE');
    expect(res.body).toContain('TZID:Europe/Berlin');
    expect(res.body).toContain('DTSTART;TZID=Europe/Berlin:');
  });

  it('ist ohne Anmeldung erreichbar', async () => {
    expect((await get('/feeds/halle.ics')).status).toBe(200);
    expect((await get('/feeds/u17.ics')).status).toBe(200);
  });

  // ---- Formatregeln ----

  it('escaped Semikolon und Komma im Titel', async () => {
    const res = await get('/feeds/halle.ics');
    expect(res.body).toContain('Eisdisco GmbH\\; Sonderveranstaltung\\, groß');
  });

  it('faltet zu lange Zeilen', async () => {
    const langerTitel = 'U15 Heimspiel gegen einen Verein mit einem sehr langen Namen e.V. 1899';
    insertEvent({ title: langerTitel, start: inDays(9, 16), end: inDays(9, 18) });

    const res = await get('/feeds/halle.ics');
    const zeilen = res.body.split('\r\n');

    expect(zeilen.every(z => Buffer.from(z, 'utf8').length <= 75)).toBe(true);
    // Fortsetzungszeilen beginnen mit einem Leerzeichen.
    expect(zeilen.some(z => z.startsWith(' '))).toBe(true);
  });

  it('nutzt den Fremdschlüssel als stabile UID', async () => {
    const res = await get('/feeds/u17.ics');
    expect(res.body).toContain('UID:hp-heim-1@ecb-kalenderview');
  });

  it('schreibt ganztägige Termine als Datumswert', async () => {
    const res = await get('/feeds/u20.ics');
    expect(res.body).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
  });

  // ---- Abgrenzung der Feeds ----

  it('zeigt im Hallen-Feed keine Auswärtsspiele', async () => {
    const res = await get('/feeds/halle.ics');

    expect(res.body).toContain('U17 Heimspiel gegen Ratingen');
    expect(res.body).not.toContain('Auswärtsspiel');
  });

  it('zeigt im Team-Feed auch die Auswärtsspiele', async () => {
    // Sie belegen die Halle nicht, sind für die Eltern aber Termine.
    const res = await get('/feeds/u17.ics');
    expect(res.body).toContain('U17 Auswärtsspiel in Neuss');
  });

  it('liefert nur Termine des angefragten Teams', async () => {
    const res = await get('/feeds/u17.ics');
    expect(res.body).not.toContain('Eisdisco');
  });

  it('schreibt gemeinsame Trainings auf das jeweilige Team um', async () => {
    const u13 = await get('/feeds/u13.ics');
    const u15 = await get('/feeds/u15.ics');

    expect(u13.body).toContain('SUMMARY:U13 Training');
    expect(u13.body).not.toContain('U13/15');
    expect(u15.body).toContain('SUMMARY:U15 Training');
  });

  it('behält im Hallen-Feed den gemeinsamen Titel', async () => {
    // Dort zählt die Belegung, nicht die Mannschaft.
    const res = await get('/feeds/halle.ics');
    expect(res.body).toContain('SUMMARY:U13/15 Training');
  });

  it('lässt lange vergangene Termine weg', async () => {
    const res = await get('/feeds/u17.ics');
    expect(res.body).not.toContain('gegen Alt');
  });

  // ---- Fehlerfälle und Übersicht ----

  it('meldet einen unbekannten Feed mit den verfügbaren Namen', async () => {
    const res = await get('/feeds/u99.ics');

    expect(res.status).toBe(404);
    expect(res.body).toContain('U17');
    expect(res.body).toContain('halle');
  });

  it('ignoriert Groß- und Kleinschreibung im Feed-Namen', async () => {
    expect((await get('/feeds/U17.ics')).status).toBe(200);
  });

  it('listet alle Feeds mit ihren URLs auf', async () => {
    const res = await get('/feeds');
    const daten = JSON.parse(res.body);

    expect(daten.feeds[0].name).toBe('Halle');
    expect(daten.feeds.map(f => f.name)).toContain('ECB U17');
    expect(daten.feeds[1].url).toMatch(/\/feeds\/u7\.ics$/);
  });
});
