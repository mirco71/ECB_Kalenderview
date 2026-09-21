const express = require('express');
const crypto = require('crypto');
const { body, query, param, validationResult } = require('express-validator');
const { getDb } = require('../database');
const config = require('../config');
const { requireAuth, optionalAuth, requireAdmin } = require('../middleware/auth');
const {
  toLocalDateString,
  toLocalTimeString,
  localDateTime,
  generateSeriesDates,
  MAX_SERIES_EVENTS,
} = require('../datetime');

const router = express.Router();

// Events carry their series definition along (LEFT JOIN — null for single events),
// so the admin list can group a series into one row without extra requests.
const EVENT_BASE = `SELECT e.*, c.name as category_name, c.color_hex as category_color,
                           c.color_bg as category_color_bg,
                           s.weekday as series_weekday, s.time_from as series_time_from,
                           s.time_to as series_time_to, s.date_from as series_date_from,
                           s.date_to as series_date_to,
                           (SELECT COUNT(*) FROM events e2 WHERE e2.series_id = e.series_id) as series_count
                    FROM events e
                    JOIN categories c ON e.category_id = c.id
                    LEFT JOIN series s ON e.series_id = s.id`;
const EVENT_SELECT = `${EVENT_BASE} WHERE e.id = ?`;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * SQL-Zusatzbedingung, die Termine anmeldepflichtiger Kategorien für nicht
 * angemeldete Abrufer ausblendet (Eismeister-Dienstzeiten sind intern).
 */
function sichtbarkeitsFilter(user) {
  return user ? '' : ' AND c.login_required = 0';
}

/**
 * Darf der Benutzer Termine dieser Kategorie anlegen, bearbeiten und löschen?
 *
 * Die Einschränkung klammert ausschließlich die Rolle 'eismeister': sie ist auf
 * die als eismeister_managed gekennzeichneten Kategorien begrenzt. Admins und
 * Editoren bleiben unbeschränkt und dürfen damit auch Eismeister-Termine ändern.
 */
function darfKategorieBearbeiten(db, user, categoryId) {
  if (!user || user.role !== 'eismeister') return true;

  const kategorie = db
    .prepare('SELECT eismeister_managed FROM categories WHERE id = ?')
    .get(parseInt(categoryId));
  return !!kategorie && kategorie.eismeister_managed === 1;
}

const KATEGORIE_VERBOTEN = 'Für diese Kategorie fehlt die Berechtigung';

// GET /api/events?start=ISO&end=ISO[&include_extern=1]
//
// Standardmäßig nur Termine, die die Halle belegen (in_hall = 1) — das ist die
// Hallenansicht. Auswärtsspiele finden woanders statt und gehören dort nicht
// hinein. Die Admin-Terminliste setzt include_extern=1, sonst könnte sie die
// Auswärtsspiele nicht anzeigen.
router.get(
  '/',
  optionalAuth,
  [
    query('start').isISO8601().withMessage('Ungültiges Startdatum'),
    query('end').isISO8601().withMessage('Ungültiges Enddatum'),
    query('include_extern').optional().isBoolean().withMessage('include_extern muss boolesch sein'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { start, end } = req.query;
    const includeExtern = req.query.include_extern === 'true' || req.query.include_extern === '1';
    const db = getDb();

    const hallFilter = includeExtern ? '' : ' AND e.in_hall = 1';
    const events = db
      .prepare(
        `${EVENT_BASE} WHERE e.start_time < ? AND e.end_time > ?${hallFilter}` +
        sichtbarkeitsFilter(req.user) +
        ' ORDER BY e.start_time ASC'
      )
      .all(end, start);

    res.json({
      erfolg: true,
      kalenderName: config.calendarName,
      termine: events.map(mapEventToTermin),
      startStunde: config.startHour,
      endStunde: config.endHour,
    });
  }
);

// GET /api/events/:id
router.get('/:id', optionalAuth, param('id').isInt(), (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Ungültige Event-ID' });
  }

  const db = getDb();
  const event = db
    .prepare(`${EVENT_BASE} WHERE e.id = ?${sichtbarkeitsFilter(req.user)}`)
    .get(parseInt(req.params.id));

  if (!event) {
    return res.status(404).json({ error: 'Termin nicht gefunden' });
  }

  res.json(mapEventToTermin(event));
});

