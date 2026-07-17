const express = require('express');
const crypto = require('crypto');
const { body, query, param, validationResult } = require('express-validator');
const { getDb } = require('../database');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/events?start=ISO&end=ISO
router.get(
  '/',
  [
    query('start').isISO8601().withMessage('Ungültiges Startdatum'),
    query('end').isISO8601().withMessage('Ungültiges Enddatum'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { start, end } = req.query;
    const db = getDb();

    const events = db
      .prepare(
        `SELECT e.*, c.name as category_name, c.color_hex as category_color, 
                c.color_bg as category_color_bg
         FROM events e
         JOIN categories c ON e.category_id = c.id
         WHERE e.start_time < ? AND e.end_time > ?
         ORDER BY e.start_time ASC`
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
router.get('/:id', param('id').isInt(), (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Ungültige Event-ID' });
  }

  const db = getDb();
  const event = db
    .prepare(
      `SELECT e.*, c.name as category_name, c.color_hex as category_color,
              c.color_bg as category_color_bg
       FROM events e
       JOIN categories c ON e.category_id = c.id
       WHERE e.id = ?`
    )
    .get(parseInt(req.params.id));

  if (!event) {
    return res.status(404).json({ error: 'Termin nicht gefunden' });
  }

  res.json(mapEventToTermin(event));
});

// POST /api/events
// Supports optional repeat_weeks parameter to create a weekly series
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
    body('repeat_weeks').optional().isInt({ min: 1, max: 52 }).withMessage('Wiederholungen: 1-52 Wochen'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { title, start_time, end_time, category_id, all_day, description, location, repeat_weeks } = req.body;
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

    const weeks = parseInt(repeat_weeks) || 1;
    const seriesId = weeks > 1 ? crypto.randomUUID() : null;
    const createdEvents = [];

    for (let i = 0; i < weeks; i++) {
      const startDate = new Date(start_time);
      const endDate = new Date(end_time);
      startDate.setDate(startDate.getDate() + (i * 7));
      endDate.setDate(endDate.getDate() + (i * 7));

      const result = db
        .prepare(
          `INSERT INTO events (title, start_time, end_time, category_id, all_day, description, location, series_id, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          title,
          startDate.toISOString(),
          endDate.toISOString(),
          parseInt(category_id),
          all_day ? 1 : 0,
          description || '',
          location || '',
          seriesId,
          req.user.id
        );

      const event = db
        .prepare(
          `SELECT e.*, c.name as category_name, c.color_hex as category_color,
                  c.color_bg as category_color_bg
           FROM events e
           JOIN categories c ON e.category_id = c.id
           WHERE e.id = ?`
        )
        .get(result.lastInsertRowid);

      createdEvents.push(mapEventToTermin(event));
    }

    if (weeks === 1) {
      res.status(201).json(createdEvents[0]);
    } else {
      res.status(201).json({
        message: `${weeks} Termine erstellt (Wochenserie)`,
        series_id: seriesId,
        count: createdEvents.length,
        termine: createdEvents,
      });
    }
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

    const event = db
      .prepare(
        `SELECT e.*, c.name as category_name, c.color_hex as category_color,
                c.color_bg as category_color_bg
         FROM events e
         JOIN categories c ON e.category_id = c.id
         WHERE e.id = ?`
      )
      .get(parseInt(req.params.id));

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
  const existing = db.prepare('SELECT id FROM events WHERE id = ?').get(parseInt(req.params.id));
  if (!existing) {
    return res.status(404).json({ error: 'Termin nicht gefunden' });
  }

  db.prepare('DELETE FROM events WHERE id = ?').run(parseInt(req.params.id));
  res.json({ erfolg: true, message: 'Termin gelöscht' });
});

// DELETE /api/events/series/:seriesId — delete all events in a series
router.delete('/series/:seriesId', requireAuth, (req, res) => {
  const seriesId = req.params.seriesId;
  if (!seriesId) {
    return res.status(400).json({ error: 'Series-ID erforderlich' });
  }

  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as count FROM events WHERE series_id = ?').get(seriesId);
  if (!count || count.count === 0) {
    return res.status(404).json({ error: 'Terminserie nicht gefunden' });
  }

  db.prepare('DELETE FROM events WHERE series_id = ?').run(seriesId);
  res.json({ erfolg: true, message: `${count.count} Termine der Serie gelöscht` });
});

// ============ HELPER ============

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
    created_by: row.created_by,
  };
}

module.exports = router;
