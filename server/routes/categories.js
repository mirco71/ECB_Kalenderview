const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { getDb } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/categories (public)
router.get('/', (req, res) => {
  const db = getDb();
  const categories = db
    .prepare('SELECT * FROM categories ORDER BY sort_order ASC')
    .all();
  res.json(categories);
});

// POST /api/categories (admin only)
router.post(
  '/',
  requireAuth,
  requireAdmin,
  [
    body('name').trim().notEmpty().withMessage('Name erforderlich'),
    body('color_hex').matches(/^#[0-9a-fA-F]{6}$/).withMessage('Ungültige Farbe (z.B. #ff0000)'),
    body('color_bg').trim().notEmpty().withMessage('Hintergrundfarbe erforderlich'),
    body('sort_order').optional().isInt(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { name, color_hex, color_bg, sort_order } = req.body;
    const db = getDb();

    // Check for duplicate name
    const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
    if (existing) {
      return res.status(409).json({ error: 'Kategorie mit diesem Namen existiert bereits' });
    }

    const result = db
      .prepare('INSERT INTO categories (name, color_hex, color_bg, sort_order) VALUES (?, ?, ?, ?)')
      .run(name, color_hex, color_bg, sort_order || 0);

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(category);
  }
);

// PUT /api/categories/:id (admin only)
router.put(
  '/:id',
  requireAuth,
  requireAdmin,
  [
    param('id').isInt(),
    body('name').optional().trim().notEmpty(),
    body('color_hex').optional().matches(/^#[0-9a-fA-F]{6}$/),
    body('color_bg').optional().trim().notEmpty(),
    body('sort_order').optional().isInt(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(parseInt(req.params.id));
    if (!existing) {
      return res.status(404).json({ error: 'Kategorie nicht gefunden' });
    }

    const updates = {
      name: req.body.name ?? existing.name,
      color_hex: req.body.color_hex ?? existing.color_hex,
      color_bg: req.body.color_bg ?? existing.color_bg,
      sort_order: req.body.sort_order ?? existing.sort_order,
    };

    // Check for duplicate name (if name changed)
    if (updates.name !== existing.name) {
      const dup = db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(updates.name, parseInt(req.params.id));
      if (dup) {
        return res.status(409).json({ error: 'Kategorie mit diesem Namen existiert bereits' });
      }
    }

    db.prepare('UPDATE categories SET name = ?, color_hex = ?, color_bg = ?, sort_order = ? WHERE id = ?')
      .run(updates.name, updates.color_hex, updates.color_bg, updates.sort_order, parseInt(req.params.id));

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(parseInt(req.params.id));
    res.json(category);
  }
);

// DELETE /api/categories/:id (admin only)
router.delete('/:id', requireAuth, requireAdmin, param('id').isInt(), (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Ungültige Kategorie-ID' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM categories WHERE id = ?').get(parseInt(req.params.id));
  if (!existing) {
    return res.status(404).json({ error: 'Kategorie nicht gefunden' });
  }

  // Check if category is in use
  const inUse = db.prepare('SELECT COUNT(*) as count FROM events WHERE category_id = ?').get(parseInt(req.params.id));
  if (inUse.count > 0) {
    return res.status(409).json({
      error: `Kategorie wird von ${inUse.count} Termin(en) verwendet und kann nicht gelöscht werden`,
    });
  }

  db.prepare('DELETE FROM categories WHERE id = ?').run(parseInt(req.params.id));
  res.json({ erfolg: true, message: 'Kategorie gelöscht' });
});

module.exports = router;