// POST /api/events — single event only. Series are created via POST /api/events/series.
router.post(
  '/',
  requireAuth,
  [
    body('title').trim().notEmpty().withMessage('Titel erforderlich'),
    body('start_time').isISO8601().withMessage('Ungültiges Startdatum'),
    body('end_time').isISO8601().withMessage('Ungültiges Enddatum'),
    body('category_id').isInt({ min: 1 }).withMessage('Kategorie erforderlich'),
    body('all_day').optional().isBoolean(),
    body('description').optional().trim(),
    body('location').optional().trim(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { title, start_time, end_time, category_id, all_day, description, location } = req.body;
    const db = getDb();

    // Validate that end_time is after start_time
    if (new Date(end_time) <= new Date(start_time)) {
      return res.status(400).json({ error: 'Endzeit muss nach Startzeit liegen' });
    }

    // Validate category exists
    const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(parseInt(category_id));
    if (!category) {
      return res.status(400).json({ error: 'Kategorie nicht gefunden' });
    }

    if (!darfKategorieBearbeiten(db, req.user, category_id)) {
      return res.status(403).json({ error: KATEGORIE_VERBOTEN });
    }

    const result = db
      .prepare(
        `INSERT INTO events (title, start_time, end_time, category_id, all_day, description, location, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        title,
        new Date(start_time).toISOString(),
        new Date(end_time).toISOString(),
        parseInt(category_id),
        all_day ? 1 : 0,
        description || '',
        location || '',
        req.user.id
      );

    const event = db.prepare(EVENT_SELECT).get(result.lastInsertRowid);
    res.status(201).json(mapEventToTermin(event));
  }
);

// PUT /api/events/:id
router.put(
  '/:id',
  requireAuth,
  [
    param('id').isInt(),
    body('title').optional().trim().notEmpty().withMessage('Titel darf nicht leer sein'),
    body('start_time').optional().isISO8601().withMessage('Ungültiges Startdatum'),
    body('end_time').optional().isISO8601().withMessage('Ungültiges Enddatum'),
    body('category_id').optional().isInt({ min: 1 }),
    body('all_day').optional().isBoolean(),
    body('description').optional().trim(),
    body('location').optional().trim(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(parseInt(req.params.id));
    if (!existing) {
      return res.status(404).json({ error: 'Termin nicht gefunden' });
    }

    const updates = {
      title: req.body.title ?? existing.title,
      start_time: req.body.start_time ?? existing.start_time,
      end_time: req.body.end_time ?? existing.end_time,
      category_id: req.body.category_id != null ? parseInt(req.body.category_id) : existing.category_id,
      all_day: req.body.all_day !== undefined ? (req.body.all_day ? 1 : 0) : existing.all_day,
      description: req.body.description ?? existing.description,
      location: req.body.location ?? existing.location,
    };

    // Validate end > start
    if (new Date(updates.end_time) <= new Date(updates.start_time)) {
      return res.status(400).json({ error: 'Endzeit muss nach Startzeit liegen' });
    }

    // Validate category if changed
    if (req.body.category_id) {
      const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(parseInt(req.body.category_id));
      if (!category) {
        return res.status(400).json({ error: 'Kategorie nicht gefunden' });
      }
    }

    // Beide Kategorien prüfen: sonst könnte ein Eismeister einen fremden Termin
    // in seine Kategorie ziehen oder einen eigenen aus ihr heraus verschieben.
    if (!darfKategorieBearbeiten(db, req.user, existing.category_id) ||
        !darfKategorieBearbeiten(db, req.user, updates.category_id)) {
      return res.status(403).json({ error: KATEGORIE_VERBOTEN });
    }

    db.prepare(
      `UPDATE events SET title = ?, start_time = ?, end_time = ?, category_id = ?,
       all_day = ?, description = ?, location = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      updates.title,
      updates.start_time,
      updates.end_time,
      updates.category_id,
      updates.all_day,
      updates.description,
      updates.location,
      parseInt(req.params.id)
    );

    const event = db.prepare(EVENT_SELECT).get(parseInt(req.params.id));
    res.json(mapEventToTermin(event));
  }
);

// DELETE /api/events/:id
router.delete('/:id', requireAuth, param('id').isInt(), (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Ungültige Event-ID' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id, category_id FROM events WHERE id = ?').get(parseInt(req.params.id));
  if (!existing) {
    return res.status(404).json({ error: 'Termin nicht gefunden' });
  }

  if (!darfKategorieBearbeiten(db, req.user, existing.category_id)) {
    return res.status(403).json({ error: KATEGORIE_VERBOTEN });
  }

  db.prepare('DELETE FROM events WHERE id = ?').run(parseInt(req.params.id));
  res.json({ erfolg: true, message: 'Termin gelöscht' });
});

