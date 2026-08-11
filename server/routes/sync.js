const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { localDateTime } = require('../datetime');

const router = express.Router();

const PAYLOAD_FORMAT = 'ecb-calendar';
const SUPPORTED_VERSION = 1;
const SOURCE = 'hallenplanung';

/** Standard-Kategorie für übernommene Spiele, per Name aufgelöst. */
const DEFAULT_CATEGORY = 'ECB';

/** Höchstens so viele Einzelposten je Rubrik zurückgeben. */
const MAX_DETAILS = 50;

/**
 * Blocker reservieren zwar Eiszeit, haben aber noch keinen Gegner. Sie reisen in
 * der Nutzlast mit, damit Hallenplanung nicht entscheiden muss, wer sie braucht —
 * hier werden sie verworfen.
 */
const IGNORIERTE_ARTEN = new Set(['blocker']);

/**
 * Baut aus einem Nutzlast-Termin die Spalten einer events-Zeile.
 *
 * Die Nutzlast liefert lokale Wandzeit plus Zeitzonen-Angabe; gespeichert wird
 * absolut in UTC. Die Umrechnung übernimmt localDateTime() aus datetime.js, das
 * bewusst den Date(y,m,d,h,min)-Konstruktor nutzt — ein ISO-String würde als UTC
 * gelesen und die Termine um den Offset verschieben.
 *
 * Ganztägige Termine (Auswärtsspiel mit bekanntem Datum, aber ohne Anwurfzeit)
 * bekommen Mitternacht bis Mitternacht des Folgetags.
 */
function zeileAus(ev, categoryId) {
  const ganztags = ev.all_day === true;

  let start, ende;
  if (ganztags) {
    start = localDateTime(ev.date, '00:00');
    ende = localDateTime(ev.date, '00:00');
    ende.setDate(ende.getDate() + 1);
  } else {
    start = localDateTime(ev.date, ev.start);
    ende = localDateTime(ev.date, ev.end);
    // Ein Spiel, das über Mitternacht läuft, endet am Folgetag.
    if (ende <= start) ende.setDate(ende.getDate() + 1);
  }

  return {
    external_uid: ev.uid,
    title: ev.title,
    start_time: start.toISOString(),
    end_time: ende.toISOString(),
    category_id: categoryId,
    all_day: ganztags ? 1 : 0,
    location: ev.location || '',
    in_hall: ev.occupies_hall === false ? 0 : 1,
  };
}

/** Felder, deren Abweichung eine Aktualisierung auslöst. */
const VERGLEICHSFELDER = [
  'title', 'start_time', 'end_time', 'category_id', 'all_day', 'location', 'in_hall',
];

function hatSichGeaendert(vorhanden, gewuenscht) {
  return VERGLEICHSFELDER.some(f => String(vorhanden[f] ?? '') !== String(gewuenscht[f] ?? ''));
}

function kurz(zeile) {
  return { titel: zeile.title, start: zeile.start_time };
}

