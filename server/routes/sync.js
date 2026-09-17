const express = require('express');
const crypto = require('crypto');
const { body, query, validationResult } = require('express-validator');
const { getDb } = require('../database');
const { requireSyncAuth } = require('../middleware/syncAuth');
const {
  localDateTime,
  toLocalDateString,
  generateSeriesDates,
  MAX_SERIES_EVENTS,
} = require('../datetime');

const router = express.Router();

const PAYLOAD_FORMAT = 'ecb-calendar';
const SUPPORTED_VERSION = 1;
const SOURCE = 'hallenplanung';

/**
 * Eigene Herkunft für Trainings. Bewusst verschieden von SOURCE: Der
 * Spiele-Abgleich löscht, was er nicht mehr kennt — Trainings gehören nach der
 * Übertragung aber Kalenderview und dürfen ihm nie in die Hände fallen.
 */
const SOURCE_TRAINING = 'hallenplanung-training';

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
 * Notbremse gegen einen Abgleich aus veraltetem Datenstand.
 *
 * Hallenplanung läuft auf mehreren Rechnern mit je eigener Datenbank. Wer
 * zuletzt veröffentlicht, gewinnt — ein Push aus einem alten Stand würde
 * Spiele löschen, die ein anderer Rechner angelegt hat. Deshalb bricht der
 * Abgleich ab, wenn er ungewöhnlich viel löschen würde.
 *
 * Beide Schwellen müssen überschritten sein: Ohne die absolute Untergrenze
 * schlüge die Bremse bei kleinen Beständen ständig an, ohne den Anteil bliebe
 * sie bei großen Saisons wirkungslos. Am Saisonende, wo viele Löschungen
 * richtig sind, bestätigt man einmal mit force=true.
 */
const LOESCH_GRENZE_ABSOLUT = 10;
const LOESCH_GRENZE_ANTEIL = 0.25;

function loeschBremseGreift(zuLoeschen, bestand) {
  return zuLoeschen > LOESCH_GRENZE_ABSOLUT && zuLoeschen > bestand * LOESCH_GRENZE_ANTEIL;
}

