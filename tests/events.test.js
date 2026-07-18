const http = require('http');
const bcrypt = require('bcryptjs');

// Use in-memory test database
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-key-events';
process.env.PORT = '0';

let server, baseUrl, adminToken;

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

describe('Events API', () => {
  beforeAll(async () => {
    // Clear module cache to get fresh DB
    Object.keys(require.cache).forEach(key => {
      if (key.includes('server')) delete require.cache[key];
    });

    const { dbReady, getDb } = require('../server/database');
    await dbReady;
    const db = getDb();

    // Seed admin user
    const hash = bcrypt.hashSync('testpass', 4);
    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run('admin', hash, 'admin', 'Test Admin');

    const app = require('../server/index');

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });

    // Login to get token
    const loginRes = await req('POST', '/api/auth/login', {
      username: 'admin', password: 'testpass',
    });
    adminToken = loginRes.body.token;
  });

  afterAll(() => { if (server) server.close(); });

  it('should return empty events for a date range', async () => {
    const start = '2026-04-06T00:00:00.000Z';
    const end = '2026-04-13T00:00:00.000Z';
    const res = await req('GET', `/api/events?start=${start}&end=${end}`);

    expect(res.status).toBe(200);
    expect(res.body.erfolg).toBe(true);
    expect(res.body.termine).toEqual([]);
    expect(res.body.kalenderName).toBeDefined();
  });

  it('should reject event creation without auth', async () => {
    const res = await req('POST', '/api/events', {
      title: 'Test Event',
      start_time: '2026-04-07T10:00:00.000Z',
      end_time: '2026-04-07T12:00:00.000Z',
      category_id: 7,
    });
    expect(res.status).toBe(401);
  });

  it('should create an event with auth', async () => {
    const res = await req('POST', '/api/events', {
      title: 'Eishockey Training',
      start_time: '2026-04-07T18:00:00.000Z',
      end_time: '2026-04-07T20:00:00.000Z',
      category_id: 7,
      description: 'Reguläres Training',
      location: 'Eissporthalle',
    }, adminToken);

    expect(res.status).toBe(201);
    expect(res.body.titel).toBe('Eishockey Training');
    expect(res.body.farbName).toBe('ECB');
    expect(res.body.id).toBeDefined();
  });

  it('should find the created event in date range', async () => {
    const start = '2026-04-07T00:00:00.000Z';
    const end = '2026-04-08T00:00:00.000Z';
    const res = await req('GET', `/api/events?start=${start}&end=${end}`);

    expect(res.status).toBe(200);
    expect(res.body.termine.length).toBe(1);
    expect(res.body.termine[0].titel).toBe('Eishockey Training');
  });

  it('should update an event', async () => {
    const listRes = await req('GET', '/api/events?start=2026-04-07T00:00:00.000Z&end=2026-04-08T00:00:00.000Z');
    const eventId = listRes.body.termine[0].id;

    const res = await req('PUT', `/api/events/${eventId}`, {
      title: 'Updated Training',
    }, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.titel).toBe('Updated Training');
  });

  it('should reject event with end before start', async () => {
    const res = await req('POST', '/api/events', {
      title: 'Bad Event',
      start_time: '2026-04-07T20:00:00.000Z',
      end_time: '2026-04-07T18:00:00.000Z',
      category_id: 7,
    }, adminToken);

    expect(res.status).toBe(400);
  });

  it('should reject event with invalid category', async () => {
    const res = await req('POST', '/api/events', {
      title: 'Bad Category',
      start_time: '2026-04-07T10:00:00.000Z',
      end_time: '2026-04-07T12:00:00.000Z',
      category_id: 9999,
    }, adminToken);

    expect(res.status).toBe(400);
  });

  it('should delete an event', async () => {
    const listRes = await req('GET', '/api/events?start=2026-04-07T00:00:00.000Z&end=2026-04-08T00:00:00.000Z');
    const eventId = listRes.body.termine[0].id;

    const res = await req('DELETE', `/api/events/${eventId}`, null, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.erfolg).toBe(true);

    const listRes2 = await req('GET', '/api/events?start=2026-04-07T00:00:00.000Z&end=2026-04-08T00:00:00.000Z');
    expect(listRes2.body.termine.length).toBe(0);
  });

  it('should create all-day events', async () => {
    const res = await req('POST', '/api/events', {
      title: 'Ganztägig',
      start_time: '2026-04-10T00:00:00.000Z',
      end_time: '2026-04-11T00:00:00.000Z',
      category_id: 5,
      all_day: true,
    }, adminToken);

    expect(res.status).toBe(201);
    expect(res.body.ganztaegig).toBe(true);
  });

  it('should reject invalid date format', async () => {
    const res = await req('GET', '/api/events?start=not-a-date&end=also-not');
    expect(res.status).toBe(400);
  });

  it('should ignore repeat_weeks on the single-event endpoint', async () => {
    const res = await req('POST', '/api/events', {
      title: 'Kein Serientermin',
      start_time: '2026-07-06T18:00:00.000Z',
      end_time: '2026-07-06T20:00:00.000Z',
      category_id: 7,
      repeat_weeks: 5,
    }, adminToken);

    expect(res.status).toBe(201);
    expect(res.body.series_id).toBeNull();

    const list = await req('GET', '/api/events?start=2026-07-06T00:00:00.000Z&end=2026-08-20T00:00:00.000Z');
    expect(list.body.termine.filter(t => t.titel === 'Kein Serientermin')).toHaveLength(1);
  });

  // 2026-09-01 is a Tuesday; the range to 2026-09-29 covers five Tuesdays.
  describe('Series', () => {
    let seriesId;

  it('should create a weekly series', async () => {
    const res = await req('POST', '/api/events/series', {
      title: 'Training Herren',
      category_id: 7,
      weekday: 2,
      time_from: '18:00',
      time_to: '20:00',
      date_from: '2026-09-01',
      date_to: '2026-09-29',
      location: 'Eishalle',
    }, adminToken);

    expect(res.status).toBe(201);
    expect(res.body.serie.anzahl).toBe(5);
    expect(res.body.termine).toHaveLength(5);
    seriesId = res.body.serie.id;

    // Every occurrence falls on a Tuesday at the requested wall-clock time
    for (const t of res.body.termine) {
      const start = new Date(t.start);
      expect(start.getDay()).toBe(2);
      expect(start.getHours()).toBe(18);
      expect(new Date(t.ende).getHours()).toBe(20);
      expect(t.series_id).toBe(seriesId);
      expect(t.abweichend).toBe(false);
    }
  });

  it('should reject a range containing no matching weekday', async () => {
    const res = await req('POST', '/api/events/series', {
      title: 'Leer',
      category_id: 7,
      weekday: 1,
      time_from: '18:00',
      time_to: '20:00',
      date_from: '2026-09-01',
      date_to: '2026-09-03',
    }, adminToken);

    expect(res.status).toBe(400);
  });

  it('should reject an end time before the start time', async () => {
    const res = await req('POST', '/api/events/series', {
      title: 'Verdreht',
      category_id: 7,
      weekday: 2,
      time_from: '20:00',
      time_to: '18:00',
      date_from: '2026-09-01',
      date_to: '2026-09-29',
    }, adminToken);

    expect(res.status).toBe(400);
  });

  it('should load the series with all its events', async () => {
    const res = await req('GET', `/api/events/series/${seriesId}`, null, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.serie.titel).toBe('Training Herren');
    expect(res.body.serie.wochentag).toBe(2);
    expect(res.body.serie.zeitVon).toBe('18:00');
    expect(res.body.termine).toHaveLength(5);
  });

  it('should require auth to load a series', async () => {
    const res = await req('GET', `/api/events/series/${seriesId}`);
    expect(res.status).toBe(401);
  });

  it('should flag an individually adjusted event as abweichend', async () => {
    const series = await req('GET', `/api/events/series/${seriesId}`, null, adminToken);
    const second = series.body.termine[1];
    const newStart = new Date(second.start);
    newStart.setHours(19, 0, 0, 0);
    const newEnd = new Date(second.ende);
    newEnd.setHours(21, 0, 0, 0);

    const upd = await req('PUT', `/api/events/${second.id}`, {
      start_time: newStart.toISOString(),
      end_time: newEnd.toISOString(),
    }, adminToken);
    expect(upd.status).toBe(200);

    const after = await req('GET', `/api/events/series/${seriesId}`, null, adminToken);
    expect(after.body.termine).toHaveLength(5);
    expect(after.body.termine[1].abweichend).toBe(true);
    expect(after.body.termine[0].abweichend).toBe(false);
  });

  it('should delete a single event without breaking the series', async () => {
    const before = await req('GET', `/api/events/series/${seriesId}`, null, adminToken);
    const victim = before.body.termine[0];

    const del = await req('DELETE', `/api/events/${victim.id}`, null, adminToken);
    expect(del.status).toBe(200);

    const after = await req('GET', `/api/events/series/${seriesId}`, null, adminToken);
    expect(after.status).toBe(200);
    expect(after.body.termine).toHaveLength(4);
    // The series definition keeps its original period despite the deletion
    expect(after.body.serie.datumVon).toBe('2026-09-01');
  });

  it('should apply a new time to every event of the series', async () => {
    const res = await req('PUT', `/api/events/series/${seriesId}`, {
      time_from: '17:30',
      time_to: '19:30',
    }, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.serie.zeitVon).toBe('17:30');

    for (const t of res.body.termine) {
      const start = new Date(t.start);
      expect(start.getHours()).toBe(17);
      expect(start.getMinutes()).toBe(30);
      expect(new Date(t.ende).getHours()).toBe(19);
      // The previously adjusted event was overwritten too
      expect(t.abweichend).toBe(false);
    }
  });

  it('should rename every event when the series title changes', async () => {
    const res = await req('PUT', `/api/events/series/${seriesId}`, {
      title: 'Training Damen',
    }, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.termine.every(t => t.titel === 'Training Damen')).toBe(true);
  });

  it('should delete the series and all its events', async () => {
    const del = await req('DELETE', `/api/events/series/${seriesId}`, null, adminToken);
    expect(del.status).toBe(200);

    const after = await req('GET', `/api/events/series/${seriesId}`, null, adminToken);
    expect(after.status).toBe(404);

      const list = await req('GET', '/api/events?start=2026-09-01T00:00:00.000Z&end=2026-10-01T00:00:00.000Z');
      expect(list.body.termine.filter(t => t.series_id === seriesId)).toHaveLength(0);
    });
  });
});
