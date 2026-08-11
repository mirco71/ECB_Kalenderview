const express = require('express');
const { query, validationResult } = require('express-validator');
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { TEAMS, teamsFromTitle } = require('../teams');

const router = express.Router();

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

    for (const ev of events) {
      if (!categoryIds.includes(ev.category_id)) continue;

      const dauer = (new Date(ev.end_time) - new Date(ev.start_time)) / 60000; // Minuten

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
          // Aufschlüsselung nach Titel nur, wenn die Kategorie so konfiguriert ist
          titel: ev.group_by_title === 1 ? new Map() : null,
        });
      }

      const gruppe = gruppen.get(ev.category_id);
      gruppe.anzahl++;
      gruppe.dauerMinuten += dauer;

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
        dauerMinuten: g.dauerMinuten,
        titel: g.titel
          ? Array.from(g.titel.values()).sort((a, b) => a.titel.localeCompare(b.titel))
          : null,
      }));

    const antwort = {
      erfolg: true,
      zeitraum: { start, end },
      termineGesamt: events.length,
      gruppen: ergebnis,
      gesamt: { anzahl: gesamtAnzahl, dauerMinuten: gesamtDauer },
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
