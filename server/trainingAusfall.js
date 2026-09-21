const { teamsFromTitle } = require('./teams');
const { toLocalDateString, localDateTime } = require('./datetime');

/**
 * Training entfällt an Spieltagen.
 *
 * Hat eine Mannschaft an einem Kalendertag ein Spiel — Heim- oder
 * Auswärtsspiel, Uhrzeit egal —, findet ihr Training an diesem Tag nicht
 * statt. Bei gemeinsamen Trainings ("U13/15 Training") entfällt es nur für die
 * spielende Mannschaft; die übrigen trainieren weiter. Erst wenn alle
 * beteiligten Mannschaften spielen, ist die Halle frei.
 *
 * Bewusst beim Lesen berechnet statt beim Abgleich gelöscht: Spiele werden
 * laufend verlegt und abgesagt. Ein gelöschtes Training käme nach einer
 * Verlegung nicht zurück — ein berechnetes schon.
 *
 * Dieses Modul ist die einzige Stelle mit dieser Regel. Hallenansicht, Feeds
 * und Abrechnung nutzen es alle, damit sie nie unterschiedlich entscheiden.
 */

const TRAINING_PATTERN = /training/i;

/** Spiele stammen aus Hallenplanung und tragen deren UID — wie in feeds.js. */
function istSpiel(row) {
  return !!row.external_uid;
}

function istTraining(row) {
  return !istSpiel(row) && TRAINING_PATTERN.test(row.title || '');
}

// Untermannschaften (U11a, U11b) werden bewusst NICHT unterschieden:
// teamsFromTitle() fasst beide zu "U11" zusammen, und das ist hier richtig.
// Die U11a und die U11b trainieren nur gemeinsam — spielt eine von beiden,
// fällt das gemeinsame Training aus (so festgelegt am 2026-09-21).

/**
 * Bewertet die Trainings unter `rows`.
 *
 * Die Spiele werden eigens nachgeladen, nicht aus `rows` genommen: Die
 * Hallenansicht und die Abrechnung sehen nur Termine in der Halle
 * (in_hall = 1), ein Auswärtsspiel verdrängt das Training aber genauso.
 *
 * @param db Datenbank-Wrapper (getDb())
 * @param rows Termin-Zeilen mit mindestens title, start_time, external_uid
 * @returns {{ verbleibendeTeams(row): string[], entfaelltKomplett(row): boolean,
 *             entfallenFuer(row): string[] }}
 */
function bewerteTrainings(db, rows) {
  const trainings = rows.filter(istTraining);
  const spieltage = ladeSpieltage(db, trainings);

  const entfallenFuer = (row) => {
    if (!istTraining(row)) return [];
    const spielende = spieltage.get(toLocalDateString(new Date(row.start_time)));
    if (!spielende) return [];
    return teamsFromTitle(row.title).filter(team => spielende.has(team));
  };

  const verbleibendeTeams = (row) => {
    const entfallen = entfallenFuer(row);
    return teamsFromTitle(row.title).filter(t => !entfallen.includes(t));
  };

  // Ein Training ohne erkennbare Mannschaft entfällt nie — es gibt niemanden,
  // dessen Spiel es verdrängen könnte.
  const entfaelltKomplett = (row) => {
    if (!istTraining(row)) return false;
    const teams = teamsFromTitle(row.title);
    return teams.length > 0 && entfallenFuer(row).length === teams.length;
  };

  return { verbleibendeTeams, entfaelltKomplett, entfallenFuer };
}

/**
 * Lädt für die Kalendertage der Trainings, welche Mannschaften dort spielen.
 * Liefert Map "YYYY-MM-DD" (lokal) -> Set der Mannschaften.
 */
function ladeSpieltage(db, trainings) {
  const spieltage = new Map();
  if (trainings.length === 0) return spieltage;

  const tage = trainings.map(t => toLocalDateString(new Date(t.start_time))).sort();
  const von = localDateTime(tage[0], '00:00');
  const bis = localDateTime(tage[tage.length - 1], '00:00');
  bis.setDate(bis.getDate() + 1);

  const spiele = db
    .prepare(
      `SELECT title, start_time FROM events
       WHERE external_uid IS NOT NULL AND start_time >= ? AND start_time < ?`
    )
    .all(von.toISOString(), bis.toISOString());

  for (const spiel of spiele) {
    const tag = toLocalDateString(new Date(spiel.start_time));
    if (!spieltage.has(tag)) spieltage.set(tag, new Set());
    for (const team of teamsFromTitle(spiel.title)) spieltage.get(tag).add(team);
  }
  return spieltage;
}

module.exports = { bewerteTrainings, istSpiel, istTraining };
