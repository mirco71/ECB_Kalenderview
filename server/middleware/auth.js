const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Middleware that verifies JWT token from Authorization header.
 * Attaches decoded user payload to req.user on success.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentifizierung erforderlich' });
  }

  const token = authHeader.split(' ')[1];
  try {
    // Pin the algorithm so a token cannot dictate a weaker/none verification.
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Ungültiger oder abgelaufener Token' });
  }
}

/**
 * Wie requireAuth, bricht aber nie ab: req.user wird gesetzt, wenn ein gültiges
 * Token mitkommt, und bleibt sonst undefined. Für öffentliche Endpunkte, die
 * angemeldeten Benutzern mehr zeigen als anonymen (Kategorien mit
 * login_required). requireAuth lässt sich dafür nicht verwenden — es antwortet
 * ohne Token immer mit 401.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

  try {
    req.user = jwt.verify(authHeader.split(' ')[1], config.jwtSecret, { algorithms: ['HS256'] });
  } catch (err) {
    // Ungültiges oder abgelaufenes Token wird wie "nicht angemeldet" behandelt.
  }
  next();
}

/**
 * Middleware that requires the authenticated user to have the 'admin' role.
 * Must be used after requireAuth.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Nur Administratoren haben Zugriff' });
  }
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin };
