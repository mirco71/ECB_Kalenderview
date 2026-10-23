const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../database');
const { requireAuth, setSessionCookie, clearSessionCookie, signSessionToken } = require('../middleware/auth');
const { BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH } = require('../passwords');
const { logAudit } = require('../audit');

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

    // Failed logins are logged with the attempted name (never the password).
    // Brute force cannot flood the log: the authLimiter answers with 429
    // before the handler runs.
    const fehlschlag = (grund) => {
      logAudit(db, req, {
        action: 'auth.login_failed',
        entityType: 'auth',
        actor: { id: user ? user.id : null, username: String(username).slice(0, 100) },
        summary: `Anmeldung fehlgeschlagen: ${grund}`,
      });
      return res.status(401).json({ error: 'Ungültiger Benutzername oder Passwort' });
    };

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return fehlschlag('Benutzer unbekannt');
    }

    // Async compare so the (deliberately slow) bcrypt hashing does not block the
    // event loop under repeated login attempts.
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return fehlschlag('Passwort falsch');
    }

    logAudit(db, req, {
      action: 'auth.login',
      entityType: 'auth',
      actor: user,
      summary: 'Angemeldet',
    });

    // The token only travels as HttpOnly cookie, never in the body — page
    // scripts (and thus XSS) cannot read it.
    setSessionCookie(res, signSessionToken(user));

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        display_name: user.display_name,
      },
    });
  }
);

// POST /api/auth/logout — beendet die Sitzung serverseitig.
//
// token_version hochzählen macht jedes bisher ausgestellte Token dieses Benutzers
// ungültig (auch auf anderen Geräten); das bloße Löschen des Cookies würde ein
// abgegriffenes Token weiter gültig lassen.
router.post('/logout', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE users SET token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(req.user.id);

  logAudit(db, req, {
    action: 'auth.logout',
    entityType: 'auth',
    entityId: req.user.id,
    summary: 'Abgemeldet',
  });

  clearSessionCookie(res);
  res.json({ erfolg: true });
});

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
// also gebremst. Die Änderung zählt token_version hoch und beendet damit alle
// anderen Sitzungen (ein abgegriffenes Token hilft nach einer Passwortänderung
// nichts mehr); die aktuelle Sitzung bekommt ein neues Cookie und bleibt angemeldet.
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
    const user = db.prepare('SELECT id, username, role, password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }

    const passt = await bcrypt.compare(req.body.current_password, user.password_hash);
    if (!passt) {
      return res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
    }

    const neuerHash = await bcrypt.hash(req.body.new_password, BCRYPT_ROUNDS);
    db.prepare(
      "UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?"
    ).run(neuerHash, user.id);
    const aktuell = db.prepare('SELECT token_version FROM users WHERE id = ?').get(user.id);
    setSessionCookie(res, signSessionToken({ ...user, token_version: aktuell.token_version }));

    logAudit(db, req, {
      action: 'auth.password_change',
      entityType: 'auth',
      entityId: user.id,
      summary: 'Eigenes Passwort geändert',
    });

    res.json({ erfolg: true, message: 'Passwort geändert' });
  }
);

module.exports = router;
