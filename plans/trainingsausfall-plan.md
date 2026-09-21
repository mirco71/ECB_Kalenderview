# Plan: Training entfällt an Spieltagen

## Problem

Hat eine Mannschaft an einem Tag ein Spiel, findet ihr Training an diesem Tag
nicht statt — egal ob Heim- oder Auswärtsspiel. Bisher stehen Training und Spiel
beide in Kalender, Feeds und Abrechnung.

## Entscheidungen (mit dem Nutzer abgestimmt, 2026-09-21)

- **Gemeinsame Trainings** („U13/15 Training"): Das Training entfällt nur für die
  spielende Mannschaft. Die übrigen trainieren weiter.
- **Halle frei, wenn alle spielen**: Entfällt das Training für alle beteiligten
  Mannschaften, verschwindet es aus Hallenansicht, Hallen-Feed und Abrechnung.
- **Ganzer Kalendertag**: Jedes Spiel am selben lokalen Datum zählt, unabhängig von
  der Uhrzeit.
- **Untermannschaften nicht unterscheiden**: U11a und U11b trainieren nur gemeinsam.
  Spielt eine von beiden, fällt das gemeinsame Training aus.
- **Bridge**: Entfallene Trainings dürfen nicht in die Google-Kalender. Geprüft: Die
  Bridge liest die Team-Feeds und löscht dort Fehlendes — keine Änderung an der
  Bridge nötig.

## Ansatz: beim Lesen berechnen, nicht löschen

Die Trainings sind als Serien bereits übertragen und gehören Kalenderview. Spiele
kommen laufend neu, werden verlegt oder abgesagt. Würde man Trainings beim
Abgleich löschen, käme ein Training nach einer Spielverlegung nicht zurück. Daher
bleibt das Training gespeichert; ob es stattfindet, wird bei jedem Lesen aus den
Spielen desselben Tages bestimmt.

Begriffe (eine Stelle: `server/trainingAusfall.js`):
- **Spiel**: Termin mit `external_uid` (aus Hallenplanung) — dieselbe Definition wie
  bisher in `feeds.js`. Auswärtsspiele (`in_hall = 0`) zählen mit.
- **Training**: kein Spiel, Titel enthält „Training".
- Mannschaften wie überall über `teamsFromTitle()` aus `server/teams.js`.

## Änderungen pro Datei

- `server/trainingAusfall.js` (neu): lädt die Spieltage für die Daten der
  betrachteten Trainings (inklusive Auswärtsspielen), liefert je Training die
  verbleibenden Mannschaften und ob es komplett entfällt
- `server/routes/events.js`, `GET /api/events`: Hallenansicht (ohne
  `include_extern`) blendet komplett entfallene Trainings aus; die Admin-Liste
  (`include_extern=1`) behält sie und bekommt ein Kennzeichen
- `loadSeries` (Serienansicht im Admin): Kennzeichen je Termin
- `server/routes/feeds.js`: Hallen-Feed ohne komplett entfallene Trainings;
  Team-Feed ohne Trainings, die für diese Mannschaft entfallen
- `server/routes/stats.js`: komplett entfallene Trainings nicht abrechnen; bei
  Aufschlüsselung nach Team nur die verbleibenden Mannschaften zählen
- `public/js/admin.js`: Hinweis „entfällt (Spiel)" in Terminliste und Serienansicht
- Die Bridge liest die Team-Feeds und folgt damit ohne Änderung

## Reihenfolge

1. Hilfsmodul + Tests
2. Anbindung in events, feeds, stats + Tests
3. Hinweis im Admin
4. Doku (`Docs/API.md`, `CLAUDE.md`)
