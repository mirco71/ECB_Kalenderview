const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const config = require('../config');
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH } = require('../passwords');

const router = express.Router();

// POST /api/auth/login
router.post(
  '/login',
  [
    body('username').trim().notEmpty().withMessage('Benutzername erforderlich'),
    body('password').notEmpty().withMessage('Passwort erforderlich'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { username, password } = req.body;
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Ungültiger Benutzername oder Passwort' });
    }

    // Async compare so the (deliberately slow) bcrypt hashing does not block the
    // event loop under repeated login attempts.
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Ungültiger Benutzername oder Passwort' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        display_name: user.display_name,
      },
    });
  }
);

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const db = getDb();
  const user = db
    .prepare('SELECT id, username, role, display_name FROM users WHERE id = ?')
    .get(req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  }

  res.json(user);
});

// PUT /api/auth/password — jeder angemeldete Benutzer ändert sein eigenes Passwort.
//
// Verlangt das aktuelle Passwort: Ein kurz unbeaufsichtigter, angemeldeter
// Browser soll nicht genügen, um das Konto zu übernehmen. Die Route liegt unter
// /api/auth und damit hinter dem authLimiter, Raten des aktuellen Passworts ist
// also gebremst. Bereits ausgestellte Tokens bleiben bis zu ihrem Ablauf gültig.
router.put(
  '/password',
  requireAuth,
  [
    body('current_password').notEmpty().withMessage('Aktuelles Passwort erforderlich'),
    body('new_password').isLength({ min: MIN_PASSWORD_LENGTH })
      .withMessage(`Neues Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const db = getDb();
    const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }

    const passt = await bcrypt.compare(req.body.current_password, user.password_hash);
    if (!passt) {
      return res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
    }

    const neuerHash = await bcrypt.hash(req.body.new_password, BCRYPT_ROUNDS);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(neuerHash, user.id);

    res.json({ erfolg: true, message: 'Passwort geändert' });
  }
);

module.exports = router;
