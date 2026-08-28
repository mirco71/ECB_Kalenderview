const express = require('express');
const { query, validationResult } = require('express-validator');
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { TEAMS, teamsFromTitle } = require('../teams');

const router = express.Router();

/** Höchstens so viele Einzelfälle zurückgeben — der Rest wäre nur Rauschen. */
const MAX_UEBERSCHNEIDUNGEN = 20;

/**
 * Findet zeitliche Überschneidungen unter den gezählten Terminen.
 *
 * Zwei Termine, die gleichzeitig auf demselben Eis liegen, sind für die
 * abgerechnete Zeit unschädlich — die zählt jede belegte Minute nur einmal
 * (siehe belegteMinuten). Die Liste bleibt trotzdem wichtig: Sie zeigt, welche
 * Einheiten parallel laufen, etwa gemeinsame Trainings mehrerer Mannschaften.
 *
 * Erkannt wird über alle ausgewählten Kategorien hinweg, denn für die Frage
 * "ist diese Summe belastbar" ist es gleich, ob sich zwei ECB-Trainings oder
 * ein Training und eine Vermietung überlagern.
 *
 * Termine, die sich nur berühren (einer endet 18:00, der nächste beginnt
 * 18:00), sind keine Überschneidung.
 *
 * @param {Array} events nach start_time aufsteigend sortiert
 */
function findeUeberschneidungen(events) {
  const faelle = [];
  let minutenGesamt = 0;
  let anzahl = 0;

  for (let i = 0; i < events.length; i++) {
    const a = events[i];
    const aStart = new Date(a.start_time);
    const aEnde = new Date(a.end_time);

    for (let j = i + 1; j < events.length; j++) {
      const b = events[j];
      const bStart = new Date(b.start_time);
      // Sortiert nach Start: ab hier beginnt nichts mehr vor dem Ende von a.
      if (bStart >= aEnde) break;

      const bEnde = new Date(b.end_time);
      const ueberlappung = (Math.min(aEnde, bEnde) - Math.max(aStart, bStart)) / 60000;
      if (ueberlappung <= 0) continue;

      anzahl++;
      minutenGesamt += ueberlappung;
      if (faelle.length < MAX_UEBERSCHNEIDUNGEN) {
        faelle.push({
          datum: a.start_time.slice(0, 10),
          titelA: a.title,
          titelB: b.title,
          minuten: ueberlappung,
        });
      }
    }
  }

  return {
    anzahl,
    minuten: minutenGesamt,
    faelle,
    weitere: Math.max(0, anzahl - faelle.length),
    text: anzahl
      ? `${anzahl} Überschneidung(en) mit zusammen ${minutenGesamt} Minuten. ` +
        'Die belegte Hallenzeit zählt diese Zeit nur einmal. Häufigste Ursache: ' +
        'parallele Trainings, etwa gemeinsame Einheiten mehrerer Mannschaften.'
      : null,
  };
}

/**
 * Summiert die tatsaechlich belegte Zeit einer Terminmenge in Minuten.
 *
 * Gleichzeitige Termine zaehlen nur einmal: Die Zeitintervalle werden
 * vereinigt, bevor summiert wird. Das ist die Zahl, um die es bei der
 * Abrechnung geht, denn die Halle ist einmal belegt, egal wie viele
 * Mannschaften gleichzeitig auf dem Eis stehen. U11a und U11b trainieren
 * zusammen, U13 und U15 ebenso; ohne Vereinigung waere die ausgewiesene
 * Stundenzahl zu hoch.
 *
 * Termine, die sich nur beruehren (einer endet 18:00, der naechste beginnt
 * 18:00), ergeben zwei getrennte Bloecke und zaehlen beide voll.
 */
function belegteMinuten(events) {
  const intervalle = events
    .map(e => [new Date(e.start_time).getTime(), new Date(e.end_time).getTime()])
    .filter(([von, bis]) => bis > von)
    .sort((a, b) => a[0] - b[0]);

  let summe = 0;
  let von = null;
  let bis = null;
  for (const [start, ende] of intervalle) {
    if (von === null) { von = start; bis = ende; continue; }
    if (start <= bis) { bis = Math.max(bis, ende); continue; }
    summe += bis - von;
    von = start;
    bis = ende;
  }
  if (von !== null) summe += bis - von;
  return summe / 60000;
}

