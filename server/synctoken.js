const crypto = require('crypto');
const { getDb } = require('./database');

/**
 * Dauerhafte Tokens für den Abgleich aus Hallenplanung.
 *
 * Sie ersetzen das Anmelde-Token, das nach 24 Stunden abläuft und deshalb
 * täglich von Hand nachgeholt werden musste. Ein Sync-Token gehört zu einem
 * Rechner, nicht zu einer Person: Es läuft nicht ab, ist einzeln widerrufbar
 * und gilt ausschließlich für die Abgleich-Endpunkte (siehe middleware/syncAuth.js).
 */

// Am Präfix erkennt die Anmeldeprüfung ein Sync-Token, ohne raten zu müssen.
const PREFIX = 'ecbsync_';

// So viele Zeichen des Tokens werden zur Wiedererkennung in der Liste angezeigt.
const PREFIX_ANZEIGE = PREFIX.length + 6;

function istSyncToken(wert) {
  return typeof wert === 'string' && wert.startsWith(PREFIX);
}

function hashVon(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Erzeugt ein neues Token und legt es an. Der Klartext wird nur hier
 * zurückgegeben und nirgends gespeichert.
 */
function erzeugeToken(label, erstellerId) {
  const token = PREFIX + crypto.randomBytes(24).toString('base64url');
  const db = getDb();

  const result = db
    .prepare('INSERT INTO sync_tokens (label, token_hash, prefix, created_by) VALUES (?, ?, ?, ?)')
    .run(label, hashVon(token), token.slice(0, PREFIX_ANZEIGE), erstellerId);

  return { token, id: result.lastInsertRowid };
}

/**
 * Sucht ein Token anhand seines Klartexts. Liefert den Datensatz samt
 * zugehörigem Benutzer oder null.
 */
function findeToken(token) {
  if (!istSyncToken(token)) return null;

  const db = getDb();
  const zeile = db
    .prepare(
      `SELECT t.id, t.label, t.created_by, u.username, u.role
       FROM sync_tokens t
       LEFT JOIN users u ON t.created_by = u.id
       WHERE t.token_hash = ?`
    )
    .get(hashVon(token));

  return zeile || null;
}

/**
 * Vermerkt die Benutzung. Absichtlich nur auf Minuten genau nützlich — die
 * Angabe dient der Frage "wird dieser Rechner noch benutzt", nicht der Messung.
 */
function vermerkeBenutzung(tokenId) {
  getDb()
    .prepare("UPDATE sync_tokens SET last_used_at = datetime('now') WHERE id = ?")
    .run(tokenId);
}

module.exports = { PREFIX, istSyncToken, erzeugeToken, findeToken, vermerkeBenutzung };
