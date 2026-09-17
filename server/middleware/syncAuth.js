const { requireAuth } = require('./auth');
const { istSyncToken, findeToken, vermerkeBenutzung } = require('../synctoken');

/**
 * Anmeldeprüfung der Abgleich-Endpunkte. Akzeptiert zwei Arten von Token:
 *
 * - ein dauerhaftes Sync-Token (Präfix ecbsync_) aus Hallenplanung
 * - das normale Anmelde-Token, damit ein Admin den Abgleich auch aus dem
 *   Browser heraus auslösen kann
 *
 * Ein Sync-Token gilt NUR hier. Überall sonst greift requireAuth, das einen
 * solchen Wert nicht als JWT verifizieren kann und mit 401 ablehnt — ein
 * abhandengekommenes Token kann damit weder Benutzer noch Kategorien anfassen.
 */
function requireSyncAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const wert = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : null;

  if (!istSyncToken(wert)) return requireAuth(req, res, next);

  const token = findeToken(wert);
  if (!token) {
    return res.status(401).json({ error: 'Ungültiges oder widerrufenes Sync-Token' });
  }

  // Der Abgleich schreibt Termine auf das Konto, das das Token erzeugt hat.
  req.user = { id: token.created_by, username: token.username, role: token.role };
  req.syncToken = { id: token.id, label: token.label };
  vermerkeBenutzung(token.id);
  next();
}

module.exports = { requireSyncAuth };
