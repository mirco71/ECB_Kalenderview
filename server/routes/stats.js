const express = require('express');
const { query, validationResult } = require('express-validator');
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/stats?start=ISO&end=ISO&category_ids=2,5,7,8,11
// Abrechnungs-Auswertung: Anzahl und Gesamtdauer der Termine je Kategorie im
// Zeitraum. Nur für angemeldete Benutzer — Abrechnungsdaten sind intern.
router.get(
  '/',
  requireAuth,
  [
    query('start').isISO8601().withMessage('Ungültiges Startdatum'),
    query('end').isISO8601().withMessage('Ungültiges Enddatum'),
    query('category_ids')
      .matches(/^\d+(,\d+)*$/)
      .withMessage('category_ids muss eine Komma-Liste von IDs sein (z.B. 2,5,7)'),
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
    const db = getDb();

    // Alle Termine, die den Zeitraum überlappen (gleiche Semantik wie /api/events)
    const events = db
      .prepare(
        `SELECT e.title, e.start_time, e.end_time, e.category_id,
                c.name AS category_name, c.color_hex AS category_color,
                c.group_by_title AS group_by_title
         FROM events e
         JOIN categories c ON e.category_id = c.id
         WHERE e.start_time < ? AND e.end_time > ?
         ORDER BY e.start_time ASC`
      )
      .all(end, start);

    const gruppen = new Map();
    let gesamtAnzahl = 0;
    let gesamtDauer = 0;

    for (const ev of events) {
      if (!categoryIds.includes(ev.category_id)) continue;

      const dauer = (new Date(ev.end_time) - new Date(ev.start_time)) / 60000; // Minuten

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

    res.json({
      erfolg: true,
      zeitraum: { start, end },
      termineGesamt: events.length,
      gruppen: ergebnis,
      gesamt: { anzahl: gesamtAnzahl, dauerMinuten: gesamtDauer },
    });
  }
);

module.exports = router;
