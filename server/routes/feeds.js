const express = require('express');
const { getDb } = require('../database');
const config = require('../config');
const { TEAMS, titleForTeam, stripSubTeam } = require('../teams');
const { bewerteTrainings } = require('../trainingAusfall');

const router = express.Router();

/**
 * Öffentliche iCalendar-Feeds — pro Team und für die Halle.
 *
 * Bewusst ohne Bibliothek: iCalendar ist Zeilenformat, und die drei Regeln, auf
 * die es ankommt (Zeilenenden CRLF, Faltung bei 75 Byte, Escaping in
 * Textwerten), stehen unten als Hilfsfunktionen. Eine Abhängigkeit für hundert
 * Zeilen wäre nicht angemessen.
 *
 * Ohne Anmeldung erreichbar, wie die Kalenderansicht auch: Wer den Kalender
 * sehen darf, darf ihn auch abonnieren.
 */

const PRODID = '-//ECB//Kalenderview//DE';
const TZID = 'Europe/Berlin';

/** Wie weit die Feeds in die Vergangenheit reichen. */
const PAST_DAYS = 365;

/**
 * Aktualisierungs-Wunsch an die Kalender-App. Google ignoriert das und
 * entscheidet selbst (siehe Projektplan) — Apple und Outlook richten sich
 * danach.
 */
const REFRESH = 'PT1H';

// VTIMEZONE für Europe/Berlin. Ohne diesen Block müssten die Clients die
// Zeitzone raten; mit ihm liegen die Termine auch über den Sommer-/Winterzeit-
// Wechsel hinweg richtig.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  `TZID:${TZID}`,
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

// ---------------------------------------------------------------------------
// Formatierung nach RFC 5545
// ---------------------------------------------------------------------------

/** Escaping für Textwerte: Backslash, Semikolon, Komma, Zeilenumbruch. */
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Faltet eine Zeile auf 75 Oktette; Folgezeilen beginnen mit einem Leerzeichen.
 * Gezählt werden Bytes, nicht Zeichen — Umlaute belegen in UTF-8 zwei.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Nicht mitten in einem Mehrbyte-Zeichen trennen.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.slice(start, end).toString('utf8'));
    start = end;
    limit = 74; // Folgezeilen tragen ein führendes Leerzeichen mit.
  }
  return parts.join('\r\n ');
}

const pad = n => String(n).padStart(2, '0');