// POST /api/sync/calendar[?dry_run=true]
//
// Gleicht die Spiele aus Hallenplanung gegen den Bestand ab: neue anlegen,
// geänderte aktualisieren, im Zeitraum fehlende löschen.
//
// Angefasst werden ausschließlich Zeilen mit source = 'hallenplanung' innerhalb
// des mitgelieferten Zeitraums. Von Hand angelegte Termine — STB, Vermietung,
// öffentliche Laufzeit, Hobbies — und die Trainings-Serien bleiben unberührt.
// Das ist die Eigenschaft, auf der der ganze Entwurf ruht.
//
// dry_run=true rechnet denselben Abgleich durch, schreibt aber nichts. Damit ist
// die Vorschau in Hallenplanung derselbe Endpunkt in einem anderen Modus — es
// gibt keine zweite Codepfad-Variante, die auseinanderlaufen könnte.
router.post(
  '/calendar',
  requireAuth,
  [
    query('dry_run').optional().isBoolean().withMessage('dry_run muss boolesch sein'),
    body('format').equals(PAYLOAD_FORMAT).withMessage(`format muss "${PAYLOAD_FORMAT}" sein`),
    body('format_version').isInt().withMessage('format_version fehlt'),
    body('season.date_from').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('season.date_from fehlt'),
    body('season.date_to').matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('season.date_to fehlt'),
    body('events').isArray().withMessage('events muss eine Liste sein'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const probelauf = req.query.dry_run === 'true' || req.query.dry_run === '1';
    const { format_version, season, events } = req.body;

    if (format_version !== SUPPORTED_VERSION) {
      return res.status(400).json({
        error: `format_version ${format_version} wird nicht unterstützt ` +
               `(erwartet: ${SUPPORTED_VERSION}). Bitte Hallenplanung aktualisieren.`,
      });
    }
    if (season.date_to < season.date_from) {
      return res.status(400).json({ error: 'season.date_to liegt vor season.date_from' });
    }

    const db = getDb();

    const kategorieName = req.body.category || DEFAULT_CATEGORY;
    const kategorie = db
      .prepare('SELECT id FROM categories WHERE name = ?')
      .get(kategorieName);
    if (!kategorie) {
      return res.status(400).json({
        error: `Kategorie "${kategorieName}" existiert nicht. Bitte in Kalenderview anlegen.`,
      });
    }

    // Gewünschter Zustand aus der Nutzlast
    const gewuenscht = new Map();
    for (const ev of events) {
      if (!ev || !ev.uid || IGNORIERTE_ARTEN.has(ev.kind)) continue;
      if (gewuenscht.has(ev.uid)) {
        return res.status(400).json({ error: `Doppelte uid in der Nutzlast: ${ev.uid}` });
      }
      gewuenscht.set(ev.uid, zeileAus(ev, kategorie.id));
    }

    // Bestand im Zeitraum. Bewusst über start_time eingegrenzt und nicht über
    // Überlappung: Ein Termin, der in den Zeitraum hineinragt, aber davor
    // beginnt, gehört zur vorherigen Lieferung und darf nicht gelöscht werden.
    const bereichVon = localDateTime(season.date_from, '00:00').toISOString();
    const bereichBis = localDateTime(season.date_to, '00:00');
    bereichBis.setDate(bereichBis.getDate() + 1);

    const vorhanden = db
      .prepare(
        `SELECT id, external_uid, title, start_time, end_time, category_id,
                all_day, location, in_hall
         FROM events
         WHERE source = ? AND external_uid IS NOT NULL
           AND start_time >= ? AND start_time < ?`
      )
      .all(SOURCE, bereichVon, bereichBis.toISOString());

    const vorhandenNachUid = new Map(vorhanden.map(z => [z.external_uid, z]));

    const anzulegen = [];
    const zuAendern = [];
    let unveraendert = 0;

    for (const [uid, zeile] of gewuenscht) {
      const alt = vorhandenNachUid.get(uid);
      if (!alt) anzulegen.push(zeile);
      else if (hatSichGeaendert(alt, zeile)) zuAendern.push({ id: alt.id, ...zeile });
      else unveraendert++;
    }

    const zuLoeschen = vorhanden.filter(z => !gewuenscht.has(z.external_uid));

    if (!probelauf) {
      // Hinweis: Der sql.js-Wrapper schreibt die komplette Datei nach jedem
      // Schreibbefehl zurück (siehe Docs/DATABASE.md). Bei einer ganzen Saison
      // sind das einige hundert Durchläufe — vertretbar, weil ein Abgleich
      // selten läuft, aber kein Muster für häufige Schreibpfade.
      for (const z of anzulegen) {
        db.prepare(
          `INSERT INTO events (title, start_time, end_time, category_id, all_day,
                               location, external_uid, source, in_hall, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          z.title, z.start_time, z.end_time, z.category_id, z.all_day,
          z.location, z.external_uid, SOURCE, z.in_hall, req.user.id
        );
      }
      for (const z of zuAendern) {
        db.prepare(
          `UPDATE events
           SET title = ?, start_time = ?, end_time = ?, category_id = ?, all_day = ?,
               location = ?, in_hall = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(
          z.title, z.start_time, z.end_time, z.category_id, z.all_day,
          z.location, z.in_hall, z.id
        );
      }
      for (const z of zuLoeschen) {
        db.prepare('DELETE FROM events WHERE id = ?').run(z.id);
      }
    }

    res.json({
      erfolg: true,
      probelauf,
      zeitraum: { von: season.date_from, bis: season.date_to },
      angelegt: anzulegen.length,
      geaendert: zuAendern.length,
      geloescht: zuLoeschen.length,
      unveraendert,
      details: {
        angelegt: anzulegen.slice(0, MAX_DETAILS).map(kurz),
        geaendert: zuAendern.slice(0, MAX_DETAILS).map(kurz),
        geloescht: zuLoeschen.slice(0, MAX_DETAILS).map(kurz),
      },
    });
  }
);

module.exports = router;