// ============ BULK DELETE ============

/** So viele Einträge zeigt die Vorschau höchstens einzeln an. */
const MAX_DETAILS = 50;

// POST /api/events/bulk-delete[?dry_run=true] — alle Termine eines Zeitraums
// in den gewählten Kategorien löschen (nur Admin).
//
// Zeitraum wie im Abgleich mit Hallenplanung (sync.js): lokale Kalendertage,
// abgegrenzt über start_time statt Überlappung. dry_run rechnet mit derselben
// Abfrage und schreibt nichts, damit Vorschau und Löschung nie auseinanderlaufen.
//
// Folgen, die der Aufrufer kennen muss: Spiele aus Hallenplanung kommen beim
// nächsten Veröffentlichen zurück, und die Bridge entfernt Gelöschtes auch aus
// den Google-Kalendern. Die Oberfläche nennt das vor der Bestätigung.
router.post(
  '/bulk-delete',
  requireAuth,
  requireAdmin,
  [
    query('dry_run').optional().isBoolean().withMessage('dry_run muss boolesch sein'),
    body('date_from').matches(DATE_PATTERN).withMessage('Ungültiges Startdatum'),
    body('date_to').matches(DATE_PATTERN).withMessage('Ungültiges Enddatum'),
    body('category_ids').isArray({ min: 1 }).withMessage('Mindestens eine Kategorie auswählen'),
    body('category_ids.*').isInt({ min: 1 }).withMessage('Ungültige Kategorie'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { date_from, date_to } = req.body;
    if (date_to < date_from) {
      return res.status(400).json({ error: 'Das Enddatum muss nach dem Startdatum liegen' });
    }

    const probelauf = req.query.dry_run === 'true' || req.query.dry_run === '1';
    const kategorien = req.body.category_ids.map(Number);
    const von = localDateTime(date_from, '00:00').toISOString();
    const bisDatum = localDateTime(date_to, '00:00');
    bisDatum.setDate(bisDatum.getDate() + 1);
    const bis = bisDatum.toISOString();

    // Eine Bedingung für Vorschau und Löschung — so zählt die Vorschau exakt das,
    // was danach gelöscht wird. `p` ist das Tabellenpräfix für die Abfrage mit JOIN.
    const kategorieListe = kategorien.map(() => '?').join(', ');
    const bedingung = (p = '') =>
      `${p}start_time >= ? AND ${p}start_time < ? AND ${p}category_id IN (${kategorieListe})`;
    const parameter = [von, bis, ...kategorien];

    const db = getDb();
    const treffer = db
      .prepare(
        `SELECT e.id, e.title, e.start_time, e.series_id, e.source, c.name AS category_name
         FROM events e
         JOIN categories c ON e.category_id = c.id
         WHERE ${bedingung('e.')}
         ORDER BY e.start_time ASC`
      )
      .all(...parameter);

    const nachKategorie = new Map();
    for (const t of treffer) {
      nachKategorie.set(t.category_name, (nachKategorie.get(t.category_name) || 0) + 1);
    }
    const serienIds = [...new Set(treffer.filter(t => t.series_id).map(t => t.series_id))];

    let serienEntfernt = 0;
    if (!probelauf && treffer.length > 0) {
      // Ein einziger Befehl: Der sql.js-Wrapper schreibt nach jedem Befehl die
      // ganze Datenbankdatei neu, Löschen Zeile für Zeile wäre entsprechend teuer.
      db.prepare(`DELETE FROM events WHERE ${bedingung()}`).run(...parameter);

      // Nur betroffene Serien, von denen kein Termin mehr übrig ist. Eine Serie
      // mit Terminen außerhalb des Zeitraums bleibt — wie beim Löschen eines
      // einzelnen Serientermins.
      if (serienIds.length > 0) {
        serienEntfernt = db
          .prepare(
            `DELETE FROM series
             WHERE id IN (${serienIds.map(() => '?').join(', ')})
               AND NOT EXISTS (SELECT 1 FROM events WHERE events.series_id = series.id)`
          )
          .run(...serienIds).changes;
      }
    }

    res.json({
      erfolg: true,
      probelauf,
      zeitraum: { von: date_from, bis: date_to },
      anzahl: treffer.length,
      nachKategorie: [...nachKategorie].map(([name, anzahl]) => ({ name, anzahl })),
      serienBetroffen: serienIds.length,
      serienEntfernt,
      ausHallenplanung: treffer.filter(t => t.source === 'hallenplanung').length,
      details: treffer.slice(0, MAX_DETAILS).map(t => ({
        titel: t.title,
        start: t.start_time,
        kategorie: t.category_name,
      })),
    });
  }
);

// ============ SERIES ============
// Note: all series routes have two path segments (/series/...) except POST /series,
// so none of them collide with the single-event /:id routes above.

// POST /api/events/series — create a weekly series and all its events
router.post(
  '/series',
  requireAuth,
  [
    body('title').trim().notEmpty().withMessage('Titel erforderlich'),
    body('category_id').isInt({ min: 1 }).withMessage('Kategorie erforderlich'),
    body('weekday').isInt({ min: 0, max: 6 }).withMessage('Wochentag erforderlich'),
    body('time_from').matches(TIME_PATTERN).withMessage('Ungültige Startzeit (z.B. 18:00)'),
    body('time_to').matches(TIME_PATTERN).withMessage('Ungültige Endzeit (z.B. 20:00)'),
    body('date_from').matches(DATE_PATTERN).withMessage('Ungültiges Startdatum'),
    body('date_to').matches(DATE_PATTERN).withMessage('Ungültiges Enddatum'),
    body('description').optional().trim(),
    body('location').optional().trim(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { title, category_id, weekday, time_from, time_to, date_from, date_to,
            description, location } = req.body;
    const db = getDb();

    if (time_to <= time_from) {
      return res.status(400).json({ error: 'Endzeit muss nach Startzeit liegen' });
    }
    if (date_to < date_from) {
      return res.status(400).json({ error: 'Das Enddatum muss nach dem Startdatum liegen' });
    }

    const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(parseInt(category_id));
    if (!category) {
      return res.status(400).json({ error: 'Kategorie nicht gefunden' });
    }

    if (!darfKategorieBearbeiten(db, req.user, category_id)) {
      return res.status(403).json({ error: KATEGORIE_VERBOTEN });
    }

    const occurrences = generateSeriesDates(parseInt(weekday), date_from, date_to, time_from, time_to);
    if (occurrences.length === 0) {
      return res.status(400).json({
        error: 'Im gewählten Zeitraum liegt kein einziger Termin dieses Wochentags',
      });
    }
    if (occurrences.length >= MAX_SERIES_EVENTS) {
      return res.status(400).json({
        error: `Zeitraum zu lang — maximal ${MAX_SERIES_EVENTS} Termine pro Serie`,
      });
    }

    const seriesId = crypto.randomUUID();

    // Store the actual first/last occurrence rather than the requested search
    // bounds — otherwise a series starting "from 18.07." would display that date
    // even though its first event falls on the 21st.
    const actualFrom = toLocalDateString(occurrences[0].start);
    const actualTo = toLocalDateString(occurrences[occurrences.length - 1].start);

    db.prepare(
      `INSERT INTO series (id, title, category_id, weekday, time_from, time_to,
                           date_from, date_to, description, location, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      seriesId, title, parseInt(category_id), parseInt(weekday), time_from, time_to,
      actualFrom, actualTo, description || '', location || '', req.user.id
    );

    for (const occ of occurrences) {
      db.prepare(
        `INSERT INTO events (title, start_time, end_time, category_id, all_day,
                             description, location, series_id, created_by)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
      ).run(
        title, occ.start.toISOString(), occ.end.toISOString(), parseInt(category_id),
        description || '', location || '', seriesId, req.user.id
      );
    }

    res.status(201).json({
      erfolg: true,
      message: `${occurrences.length} Termine erstellt`,
      ...loadSeries(db, seriesId),
    });
  }
);

// GET /api/events/series/:seriesId — series definition plus all its events
router.get('/series/:seriesId', requireAuth, (req, res) => {
  const db = getDb();
  const data = loadSeries(db, req.params.seriesId);
  if (!data) {
    return res.status(404).json({ error: 'Terminserie nicht gefunden' });
  }
  res.json(data);
});

// PUT /api/events/series/:seriesId — update the whole series
// title/category always apply to every event; time_from/time_to only when sent,
// and they overwrite individually adjusted events (the UI warns about this).
router.put(
  '/series/:seriesId',
  requireAuth,
  [
    body('title').optional().trim().notEmpty().withMessage('Titel darf nicht leer sein'),
    body('category_id').optional().isInt({ min: 1 }),
    body('weekday').optional().isInt({ min: 0, max: 6 }).withMessage('Wochentag muss zwischen 0 (So) und 6 (Sa) liegen'),
    body('time_from').optional().matches(TIME_PATTERN).withMessage('Ungültige Startzeit (z.B. 18:00)'),
    body('time_to').optional().matches(TIME_PATTERN).withMessage('Ungültige Endzeit (z.B. 20:00)'),
    body('description').optional().trim(),
    body('location').optional().trim(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const db = getDb();
    const seriesId = req.params.seriesId;
    const existing = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
    if (!existing) {
      return res.status(404).json({ error: 'Terminserie nicht gefunden' });
    }

    const updates = {
      title: req.body.title ?? existing.title,
      category_id: req.body.category_id != null ? parseInt(req.body.category_id) : existing.category_id,
      weekday: req.body.weekday != null ? parseInt(req.body.weekday) : existing.weekday,
      time_from: req.body.time_from ?? existing.time_from,
      time_to: req.body.time_to ?? existing.time_to,
      description: req.body.description ?? existing.description,
      location: req.body.location ?? existing.location,
    };

    if (updates.time_to <= updates.time_from) {
      return res.status(400).json({ error: 'Endzeit muss nach Startzeit liegen' });
    }

    if (req.body.category_id != null) {
      const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(updates.category_id);
      if (!category) {
        return res.status(400).json({ error: 'Kategorie nicht gefunden' });
      }
    }

    // Wie beim Einzeltermin beide Kategorien prüfen — alte und neue.
    if (!darfKategorieBearbeiten(db, req.user, existing.category_id) ||
        !darfKategorieBearbeiten(db, req.user, updates.category_id)) {
      return res.status(403).json({ error: KATEGORIE_VERBOTEN });
    }

    const timeChanged = (req.body.time_from != null && req.body.time_from !== existing.time_from) ||
                        (req.body.time_to != null && req.body.time_to !== existing.time_to);

    // Wochentag-Wechsel: Alle Termine wandern in ihrer Woche auf den neuen Tag.
    // Gerechnet wird über einen montagsbasierten Index (Mo=0..So=6), damit die
    // Termine in derselben Mo–So-Woche bleiben — so, wie der Kalender die Woche
    // darstellt. Ein reiner getDay()-Vergleich würde einen Montag beim Wechsel
    // auf Sonntag in die Vorwoche schieben.
    const weekdayChanged = updates.weekday !== existing.weekday;
    const montagsIndex = w => (w + 6) % 7;
    const deltaTage = weekdayChanged
      ? montagsIndex(updates.weekday) - montagsIndex(existing.weekday)
      : 0;

    const verschiebeDatum = (dateStr, tage) => {
      const [y, m, d] = dateStr.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      dt.setDate(dt.getDate() + tage);
      return toLocalDateString(dt);
    };

    const neuesDatumVon = weekdayChanged ? verschiebeDatum(existing.date_from, deltaTage) : existing.date_from;
    const neuesDatumBis = weekdayChanged ? verschiebeDatum(existing.date_to, deltaTage) : existing.date_to;

    db.prepare(
      `UPDATE series SET title = ?, category_id = ?, weekday = ?, time_from = ?, time_to = ?,
       date_from = ?, date_to = ?, description = ?, location = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      updates.title, updates.category_id, updates.weekday, updates.time_from, updates.time_to,
      neuesDatumVon, neuesDatumBis, updates.description, updates.location, seriesId
    );

    db.prepare(
      `UPDATE events SET title = ?, category_id = ?, description = ?, location = ?,
       updated_at = datetime('now') WHERE series_id = ?`
    ).run(updates.title, updates.category_id, updates.description, updates.location, seriesId);

    // Datum und/oder Uhrzeit der Einzeltermine neu berechnen. Das Datum kommt
    // aus dem eigenen Datum jedes Termins (plus Wochentag-Verschiebung), die
    // Uhrzeit bei einer Zeitänderung aus der neuen Serienzeit, sonst aus der
    // bisherigen Zeit des Termins. So bleibt die Wandzeit über einen Sommer-/
    // Winterzeit-Wechsel erhalten, und ein reiner Wochentag-Wechsel lässt eine
    // abweichend eingestellte Uhrzeit unangetastet.
    if (weekdayChanged || timeChanged) {
      const events = db
        .prepare('SELECT id, start_time, end_time FROM events WHERE series_id = ?')
        .all(seriesId);

      for (const ev of events) {
        const start = new Date(ev.start_time);
        const end = new Date(ev.end_time);

        let tag = toLocalDateString(start);
        if (deltaTage !== 0) tag = verschiebeDatum(tag, deltaTage);

        const von = timeChanged ? updates.time_from : toLocalTimeString(start);
        const bis = timeChanged ? updates.time_to : toLocalTimeString(end);

        const neuStart = localDateTime(tag, von);
        const neuEnde = localDateTime(tag, bis);
        db.prepare(
          `UPDATE events SET start_time = ?, end_time = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(neuStart.toISOString(), neuEnde.toISOString(), ev.id);
      }
    }

    res.json({ erfolg: true, ...loadSeries(db, seriesId) });
  }
);

// DELETE /api/events/series/:seriesId — delete the series and all its events
router.delete('/series/:seriesId', requireAuth, (req, res) => {
  const db = getDb();
  const seriesId = req.params.seriesId;

  const count = db.prepare('SELECT COUNT(*) as count FROM events WHERE series_id = ?').get(seriesId);
  const series = db.prepare('SELECT id, category_id FROM series WHERE id = ?').get(seriesId);
  if ((!count || count.count === 0) && !series) {
    return res.status(404).json({ error: 'Terminserie nicht gefunden' });
  }

  if (series && !darfKategorieBearbeiten(db, req.user, series.category_id)) {
    return res.status(403).json({ error: KATEGORIE_VERBOTEN });
  }

  db.prepare('DELETE FROM events WHERE series_id = ?').run(seriesId);
  db.prepare('DELETE FROM series WHERE id = ?').run(seriesId);
  res.json({ erfolg: true, message: `${count.count} Termine der Serie gelöscht` });
});

// ============ HELPER ============

/**
 * Loads a series definition together with its events. Each event carries an
 * `abweichend` flag: true when its wall-clock time differs from the series
 * definition (an individually adjusted occurrence).
 */
function loadSeries(db, seriesId) {
  const series = db
    .prepare(
      `SELECT s.*, c.name as category_name, c.color_hex as category_color
       FROM series s
       JOIN categories c ON s.category_id = c.id
       WHERE s.id = ?`
    )
    .get(seriesId);
  if (!series) return null;

  const events = db
    .prepare(`${EVENT_BASE} WHERE e.series_id = ? ORDER BY e.start_time ASC`)
    .all(seriesId);

  return {
    serie: {
      id: series.id,
      titel: series.title,
      category_id: series.category_id,
      farbName: series.category_name,
      farbHex: series.category_color,
      wochentag: series.weekday,
      zeitVon: series.time_from,
      zeitBis: series.time_to,
      datumVon: series.date_from,
      datumBis: series.date_to,
      beschreibung: series.description || '',
      ort: series.location || '',
      anzahl: events.length,
    },
    termine: events.map(row => ({
      ...mapEventToTermin(row),
      abweichend:
        toLocalTimeString(new Date(row.start_time)) !== series.time_from ||
        toLocalTimeString(new Date(row.end_time)) !== series.time_to,
    })),
  };
}

function mapEventToTermin(row) {
  return {
    id: row.id,
    titel: row.title,
    start: new Date(row.start_time).getTime(),
    ende: new Date(row.end_time).getTime(),
    farbe: String(row.category_id),
    farbName: row.category_name,
    farbHex: row.category_color,
    farbBg: row.category_color_bg,
    ganztaegig: row.all_day === 1,
    beschreibung: row.description || '',
    ort: row.location || '',
    series_id: row.series_id || null,
    // Present only for events that belong to a series (see EVENT_BASE join).
    serie: row.series_id && row.series_weekday != null
      ? {
          wochentag: row.series_weekday,
          zeitVon: row.series_time_from,
          zeitBis: row.series_time_to,
          datumVon: row.series_date_from,
          datumBis: row.series_date_to,
          anzahl: row.series_count,
        }
      : null,
    created_by: row.created_by,
  };
}

module.exports = router;
