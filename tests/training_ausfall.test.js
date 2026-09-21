const http = require('http');
const bcrypt = require('bcryptjs');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-training-ausfall';
process.env.PORT = '0';

let server, baseUrl, db, adminToken;

const KAT_ECB = 7;

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

let uidZaehler = 0;

/** Termin in lokaler Zeit, damit die Tagesgrenzen stimmen. */
function termin(titel, tag, stunde, { spiel = false, inHall = 1 } = {}) {
  const [y, m, d] = tag.split('-').map(Number);
  const start = new Date(y, m - 1, d, stunde, 0);
  const ende = new Date(y, m - 1, d, stunde + 2, 0);
  const uid = spiel ? `hp-test-${++uidZaehler}` : null;
  return db
    .prepare(
      `INSERT INTO events (title, start_time, end_time, category_id, external_uid, source, in_hall)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(titel, start.toISOString(), ende.toISOString(), KAT_ECB, uid,
         spiel ? 'hallenplanung' : null, inHall)
    .lastInsertRowid;
}

const training = (titel, tag) => termin(titel, tag, 18);
const heimspiel = (titel, tag, stunde = 10) => termin(titel, tag, stunde, { spiel: true });
const auswaerts = (titel, tag) => termin(titel, tag, 14, { spiel: true, inHall: 0 });

/** Zeitraum eines lokalen Tages als ISO-Grenzen. */
function tagesSpanne(tag) {
  const [y, m, d] = tag.split('-').map(Number);
  return {
    start: new Date(y, m - 1, d).toISOString(),
    end: new Date(y, m - 1, d + 1).toISOString(),
  };
}

async function hallenansicht(tag) {
  const { start, end } = tagesSpanne(tag);
  const res = await req('GET', `/api/events?start=${start}&end=${end}`);
  return res.body.termine.map(t => t.titel);
}

async function feed(name) {
  return (await req('GET', `/feeds/${name}.ics`)).body;
}

async function abrechnung(tag, nachTeam = false) {
  const { start, end } = tagesSpanne(tag);
  const res = await req(
    'GET', `/api/stats?start=${start}&end=${end}&category_ids=${KAT_ECB}${nachTeam ? '&group_by_team=1' : ''}`,
    null, adminToken
  );
  return res.body;
}

describe('Training entfällt an Spieltagen', () => {
  beforeAll(async () => {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server')) delete require.cache[key];
    });

    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    db = getDb();

    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run('admin', bcrypt.hashSync('testpass', 4), 'admin', 'Admin');

    const app = require('../server/index');
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    adminToken = (await req('POST', '/api/auth/login', { username: 'admin', password: 'testpass' })).body.token;
  });

  afterAll(() => { if (server) server.close(); });

  // Alle Termine liegen ab heute, damit sie im Feed-Zeitfenster sind.
  const tag = (versatz) => {
    const d = new Date();
    d.setDate(d.getDate() + versatz);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('Heimspiel am selben Tag: Training verschwindet überall', async () => {
    const t = tag(10);
    training('U17 Training A', t);
    heimspiel('U17 Heimspiel gegen Ratingen', t);

    expect(await hallenansicht(t)).toEqual(['U17 Heimspiel gegen Ratingen']);
    expect(await feed('halle')).not.toContain('U17 Training A');
    expect(await feed('u17')).not.toContain('Training A');
    expect(await feed('u17')).toContain('Heimspiel gegen Ratingen');

    const stats = await abrechnung(t);
    expect(stats.gesamt.anzahl).toBe(1);
  });

  it('Auswärtsspiel am selben Tag verdrängt das Training genauso', async () => {
    const t = tag(11);
    training('U20 Training B', t);
    auswaerts('U20 Auswärtsspiel in Essen', t);

    // Das Auswärtsspiel selbst steht nicht in der Hallenansicht, das Training auch nicht
    expect(await hallenansicht(t)).toEqual([]);
    expect((await abrechnung(t)).gesamt.anzahl).toBe(0);
  });

  it('die Uhrzeit spielt keine Rolle: Spiel morgens, Training abends', async () => {
    const t = tag(12);
    training('U15 Training C', t);
    heimspiel('U15 Heimspiel früh', t, 8);

    expect(await hallenansicht(t)).not.toContain('U15 Training C');
  });

  it('ein Spiel am Vortag lässt das Training stehen', async () => {
    const t = tag(13);
    heimspiel('U13 Heimspiel Vortag', tag(12));
    training('U13 Training D', t);

    expect(await hallenansicht(t)).toContain('U13 Training D');
  });

  it('gemeinsames Training: entfällt nur für die spielende Mannschaft', async () => {
    const t = tag(14);
    training('U13/15 Training E', t);
    heimspiel('U13 Heimspiel E', t);

    // Die U15 trainiert weiter: Halle belegt, im U15-Feed, nicht im U13-Feed
    expect(await hallenansicht(t)).toContain('U13/15 Training E');
    expect(await feed('u15')).toContain('Training E');
    expect(await feed('u13')).not.toContain('Training E');

    const stats = await abrechnung(t, true);
    expect(stats.gesamt.anzahl).toBe(2);
    const u13 = stats.teams.find(x => x.team === 'U13');
    const u15 = stats.teams.find(x => x.team === 'U15');
    expect(u13.anzahl).toBe(1); // nur das Spiel
    expect(u15.anzahl).toBe(1); // nur das Training
  });

  it('gemeinsames Training: entfällt komplett, wenn beide spielen', async () => {
    const t = tag(15);
    training('U13/15 Training F', t);
    heimspiel('U13 Heimspiel F', t);
    auswaerts('U15 Auswärtsspiel F', t);

    expect(await hallenansicht(t)).not.toContain('U13/15 Training F');
    expect(await feed('halle')).not.toContain('Training F');
  });

  it('Untermannschaften: Spiel der U11a streicht das gemeinsame Training von U11a und U11b', async () => {
    // Hallenplanung liefert das gemeinsame Training als zwei gleichzeitige
    // Einträge. Beide müssen entfallen, sobald eine der beiden spielt.
    const t = tag(16);
    training('U11a Training G', t);
    training('U11b Training G', t);
    heimspiel('U11a Heimspiel G', t);

    const titel = await hallenansicht(t);
    expect(titel).not.toContain('U11a Training G');
    expect(titel).not.toContain('U11b Training G');

    // Der U11-Feed ist das, was die Bridge in den Google-Kalender überträgt
    const u11 = await feed('u11');
    expect(u11).not.toContain('Training G');
    expect(u11).toContain('Heimspiel G');
  });

  it('Spiel der U11b streicht das gemeinsame Training genauso', async () => {
    const t = tag(21);
    training('U11a Training K', t);
    training('U11b Training K', t);
    auswaerts('U11b Auswärtsspiel K', t);

    expect(await hallenansicht(t)).toEqual([]);
    expect(await feed('u11')).not.toContain('Training K');
  });

  it('ein Training ohne erkennbare Mannschaft entfällt nie', async () => {
    const t = tag(17);
    training('Goalie-Training offen für alle', t); // enthält "Goalies" nicht als Wort
    heimspiel('U17 Heimspiel H', t);

    expect(await hallenansicht(t)).toContain('Goalie-Training offen für alle');
  });

  it('die Admin-Liste behält das Training mit Kennzeichen', async () => {
    const t = tag(18);
    training('U17 Training I', t);
    heimspiel('U17 Heimspiel I', t);

    const { start, end } = tagesSpanne(t);
    const res = await req('GET', `/api/events?start=${start}&end=${end}&include_extern=1`, null, adminToken);
    const eintrag = res.body.termine.find(x => x.titel === 'U17 Training I');

    expect(eintrag).toBeDefined();
    expect(eintrag.entfaelltWegenSpiel).toBe(true);
    expect(eintrag.entfaelltFuer).toEqual(['U17']);
  });

  it('verlegt man das Spiel, ist das Training wieder da', async () => {
    const t = tag(19);
    training('U20 Training J', t);
    const spiel = heimspiel('U20 Heimspiel J', t);
    expect(await hallenansicht(t)).not.toContain('U20 Training J');

    const [y, m, d] = tag(20).split('-').map(Number);
    db.prepare('UPDATE events SET start_time = ?, end_time = ? WHERE id = ?').run(
      new Date(y, m - 1, d, 10).toISOString(), new Date(y, m - 1, d, 12).toISOString(), spiel
    );

    expect(await hallenansicht(t)).toContain('U20 Training J');
  });
});
