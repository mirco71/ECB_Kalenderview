const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param, validationResult } = require('express-validator');
const { getDb } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const BCRYPT_ROUNDS = 12;

// All user routes require admin
router.use(requireAuth, requireAdmin);

// GET /api/users
router.get('/', (req, res) => {
  const db = getDb();
  const users = db
    .prepare('SELECT id, username, role, display_name, created_at, updated_at FROM users ORDER BY id ASC')
    .all();
  res.json(users);
});

// POST /api/users
router.post(
  '/',
  [
    body('username').trim().isLength({ min: 3 }).withMessage('Benutzername muss mindestens 3 Zeichen lang sein'),
    body('password').isLength({ min: 6 }).withMessage('Passwort muss mindestens 6 Zeichen lang sein'),
    body('role').isIn(['admin', 'editor']).withMessage('Rolle muss "admin" oder "editor" sein'),
    body('display_name').trim().notEmpty().withMessage('Anzeigename erforderlich'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { username, password, role, display_name } = req.body;
    const db = getDb();

    // Check for duplicate username
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Benutzername bereits vergeben' });
    }

    const password_hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

    const result = db
      .prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
      .run(username, password_hash, role, display_name);

    const user = db
      .prepare('SELECT id, username, role, display_name, created_at FROM users WHERE id = ?')
      .get(result.lastInsertRowid);

    res.status(201).json(user);
  }
);

// PUT /api/users/:id
router.put(
  '/:id',
  [
    param('id').isInt(),
    body('username').optional().trim().isLength({ min: 3 }),
    body('password').optional().isLength({ min: 6 }),
    body('role').optional().isIn(['admin', 'editor']),
    body('display_name').optional().trim().notEmpty(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(parseInt(req.params.id));
    if (!existing) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }

    const updates = {
      username: req.body.username ?? existing.username,
      role: req.body.role ?? existing.role,
      display_name: req.body.display_name ?? existing.display_name,
    };

    // Check duplicate username if changed
    if (updates.username !== existing.username) {
      const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(updates.username, parseInt(req.params.id));
      if (dup) {
        return res.status(409).json({ error: 'Benutzername bereits vergeben' });
      }
    }

    // Update password if provided
    let passwordSql = '';
    const params = [updates.username, updates.role, updates.display_name];

    if (req.body.password) {
      passwordSql = ', password_hash = ?';
      params.push(bcrypt.hashSync(req.body.password, BCRYPT_ROUNDS));
    }

    params.push(parseInt(req.params.id));

    db.prepare(
      `UPDATE users SET username = ?, role = ?, display_name = ?${passwordSql}, updated_at = datetime('now') WHERE id = ?`
    ).run(...params);

    const user = db
      .prepare('SELECT id, username, role, display_name, created_at, updated_at FROM users WHERE id = ?')
      .get(parseInt(req.params.id));

    res.json(user);
  }
);

// DELETE /api/users/:id
router.delete('/:id', param('id').isInt(), (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Ungültige Benutzer-ID' });
  }

  // Prevent self-deletion
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Sie können sich nicht selbst löschen' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(parseInt(req.params.id));
  if (!existing) {
    return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(parseInt(req.params.id));
  res.json({ erfolg: true, message: 'Benutzer gelöscht' });
});

module.exports = router;
