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

  it('should create a weekly series with repeat_weeks', async () => {
    const res = await req('POST', '/api/events', {
      title: 'Weekly Training',
      start_time: '2026-05-04T18:00:00.000Z',
      end_time: '2026-05-04T20:00:00.000Z',
      category_id: 7,
      description: 'Wöchentliches Training',
      repeat_weeks: 3,
    }, adminToken);

    expect(res.status).toBe(201);
    expect(res.body.count).toBe(3);
    expect(res.body.series_id).toBeDefined();
    expect(res.body.termine).toHaveLength(3);

    // Verify events are 7 days apart
    const starts = res.body.termine.map(t => new Date(t.start).getTime());
    expect(starts[1] - starts[0]).toBe(7 * 24 * 60 * 60 * 1000);
    expect(starts[2] - starts[1]).toBe(7 * 24 * 60 * 60 * 1000);

    // All should share the same series_id
    const seriesIds = res.body.termine.map(t => t.series_id);
    expect(seriesIds[0]).toBe(seriesIds[1]);
    expect(seriesIds[1]).toBe(seriesIds[2]);
  });

  it('should return series_id in event response', async () => {
    const start = '2026-05-04T00:00:00.000Z';
    const end = '2026-05-25T00:00:00.000Z';
    const res = await req('GET', `/api/events?start=${start}&end=${end}`);

    expect(res.status).toBe(200);
    const seriesEvents = res.body.termine.filter(t => t.series_id !== null);
    expect(seriesEvents.length).toBeGreaterThanOrEqual(3);
    expect(seriesEvents[0].series_id).toBeDefined();
  });

  it('should delete an entire series by series_id', async () => {
    // First get an event with a series_id
    const listRes = await req('GET', '/api/events?start=2026-05-04T00:00:00.000Z&end=2026-05-25T00:00:00.000Z');
    const seriesEvent = listRes.body.termine.find(t => t.series_id !== null);
    expect(seriesEvent).toBeDefined();

    const seriesId = seriesEvent.series_id;

    // Delete the whole series
    const deleteRes = await req('DELETE', `/api/events/series/${seriesId}`, null, adminToken);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.erfolg).toBe(true);

    // Verify all series events are gone
    const listRes2 = await req('GET', '/api/events?start=2026-05-04T00:00:00.000Z&end=2026-05-25T00:00:00.000Z');
    const remaining = listRes2.body.termine.filter(t => t.series_id === seriesId);
    expect(remaining.length).toBe(0);
  });
});
