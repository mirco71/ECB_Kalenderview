const express = require('express');
const { query, validationResult } = require('express-validator');
const { getDb } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { localDateTime } = require('../datetime');

const router = express.Router();

// Das Protokoll enthält IP-Adressen und versuchte Benutzernamen — nur für Admins.
router.use(requireAuth, requireAdmin);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filter "Art". Default ist `alle`; `aenderungen` blendet Anmeldungen aus,
 * wenn fehlgeschlagene Logins die eigentlichen Änderungen verdrängen.
 */
const ARTEN = {
  aenderungen: "entity_type != 'auth'",
  termine: "entity_type IN ('event', 'series')",
  kategorien: "entity_type = 'category'",
  benutzer: "entity_type = 'user'",
  sync: "entity_type IN ('sync', 'sync_token')",
  anmeldungen: "action IN ('auth.login', 'auth.password_change')",
  fehlanmeldungen: "action = 'auth.login_failed'",
  alle: '1 = 1',
};

/** Lokaler Kalendertag → UTC-Zeitstempel im Format von datetime('now'). */
function sqliteUtc(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

// GET /api/audit?art=&user_id=&from=&to=&q=&limit=&offset=
router.get(
  '/',
  [
    query('art').optional().isIn(Object.keys(ARTEN)).withMessage('Unbekannte Art'),
    query('user_id').optional().isInt({ min: 1 }).withMessage('Ungültige Benutzer-ID'),
    query('from').optional().matches(DATE_PATTERN).withMessage('Ungültiges Startdatum'),
    query('to').optional().matches(DATE_PATTERN).withMessage('Ungültiges Enddatum'),
    query('q').optional().isString().isLength({ max: 100 }).withMessage('Suchbegriff zu lang'),
    query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('limit muss zwischen 1 und 200 liegen'),
    query('offset').optional().isInt({ min: 0 }).withMessage('Ungültiger offset'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const art = ARTEN[req.query.art || 'alle'];
    const bedingungen = [art];
    const parameter = [];

    if (req.query.user_id) {
      bedingungen.push('user_id = ?');
      parameter.push(parseInt(req.query.user_id));
    }
    if (req.query.from) {
      bedingungen.push('created_at >= ?');
      parameter.push(sqliteUtc(localDateTime(req.query.from, '00:00')));
    }
    if (req.query.to) {
      const bis = localDateTime(req.query.to, '00:00');
      bis.setDate(bis.getDate() + 1);
      bedingungen.push('created_at < ?');
      parameter.push(sqliteUtc(bis));
    }
    if (req.query.q && req.query.q.trim()) {
      // % und _ wörtlich nehmen — sonst findet "100%" alles, was mit 100 beginnt.
      const muster = `%${req.query.q.trim().replace(/[\\%_]/g, c => `\\${c}`)}%`;
      bedingungen.push("(summary LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')");
      parameter.push(muster, muster);
    }

    const where = bedingungen.join(' AND ');
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const db = getDb();
    const gesamt = db.prepare(`SELECT COUNT(*) AS count FROM audit_log WHERE ${where}`).get(...parameter).count;
    const zeilen = db
      .prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...parameter, limit, offset);

    res.json({
      erfolg: true,
      gesamt,
      eintraege: zeilen.map(z => ({
        id: z.id,
        zeitpunkt: `${z.created_at.replace(' ', 'T')}Z`,
        benutzerId: z.user_id,
        benutzer: z.username,
        aktion: z.action,
        bereich: z.entity_type,
        objektId: z.entity_id,
        zusammenfassung: z.summary,
        details: z.details ? JSON.parse(z.details) : null,
        ip: z.ip,
      })),
    });
  }
);

module.exports = router;