/** Hält fest, wer wann was abgeglichen hat — Grundlage der Status-Anzeige. */
function protokolliere(db, req, endpoint, zahlen) {
  db.prepare(
    `INSERT INTO sync_log (endpoint, token_id, token_label, user_id, angelegt, geaendert, geloescht)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    endpoint,
    req.syncToken ? req.syncToken.id : null,
    req.syncToken ? req.syncToken.label : null,
    req.user ? req.user.id : null,
    zahlen.angelegt, zahlen.geaendert, zahlen.geloescht
  );
}

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
  requireSyncAuth,
  [
    query('dry_run').optional().isBoolean().withMessage('dry_run muss boolesch sein'),
    query('force').optional().isBoolean().withMessage('force muss boolesch sein'),
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

    // Der Probelauf zeigt die Zahlen immer, er schreibt ja nichts. Nur der
    // echte Abgleich braucht die Bestätigung.
    const erzwingen = req.query.force === 'true' || req.query.force === '1';
    if (!probelauf && !erzwingen && loeschBremseGreift(zuLoeschen.length, vorhanden.length)) {
      return res.status(409).json({
        error:
          `Der Abgleich würde ${zuLoeschen.length} von ${vorhanden.length} Terminen löschen. ` +
          'Das deutet auf einen veralteten Datenstand hin. Stimmt die Zahl, den Abgleich mit ' +
          'force=true wiederholen.',
        bestaetigung_noetig: true,
        geloescht_geplant: zuLoeschen.length,
        bestand: vorhanden.length,
        details: { geloescht: zuLoeschen.slice(0, MAX_DETAILS).map(kurz) },
      });
    }

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

      protokolliere(db, req, 'calendar', {
        angelegt: anzulegen.length,
        geaendert: zuAendern.length,
        geloescht: zuLoeschen.length,
      });
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

// POST /api/sync/training[?dry_run=true]
//
// Einmalige Grundstock-Übertragung der Trainingszeiten: legt je Team und
// Wochentag eine Serie an. **Danach gehören die Trainings Kalenderview** — hier
// werden Einheiten abgesagt und verschoben, und keine spätere Veröffentlichung
// fasst sie wieder an.
//
// Genau deshalb bricht ein zweiter Aufruf ab, statt zu ersetzen: Er würde alle
// von Hand gepflegten Ausfälle und Verschiebungen vernichten — und die zu
// schützen ist der Zweck der ganzen Aufteilung. Kommt später ein Team dazu,
// wird dessen Serie von Hand in Kalenderview angelegt.
router.post(
  '/training',
  requireSyncAuth,
  [
    query('dry_run').optional().isBoolean().withMessage('dry_run muss boolesch sein'),
    body('format').equals(PAYLOAD_FORMAT).withMessage(`format muss "${PAYLOAD_FORMAT}" sein`),
    body('format_version').isInt().withMessage('format_version fehlt'),
    body('training').isArray().withMessage('training muss eine Liste sein'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const probelauf = req.query.dry_run === 'true' || req.query.dry_run === '1';
    const { format_version, training } = req.body;

    if (format_version !== SUPPORTED_VERSION) {
      return res.status(400).json({
        error: `format_version ${format_version} wird nicht unterstützt ` +
               `(erwartet: ${SUPPORTED_VERSION}). Bitte Hallenplanung aktualisieren.`,
      });
    }

    const db = getDb();

    const kategorieName = req.body.category || DEFAULT_CATEGORY;
    const kategorie = db.prepare('SELECT id FROM categories WHERE name = ?').get(kategorieName);
    if (!kategorie) {
      return res.status(400).json({
        error: `Kategorie "${kategorieName}" existiert nicht. Bitte in Kalenderview anlegen.`,
      });
    }

    // Schon übertragen? Dann nichts anfassen.
    const bestehende = db
      .prepare('SELECT title, date_from, date_to FROM series WHERE source = ? ORDER BY title')
      .all(SOURCE_TRAINING);
    if (bestehende.length > 0) {
      return res.status(409).json({
        error:
          `Es gibt bereits ${bestehende.length} übertragene Trainings-Serie(n). ` +
          'Der Grundstock wird nur einmal je Saison übertragen — sonst gingen alle ' +
          'in Kalenderview gepflegten Ausfälle und Verschiebungen verloren. ' +
          'Einzelne Serien bitte direkt in Kalenderview anlegen oder ändern.',
        vorhanden: bestehende.map(s => ({
          titel: s.title, von: s.date_from, bis: s.date_to,
        })),
      });
    }

    // Vorbereiten und prüfen, bevor irgendetwas geschrieben wird.
    const geplant = [];
    for (const t of training) {
      if (!t || !t.title) continue;

      const geschlossen = new Set(t.closures || []);
      const alle = generateSeriesDates(
        Number(t.weekday), t.date_from, t.date_to, t.time_from, t.time_to
      );
      // Hallenschließungen vor dem Anlegen aussortieren statt hinterher zu
      // löschen: So entsteht der Termin gar nicht erst und niemand sieht ihn
      // kurz im Kalender aufblitzen.
      const termine = alle.filter(o => !geschlossen.has(toLocalDateString(o.start)));

      if (termine.length === 0) continue;
      if (termine.length >= MAX_SERIES_EVENTS) {
        return res.status(400).json({
          error: `"${t.title}": Zeitraum zu lang — maximal ${MAX_SERIES_EVENTS} Termine pro Serie`,
        });
      }

      geplant.push({
        titel: t.title,
        weekday: Number(t.weekday),
        time_from: t.time_from,
        time_to: t.time_to,
        termine,
        entfallen: alle.length - termine.length,
      });
    }

    if (!probelauf) {
      for (const s of geplant) {
        const seriesId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO series (id, title, category_id, weekday, time_from, time_to,
                               date_from, date_to, description, location, source, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)`
        ).run(
          seriesId, s.titel, kategorie.id, s.weekday, s.time_from, s.time_to,
          toLocalDateString(s.termine[0].start),
          toLocalDateString(s.termine[s.termine.length - 1].start),
          SOURCE_TRAINING, req.user.id
        );

        for (const occ of s.termine) {
          db.prepare(
            `INSERT INTO events (title, start_time, end_time, category_id, all_day,
                                 description, location, series_id, source, in_hall, created_by)
             VALUES (?, ?, ?, ?, 0, '', '', ?, ?, 1, ?)`
          ).run(
            s.titel, occ.start.toISOString(), occ.end.toISOString(), kategorie.id,
            seriesId, SOURCE_TRAINING, req.user.id
          );
        }
      }

      protokolliere(db, req, 'training', {
        angelegt: geplant.reduce((n, s) => n + s.termine.length, 0),
        geaendert: 0,
        geloescht: 0,
      });
    }

    res.json({
      erfolg: true,
      probelauf,
      serien: geplant.length,
      termine: geplant.reduce((n, s) => n + s.termine.length, 0),
      wegenSchliessung: geplant.reduce((n, s) => n + s.entfallen, 0),
      details: geplant.map(s => ({
        titel: s.titel,
        anzahl: s.termine.length,
        von: toLocalDateString(s.termine[0].start),
        bis: toLocalDateString(s.termine[s.termine.length - 1].start),
        entfallen: s.entfallen,
      })),
    });
  }
);

// GET /api/sync/status — wer hat zuletzt abgeglichen und mit welchem Ergebnis.
//
// Hallenplanung zeigt das vor dem Veröffentlichen an. Läuft der letzte Abgleich
// von einem anderen Rechner und liegt er kurz zurück, ist der eigene Datenstand
// womöglich veraltet — genau die Information, die vor versehentlichem
// Überschreiben schützt.
router.get('/status', requireSyncAuth, (req, res) => {
  const letzter = getDb()
    .prepare(
      `SELECT l.ran_at, l.endpoint, l.token_label, l.angelegt, l.geaendert, l.geloescht,
              u.display_name AS benutzer
       FROM sync_log l
       LEFT JOIN users u ON l.user_id = u.id
       ORDER BY l.id DESC
       LIMIT 1`
    )
    .get();

  res.json({
    erfolg: true,
    letzterAbgleich: letzter
      ? {
          zeitpunkt: letzter.ran_at,
          endpunkt: letzter.endpoint,
          rechner: letzter.token_label,
          benutzer: letzter.benutzer,
          angelegt: letzter.angelegt,
          geaendert: letzter.geaendert,
          geloescht: letzter.geloescht,
        }
      : null,
  });
});

module.exports = router;