/** Lokale Wandzeit als YYYYMMDDTHHMMSS — passend zu TZID=Europe/Berlin. */
function localStamp(date) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Lokales Datum als YYYYMMDD — für ganztägige Termine. */
function localDate(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** UTC-Zeitstempel als YYYYMMDDTHHMMSSZ — für DTSTAMP und LAST-MODIFIED. */
function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Baut einen VEVENT-Block.
 *
 * @param row      Zeile aus events
 * @param summary  Titel für diesen Feed (im Team-Feed ggf. umgeschrieben)
 * @param stamp    DTSTAMP, für alle Termine eines Abrufs identisch
 */
function vevent(row, summary, stamp) {
  const start = new Date(row.start_time);
  const end = new Date(row.end_time);
  const lines = [
    'BEGIN:VEVENT',
    // Stabile UID: bei übernommenen Terminen der Fremdschlüssel aus
    // Hallenplanung, sonst die Datenbank-ID. So erkennen Abonnenten eine
    // Verschiebung als Änderung und nicht als neuen Termin.
    `UID:${row.external_uid || `kv-${row.id}`}@ecb-kalenderview`,
    `DTSTAMP:${stamp}`,
  ];

  if (row.all_day) {
    const endDay = new Date(end);
    lines.push(`DTSTART;VALUE=DATE:${localDate(start)}`);
    lines.push(`DTEND;VALUE=DATE:${localDate(endDay)}`);
  } else {
    lines.push(`DTSTART;TZID=${TZID}:${localStamp(start)}`);
    lines.push(`DTEND;TZID=${TZID}:${localStamp(end)}`);
  }

  lines.push(`SUMMARY:${escapeText(summary)}`);
  if (row.location) lines.push(`LOCATION:${escapeText(row.location)}`);
  if (row.description) lines.push(`DESCRIPTION:${escapeText(row.description)}`);
  if (row.updated_at) {
    const modified = new Date(`${row.updated_at.replace(' ', 'T')}Z`);
    if (!Number.isNaN(modified.getTime())) {
      lines.push(`LAST-MODIFIED:${utcStamp(modified)}`);
    }
  }
  lines.push('END:VEVENT');
  return lines;
}

/** Setzt den vollständigen Kalender zusammen. */
function buildCalendar(name, rows, summaryFor) {
  const stamp = utcStamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-TIMEZONE:${TZID}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${REFRESH}`,
    `X-PUBLISHED-TTL:${REFRESH}`,
    ...VTIMEZONE,
  ];
  for (const row of rows) {
    lines.push(...vevent(row, summaryFor(row), stamp));
  }
  lines.push('END:VCALENDAR');

  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------

function loadEvents() {
  const von = new Date();
  von.setDate(von.getDate() - PAST_DAYS);
  // Termine anmeldepflichtiger Kategorien (Eismeister-Dienstzeiten) bleiben
  // grundsätzlich draußen: Feeds werden von Kalender-Apps ohne Anmeldung
  // abgerufen, wer die URL kennt, käme sonst an interne Daten.
  return getDb()
    .prepare(
      `SELECT e.id, e.title, e.start_time, e.end_time, e.all_day, e.location,
              e.description, e.external_uid, e.in_hall, e.updated_at
       FROM events e
       JOIN categories c ON e.category_id = c.id
       WHERE e.start_time >= ? AND c.login_required = 0
       ORDER BY e.start_time ASC`
    )
    .all(von.toISOString());
}

function sendCalendar(res, filename, body) {
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `inline; filename="${filename}"`);
  // Kurzer Cache: Der Feed wird von vielen Geräten regelmäßig abgerufen, soll
  // aber nach einer Absage nicht lange veraltet ausgeliefert werden.
  res.set('Cache-Control', 'public, max-age=300');
  res.send(body);
}

// GET /feeds/halle.ics — alles, was die Halle belegt
router.get('/halle.ics', (req, res) => {
  const alle = loadEvents();
  // Ein Training, das wegen Spielen aller beteiligten Mannschaften entfällt,
  // belegt die Halle nicht — siehe server/trainingAusfall.js.
  const ausfall = bewerteTrainings(getDb(), alle);
  const rows = alle.filter(e => e.in_hall === 1 && !ausfall.entfaelltKomplett(e));
  sendCalendar(
    res,
    'halle.ics',
    buildCalendar(config.calendarName, rows, row => row.title)
  );
});

/**
 * Bereitet die Termine eines Team-Feeds auf.
 *
 * Spiele bleiben unverändert (sie tragen eine stabile Hallenplanungs-UID in
 * external_uid und sind echte, getrennte Spiele — U11a und U11b spielen für
 * sich). Trainings verlieren den Untermannschafts-Buchstaben, damit a/b-Teams
 * unter einem Team erscheinen ("U11a Training" -> "U11 Training"). Trainieren
 * U11a und U11b zusammen, liefert Hallenplanung zwei gleichzeitige Trainings;
 * nach dem Umschreiben sind sie identisch und werden zu einem Eintrag
 * zusammengefasst, sonst stünde er doppelt im Kalender.
 *
 * Sortiert nach Startzeit und ID, damit bei einem Doppel-Training stabil
 * derselbe Termin (die kleinere ID) übrig bleibt — sonst würde der Abgleich
 * ihn bei jedem Lauf löschen und neu anlegen.
 */
function fasseTeamTrainingsZusammen(rows, team) {
  const sortiert = rows
    .slice()
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)) || a.id - b.id);

  const gesehen = new Set();
  const zeilen = [];
  for (const row of sortiert) {
    const istSpiel = !!row.external_uid;
    let titel = titleForTeam(row.title, team);
    if (!istSpiel) {
      titel = stripSubTeam(titel, team);
      const schluessel = `${titel}|${row.start_time}|${row.end_time}`;
      if (gesehen.has(schluessel)) continue;
      gesehen.add(schluessel);
    }
    zeilen.push({ ...row, _feedTitel: titel });
  }
  return { zeilen, titelFuer: row => row._feedTitel };
}

// GET /feeds/<Team>.ics — alle Termine eines Teams, auch Auswärtsspiele
router.get('/:name.ics', (req, res) => {
  const team = TEAMS.find(t => t.toLowerCase() === req.params.name.toLowerCase());
  if (!team) {
    return res.status(404).json({
      error: `Unbekannter Feed "${req.params.name}". Verfügbar: ${TEAMS.join(', ')}, halle.`,
    });
  }

  // Auswärtsspiele gehören ausdrücklich dazu: Sie belegen die Halle nicht,
  // sind für die Eltern aber genauso Termine wie ein Heimspiel.
  // Trainings zählen nur für die Mannschaften, die an dem Tag nicht spielen —
  // die Bridge überträgt diesen Feed in die Google-Kalender der Eltern.
  const alle = loadEvents();
  const ausfall = bewerteTrainings(getDb(), alle);
  const rows = alle.filter(e => ausfall.verbleibendeTeams(e).includes(team));

  const { zeilen, titelFuer } = fasseTeamTrainingsZusammen(rows, team);

  sendCalendar(
    res,
    `${team.toLowerCase()}.ics`,
    // Ein gemeinsames Training heißt in Kalenderview "U13/15 Training", im
    // U13-Feed aber "U13 Training". Untermannschaften wie U11a/U11b laufen als
    // "U11", gleichzeitige Doppel-Trainings werden zusammengefasst.
    buildCalendar(`ECB ${team}`, zeilen, titelFuer)
  );
});

// GET /feeds — Übersicht der verfügbaren Feeds, damit man die URLs findet
router.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}/feeds`;
  res.json({
    erfolg: true,
    feeds: [
      { name: 'Halle', url: `${base}/halle.ics` },
      ...TEAMS.map(t => ({ name: `ECB ${t}`, url: `${base}/${t.toLowerCase()}.ics` })),
    ],
  });
});

module.exports = router;
