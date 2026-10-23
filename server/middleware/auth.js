const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../database');

const SESSION_COOKIE = 'ecb_session';
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60; // 8h, keep in sync with the JWT lifetime
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Reads one cookie from the Cookie header (small helper instead of a
 * cookie-parser dependency).
 */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Attributes of the session cookie. Set and clear must use the same ones,
 * otherwise the browser keeps the old cookie.
 */
function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: config.secureTransport,
  };
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    ...sessionCookieOptions(),
    maxAge: SESSION_MAX_AGE_SECONDS * 1000,
  });
}

function clearSessionCookie(res) {
  // Max-Age=0 with identical attributes; explicit instead of res.clearCookie(),
  // which only sends an Expires date.
  res.cookie(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
}

/**
 * Issues the login JWT (8h). `tv` ties it to users.token_version, so logout and
 * password change can revoke all tokens issued before.
 */
function signSessionToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.token_version },
    config.jwtSecret,
    { expiresIn: SESSION_MAX_AGE_SECONDS }
  );
}

/**
 * CSRF guard for cookie sessions: a state-changing request must come from the
 * own origin. SameSite=Strict already covers browsers; this is the second layer.
 */
function isSameOrigin(req) {
  const origin = req.get('origin');
  if (origin) return origin === `${req.protocol}://${req.get('host')}`;
  return req.get('sec-fetch-site') === 'same-origin';
}

/**
 * Shared by requireAuth and optionalAuth. Returns { user } on success or
 * { status, error } on failure; `anonymous` means no credentials were sent.
 *
 * Token source: Authorization: Bearer first, otherwise the session cookie.
 * The role always comes from the database, never from the token, so a role
 * change or a deleted account takes effect immediately.
 */
function authenticate(req) {
  const authHeader = req.headers.authorization;
  let token = null;
  let fromCookie = false;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else {
    token = readCookie(req, SESSION_COOKIE);
    fromCookie = !!token;
  }

  if (!token) return { anonymous: true, status: 401, error: 'Authentifizierung erforderlich' };

  let decoded;
  try {
    // Pin the algorithm so a token cannot dictate a weaker/none verification.
    decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch (err) {
    return { status: 401, error: 'Ungültiger oder abgelaufener Token' };
  }

  const dbUser = getDb()
    .prepare('SELECT id, username, role, token_version FROM users WHERE id = ?')
    .get(decoded.id);
  if (!dbUser || decoded.tv !== dbUser.token_version) {
    return { status: 401, error: 'Ungültiger oder abgelaufener Token' };
  }

  if (fromCookie && !SAFE_METHODS.includes(req.method) && !isSameOrigin(req)) {
    return { status: 403, error: 'Anfrage von fremder Herkunft abgelehnt' };
  }

  return {
    user: { id: dbUser.id, username: dbUser.username, role: dbUser.role },
  };
}

/**
 * Middleware that authenticates the request (Bearer header or session cookie).
 * Attaches the user (role from the database) to req.user on success.
 */
function requireAuth(req, res, next) {
  const result = authenticate(req);
  if (!result.user) return res.status(result.status).json({ error: result.error });
  req.user = result.user;
  next();
}

/**
 * Wie requireAuth, bricht aber nie ab: req.user wird gesetzt, wenn ein gültiges
 * Token mitkommt, und bleibt sonst undefined. Für öffentliche Endpunkte, die
 * angemeldeten Benutzern mehr zeigen als anonymen (Kategorien mit
 * login_required). requireAuth lässt sich dafür nicht verwenden — es antwortet
 * ohne Token immer mit 401.
 */
function optionalAuth(req, res, next) {
  const result = authenticate(req);
  // Ungültiges oder abgelaufenes Token wird wie "nicht angemeldet" behandelt.
  if (result.user) req.user = result.user;
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

module.exports = {
  requireAuth,
  optionalAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
  signSessionToken,
};
