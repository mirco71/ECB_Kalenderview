/**
 * Ableitung der Team-Zuordnung aus dem Termin-Titel.
 *
 * Ein Termin gehört zu keinem, einem oder mehreren Teams. Die Zuordnung wird
 * bewusst NICHT in einer eigenen Spalte gespeichert, sondern jedes Mal aus dem
 * Titel abgeleitet: Wird ein Training umbenannt (etwa weil U13/15 und U17/20
 * ihre Einheiten tauschen), wandert der Termin dadurch von selbst in die
 * richtigen Team-Feeds. Eine zweite Quelle könnte vom Titel abweichen — genau
 * das soll ausgeschlossen sein.
 *
 * Diese Funktion ist die einzige Stelle, die Titel auf Teams abbildet. Feeds
 * und Abrechnung nutzen sie beide, damit sie nie unterschiedlich zuordnen.
 */

/** Kanonische Kürzel in Anzeigereihenfolge (jüngste Jugend zuerst). */
const TEAMS = ['U7', 'U9', 'U11', 'U13', 'U15', 'U17', 'U20', 'Damen', 'Senioren', 'Goalies'];

/** Kürzel ohne führendes "U" — für die Auflösung von Kurzschreibweisen. */
const YOUTH_NUMBERS = new Set(
  TEAMS.filter(t => /^U\d+$/.test(t)).map(t => t.slice(1))
);

/** Nicht-Jugend-Teams, die als Wort im Titel stehen. */
const WORD_TEAMS = TEAMS.filter(t => !/^U\d+$/.test(t));

/**
 * Jugend-Kürzel samt Kurzschreibweise: "U13/15" oder "U17 / 20".
 *
 * Die erste Gruppe fängt die Zahl direkt hinter dem U, die zweite alle
 * folgenden "/Zahl"-Gruppen. Ohne diesen zweiten Teil würde "U13/15" nur als
 * U13 gelten und die U15-Eltern sähen den Termin nie — der Fehler, gegen den
 * dieses Modul überhaupt existiert.
 */
const YOUTH_PATTERN = /U\s*(\d{1,2})((?:\s*\/\s*\d{1,2})*)/gi;

/**
 * Leitet die Team-Zuordnung aus einem Titel ab.
 *
 * Unbekannte Kürzel werden verworfen: "U8" oder "U13/99" liefern nur die
 * Teams, die es wirklich gibt. Das verhindert, dass ein Vertipper einen Feed
 * mit einem Phantom-Team erzeugt.
 *
 * @param {string} title Termin-Titel, z.B. "U13/15 Training"
 * @returns {string[]} Kanonische Kürzel in TEAMS-Reihenfolge, ohne Duplikate
 */
function teamsFromTitle(title) {
  if (!title || typeof title !== 'string') return [];

  const found = new Set();

  // "U11A" und "U11B" stammen aus der Excel-Zeit und zählen beide als U11:
  // Der Buchstabe hinter der Zahl wird von YOUTH_PATTERN schlicht ignoriert.
  YOUTH_PATTERN.lastIndex = 0;
  let match;
  while ((match = YOUTH_PATTERN.exec(title)) !== null) {
    const numbers = [match[1], ...(match[2] ? match[2].split('/') : [])];
    for (const raw of numbers) {
      const n = raw.trim();
      if (n && YOUTH_NUMBERS.has(n)) found.add(`U${n}`);
    }
  }

  for (const team of WORD_TEAMS) {
    // Nur Anfangs-Wortgrenze, damit auch "Damentraining" zählt.
    if (new RegExp(`\\b${team}`, 'i').test(title)) found.add(team);
  }

  return TEAMS.filter(t => found.has(t));
}

/**
 * Prüft, ob ein Titel zu einem bestimmten Team gehört.
 *
 * @param {string} title
 * @param {string} team Kanonisches Kürzel, Groß-/Kleinschreibung egal
 */
function titleBelongsToTeam(title, team) {
  const canonical = TEAMS.find(t => t.toLowerCase() === String(team).toLowerCase());
  if (!canonical) return false;
  return teamsFromTitle(title).includes(canonical);
}

/**
 * Titel, wie er im Feed eines einzelnen Teams erscheinen soll.
 *
 * Ein gemeinsames Training steht in Kalenderview als EIN Termin "U13/15
 * Training" — die Halle war einmal belegt, die Abrechnung zählt einmal. In den
 * Kalendern der Eltern soll aber das eigene Team stehen: Der U13-Feed liefert
 * ihn als "U13 Training", der U15-Feed als "U15 Training".
 *
 * Umgeschrieben wird nur die kombinierte Kurzschreibweise. Titel mit einem
 * einzelnen Kürzel ("U17 Heimspiel gegen Ratingen") und Wort-Teams ("Damen
 * Training") bleiben unverändert.
 *
 * @param {string} title
 * @param {string} team Kanonisches Kürzel, Groß-/Kleinschreibung egal
 * @returns {string} Titel für diesen Feed; unverändert, wenn nichts zutrifft
 */
function titleForTeam(title, team) {
  if (!title || typeof title !== 'string') return title;
  const canonical = TEAMS.find(t => t.toLowerCase() === String(team).toLowerCase());
  // Wort-Teams (Damen, Senioren, Goalies) kennen keine Kurzschreibweise.
  if (!canonical || !/^U\d+$/.test(canonical)) return title;

  // Eigene Regex-Instanz: YOUTH_PATTERN ist global und führt lastIndex mit.
  const pattern = new RegExp(YOUTH_PATTERN.source, 'gi');
  return title.replace(pattern, (match, first, rest) => {
    const numbers = [first, ...(rest ? rest.split('/') : [])]
      .map(n => n.trim())
      .filter(n => n && YOUTH_NUMBERS.has(n))
      .map(n => `U${n}`);
    return numbers.includes(canonical) ? canonical : match;
  });
}

/**
 * Entfernt den Untermannschafts-Buchstaben eines Jugend-Teams aus dem Titel,
 * z.B. "U11a Training" -> "U11 Training". U11a und U11b sind organisatorisch
 * getrennt (zwei gemeldete Mannschaften für mehr Spielzeit), teilen sich aber
 * Training und Kalender; im Feed sollen sie deshalb schlicht als "U11"
 * erscheinen. Greift nur für Jugendteams (U<Zahl>) und nur auf den passenden
 * Jahrgang; Wort-Teams und andere Jahrgänge bleiben unberührt.
 *
 * @param {string} title
 * @param {string} team Kanonisches Kürzel, Groß-/Kleinschreibung egal
 */
function stripSubTeam(title, team) {
  if (!title || typeof title !== 'string') return title;
  const canonical = TEAMS.find(t => t.toLowerCase() === String(team).toLowerCase());
  if (!canonical || !/^U\d+$/.test(canonical)) return title;
  const num = canonical.slice(1);
  // Ein oder mehrere Buchstaben direkt hinter der Jahrgangszahl sind der
  // Untermannschafts-Zusatz ("U11a", "U11B"); eine reine "U11" ohne Buchstaben
  // bleibt unverändert.
  return title.replace(new RegExp(`U\\s*${num}[A-Za-z]+`, 'gi'), canonical);
}

module.exports = { TEAMS, teamsFromTitle, titleBelongsToTeam, titleForTeam, stripSubTeam };
