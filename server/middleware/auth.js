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
 * Middleware that requires the authenticated user to have the 'admin' role.
 * Must be used after requireAuth.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Nur Administratoren haben Zugriff' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
