/**
 * Änderungsprotokoll (audit_log): wer hat wann was geändert.
 *
 * Details werden bereits lesbar abgelegt — deutsche Feldnamen, Zeiten in
 * lokaler Wandzeit, Kategorien mit Namen statt ID. So bleibt ein Eintrag
 * verständlich, auch wenn die Kategorie oder der Benutzer später gelöscht wird,
 * und das Frontend muss nichts nachschlagen.
 *
 * Nie ins Protokoll: Passwörter, Passwort-Hashes, Token-Klartexte.
 */
const { toLocalDateString, toLocalTimeString } = require('./datetime');

const RETENTION = '-6 months';
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastPrune = 0;

/** Entfernt Einträge jenseits der Aufbewahrungsfrist. Fasst nur audit_log an. */
function pruneAudit(db) {
  lastPrune = Date.now();
  try {
    db.prepare(`DELETE FROM audit_log WHERE created_at < datetime('now', '${RETENTION}')`).run();
  } catch (err) {
    console.error('Aufräumen des Änderungsprotokolls fehlgeschlagen:', err);
  }
}

function clientIp(req) {
  // Same key as the auth rate limiter: behind the Cloudflare tunnel req.ip is cloudflared.
  return req.get('CF-Connecting-IP') || req.ip || null;
}

/**
 * Schreibt einen Protokolleintrag. Wirft nie: Ein fehlgeschlagener Eintrag darf
 * eine bereits erfolgreich geschriebene Änderung nicht mit 500 enden lassen.
 *
 * `actor` überschreibt req.user — für den Login, wo req.user noch nicht gesetzt ist.
 */
function logAudit(db, req, { action, entityType, entityId = null, summary, details = null, actor }) {
  try {
    const wer = actor !== undefined ? actor : req.user;
    db.prepare(
      `INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, summary, details, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      wer && wer.id != null ? wer.id : null,
      wer && wer.username != null ? String(wer.username) : null,
      action,
      entityType,
      entityId != null ? String(entityId) : null,
      summary,
      details ? JSON.stringify(details) : null,
      clientIp(req)
    );
  } catch (err) {
    console.error('Eintrag ins Änderungsprotokoll fehlgeschlagen:', err);
    return;
  }
  if (Date.now() - lastPrune > PRUNE_INTERVAL_MS) pruneAudit(db);
}

/**
 * Vergleicht zwei gleich aufgebaute Ansichten und liefert { feld: [alt, neu] }
 * für jedes abweichende Feld, oder null, wenn sich nichts geändert hat.
 */
function diffFields(before, after) {
  const changes = {};
  for (const feld of Object.keys(after)) {
    const alt = before[feld] ?? '';
    const neu = after[feld] ?? '';
    if (String(alt) !== String(neu)) changes[feld] = [alt, neu];
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/** "03.10.2026 18:00" in lokaler Zeit — toISOString() wäre UTC. */
function formatWhen(value) {
  const d = new Date(value);
  const [y, m, day] = toLocalDateString(d).split('-');
  return `${day}.${m}.${y} ${toLocalTimeString(d)}`;
}

/** "2026-10-03" → "03.10.2026" */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

const jaNein = v => (v ? 'ja' : 'nein');

const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function categoryName(db, id) {
  const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(parseInt(id));
  return row ? row.name : `#${id}`;
}

/** Lesbare Ansicht einer events-Zeile (bzw. eines Objekts mit denselben Spalten). */
function eventView(db, e) {
  return {
    Titel: e.title,
    Start: formatWhen(e.start_time),
    Ende: formatWhen(e.end_time),
    Kategorie: categoryName(db, e.category_id),
    'Ganztägig': jaNein(e.all_day),
    Beschreibung: e.description || '',
    Ort: e.location || '',
  };
}

/** Lesbare Ansicht einer series-Zeile. */
function seriesView(db, s) {
  return {
    Titel: s.title,
    Kategorie: categoryName(db, s.category_id),
    Wochentag: WOCHENTAGE[s.weekday],
    Uhrzeit: `${s.time_from}–${s.time_to}`,
    Zeitraum: `${formatDate(s.date_from)}–${formatDate(s.date_to)}`,
    Beschreibung: s.description || '',
    Ort: s.location || '',
  };
}

/** Lesbare Ansicht einer categories-Zeile. */
function categoryView(c) {
  return {
    Name: c.name,
    Farbe: c.color_hex,
    Hintergrund: c.color_bg,
    Reihenfolge: c.sort_order,
    'Nach Titel aufschlüsseln': jaNein(c.group_by_title),
    'Nur mit Anmeldung': jaNein(c.login_required),
    'Eismeister-Kategorie': jaNein(c.eismeister_managed),
  };
}

/** Lesbare Ansicht einer users-Zeile — bewusst ohne password_hash. */
function userView(u) {
  return {
    Benutzername: u.username,
    Anzeigename: u.display_name,
    Rolle: u.role,
  };
}

module.exports = {
  logAudit,
  pruneAudit,
  diffFields,
  formatWhen,
  formatDate,
  eventView,
  seriesView,
  categoryView,
  userView,
};
