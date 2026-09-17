const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { getDb } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { erzeugeToken } = require('../synctoken');

const router = express.Router();

// Sync-Tokens dürfen die ganze Saison überschreiben und löschen — Verwaltung
// deshalb ausschließlich für Admins.
router.use(requireAuth, requireAdmin);

// GET /api/sync-tokens
router.get('/', (req, res) => {
  const db = getDb();
  const tokens = db
    .prepare(
      `SELECT t.id, t.label, t.prefix, t.created_at, t.last_used_at,
              u.display_name AS created_by_name
       FROM sync_tokens t
       LEFT JOIN users u ON t.created_by = u.id
       ORDER BY t.created_at ASC`
    )
    .all();
  res.json(tokens);
});

// POST /api/sync-tokens — erzeugt ein Token; der Klartext ist nur in dieser
// Antwort enthalten und danach nicht mehr abrufbar.
router.post(
  '/',
  [body('label').trim().notEmpty().withMessage('Bezeichnung erforderlich')],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { token, id } = erzeugeToken(req.body.label, req.user.id);
    const zeile = getDb()
      .prepare('SELECT id, label, prefix, created_at, last_used_at FROM sync_tokens WHERE id = ?')
      .get(id);

    res.status(201).json({ ...zeile, token });
  }
);

// DELETE /api/sync-tokens/:id — widerruft ein Token. Der Eintrag im sync_log
// bleibt bestehen, damit die Historie nicht mit verschwindet.
router.delete('/:id', param('id').isInt(), (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Ungültige Token-ID' });
  }

  const db = getDb();
  const vorhanden = db.prepare('SELECT id FROM sync_tokens WHERE id = ?').get(parseInt(req.params.id));
  if (!vorhanden) {
    return res.status(404).json({ error: 'Token nicht gefunden' });
  }

  db.prepare('DELETE FROM sync_tokens WHERE id = ?').run(parseInt(req.params.id));
  res.json({ erfolg: true, message: 'Token widerrufen' });
});

module.exports = router;