// GET /api/stats?start=ISO&end=ISO&category_ids=2,5,7,8,11[&group_by_team=1]
// Abrechnungs-Auswertung: Anzahl und Gesamtdauer der Termine je Kategorie im
// Zeitraum. Nur für angemeldete Benutzer — Abrechnungsdaten sind intern.
//
// Gezählt wird ausschließlich, was die Halle tatsächlich belegt (in_hall = 1).
// Auswärtsspiele stehen zwar in der Datenbank, damit sie in den Team-Feeds
// erscheinen, finden aber in fremden Hallen statt. Ohne diesen Filter wären die
// ausgewiesenen ECB-Stunden zu hoch — und zwar unauffällig, weil das Ergebnis
// plausibel aussähe.
router.get(
  '/',
  requireAuth,
  [
    query('start').isISO8601().withMessage('Ungültiges Startdatum'),
    query('end').isISO8601().withMessage('Ungültiges Enddatum'),
    query('category_ids')
      .matches(/^\d+(,\d+)*$/)
      .withMessage('category_ids muss eine Komma-Liste von IDs sein (z.B. 2,5,7)'),
    query('group_by_team').optional().isBoolean().withMessage('group_by_team muss boolesch sein'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { start, end } = req.query;
    if (new Date(end) <= new Date(start)) {
      return res.status(400).json({ error: 'Enddatum muss nach Startdatum liegen' });
    }

    const categoryIds = req.query.category_ids.split(',').map(Number);
    const groupByTeam = req.query.group_by_team === 'true' || req.query.group_by_team === '1';
    const db = getDb();

    // Alle Termine, die den Zeitraum überlappen (gleiche Semantik wie /api/events)
    // und die Halle belegen — siehe Kommentar am Routen-Kopf.
    const events = db
      .prepare(
        `SELECT e.title, e.start_time, e.end_time, e.category_id,
                c.name AS category_name, c.color_hex AS category_color,
                c.group_by_title AS group_by_title
         FROM events e
         JOIN categories c ON e.category_id = c.id
         WHERE e.start_time < ? AND e.end_time > ? AND e.in_hall = 1
         ORDER BY e.start_time ASC`
      )
      .all(end, start);

    const gruppen = new Map();
    const teamGruppen = new Map();
    let gesamtAnzahl = 0;
    let gesamtDauer = 0;
    let mehrfachZugeordnet = 0;

    const gezaehlt = [];

    for (const ev of events) {
      if (!categoryIds.includes(ev.category_id)) continue;

      const dauer = (new Date(ev.end_time) - new Date(ev.start_time)) / 60000; // Minuten
      gezaehlt.push(ev);

      if (groupByTeam) {
        const teams = teamsFromTitle(ev.title);
        if (teams.length > 1) mehrfachZugeordnet++;
        for (const team of teams) {
          if (!teamGruppen.has(team)) {
            teamGruppen.set(team, { team, anzahl: 0, dauerMinuten: 0 });
          }
          const t = teamGruppen.get(team);
          t.anzahl++;
          t.dauerMinuten += dauer;
        }
      }

      if (!gruppen.has(ev.category_id)) {
        gruppen.set(ev.category_id, {
          category_id: ev.category_id,
          name: ev.category_name,
          color_hex: ev.category_color,
          anzahl: 0,
          dauerMinuten: 0,
          // Fuer die Netto-Belegung: die Termine der Kategorie selbst.
          termine: [],
          // Aufschlüsselung nach Titel nur, wenn die Kategorie so konfiguriert ist
          titel: ev.group_by_title === 1 ? new Map() : null,
        });
      }

      const gruppe = gruppen.get(ev.category_id);
      gruppe.anzahl++;
      gruppe.dauerMinuten += dauer;
      gruppe.termine.push(ev);

      if (gruppe.titel) {
        if (!gruppe.titel.has(ev.title)) {
          gruppe.titel.set(ev.title, { titel: ev.title, anzahl: 0, dauerMinuten: 0 });
        }
        const t = gruppe.titel.get(ev.title);
        t.anzahl++;
        t.dauerMinuten += dauer;
      }

      gesamtAnzahl++;
      gesamtDauer += dauer;
    }

    // Ergebnis in Seed-Reihenfolge der Kategorien, Titel alphabetisch
    const ergebnis = Array.from(gruppen.values())
      .sort((a, b) => a.category_id - b.category_id)
      .map(g => ({
        category_id: g.category_id,
        name: g.name,
        color_hex: g.color_hex,
        anzahl: g.anzahl,
        // Abgerechnet wird die belegte Zeit: gleichzeitige Termine derselben
        // Kategorie zaehlen einmal. Die Bruttosumme bleibt daneben stehen,
        // damit die Aufschluesselung je Einheit nachvollziehbar bleibt.
        dauerMinuten: belegteMinuten(g.termine),
        dauerBruttoMinuten: g.dauerMinuten,
        titel: g.titel
          ? Array.from(g.titel.values()).sort((a, b) => a.titel.localeCompare(b.titel))
          : null,
      }));

    // Gesamt = Summe der Kategorie-Nettos, damit sich die Tabelle aufaddiert.
    // Bewusst nicht die Vereinigung ueber alle Kategorien hinweg: Jede
    // Kategorie wird fuer sich abgerechnet, und eine Ueberschneidung zwischen
    // zwei Kategorien waere eine Doppelbuchung, die nicht stillschweigend
    // verschwinden darf.
    const gesamtNetto = ergebnis.reduce((n, g) => n + g.dauerMinuten, 0);

    const antwort = {
      erfolg: true,
      zeitraum: { start, end },
      termineGesamt: events.length,
      gruppen: ergebnis,
      gesamt: {
        anzahl: gesamtAnzahl,
        dauerMinuten: gesamtNetto,
        dauerBruttoMinuten: gesamtDauer,
      },
      ueberschneidungen: findeUeberschneidungen(gezaehlt),
    };

    if (groupByTeam) {
      // Ein kombiniertes Training ("U13/15") belegt die Halle einmal, zählt in
      // der Team-Aufschlüsselung aber unter beiden Teams. Die Summe der
      // Team-Zeilen ist deshalb größer als gesamt.dauerMinuten — das muss die
      // Anzeige kenntlich machen, sonst wirkt die Auswertung fehlerhaft.
      antwort.teams = TEAMS.filter(t => teamGruppen.has(t)).map(t => teamGruppen.get(t));
      antwort.teamsHinweis = {
        mehrfachZugeordnet,
        text:
          'Termine mehrerer Teams (z.B. "U13/15") zählen in jeder Team-Zeile mit. ' +
          'Die Summe der Team-Zeilen kann deshalb größer sein als die Gesamtdauer.',
      };
    }

    res.json(antwort);
  }
);

module.exports = router;
