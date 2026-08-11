// vitest globals are enabled (globals: true in vitest.config.js) — no import needed.
const { TEAMS, teamsFromTitle, titleBelongsToTeam } = require('../server/teams');

describe('teamsFromTitle', () => {
  it('erkennt ein einzelnes Jugend-Kürzel', () => {
    expect(teamsFromTitle('U17 Training')).toEqual(['U17']);
    expect(teamsFromTitle('U7 Training')).toEqual(['U7']);
  });

  it('löst die Kurzschreibweise kombinierter Teams auf', () => {
    // Der Kern des Moduls: "15" steht ohne führendes U. Ein reiner Wortabgleich
    // fände nur U13 und die U15-Eltern sähen den Termin nie.
    expect(teamsFromTitle('U13/15 Training')).toEqual(['U13', 'U15']);
    expect(teamsFromTitle('U17/20 Training')).toEqual(['U17', 'U20']);
  });

  it('verträgt Leerzeichen um den Schrägstrich', () => {
    expect(teamsFromTitle('U13 / 15 Training')).toEqual(['U13', 'U15']);
  });

  it('behandelt U11A und U11B als U11', () => {
    expect(teamsFromTitle('U11A Training')).toEqual(['U11']);
    expect(teamsFromTitle('U11B Training')).toEqual(['U11']);
  });

  it('erkennt die Wort-Teams', () => {
    expect(teamsFromTitle('Damen Training')).toEqual(['Damen']);
    expect(teamsFromTitle('Senioren Heimspiel gegen Ratingen')).toEqual(['Senioren']);
    expect(teamsFromTitle('Goalies Training')).toEqual(['Goalies']);
  });

  it('erkennt Wort-Teams auch in Zusammensetzungen', () => {
    expect(teamsFromTitle('Damentraining')).toEqual(['Damen']);
  });

  it('ignoriert Groß- und Kleinschreibung', () => {
    expect(teamsFromTitle('u17 training')).toEqual(['U17']);
    expect(teamsFromTitle('DAMEN TRAINING')).toEqual(['Damen']);
  });

  it('liefert nichts für fremde Termine', () => {
    expect(teamsFromTitle('Vermietung Firma Meyer')).toEqual([]);
    expect(teamsFromTitle('Öffentliche Laufzeit')).toEqual([]);
    expect(teamsFromTitle('STB Training')).toEqual([]);
  });

  it('verwirft unbekannte Kürzel', () => {
    // Ein Vertipper darf keinen Feed für ein Phantom-Team erzeugen.
    expect(teamsFromTitle('U8 Training')).toEqual([]);
    expect(teamsFromTitle('U13/99 Training')).toEqual(['U13']);
  });

  it('liefert eine stabile Reihenfolge unabhängig vom Titel', () => {
    expect(teamsFromTitle('U20/17 Training')).toEqual(['U17', 'U20']);
  });

  it('entfernt Duplikate', () => {
    expect(teamsFromTitle('U17 gegen U17 Ratingen')).toEqual(['U17']);
  });

  it('kommt mit leeren und ungültigen Eingaben klar', () => {
    expect(teamsFromTitle('')).toEqual([]);
    expect(teamsFromTitle(null)).toEqual([]);
    expect(teamsFromTitle(undefined)).toEqual([]);
    expect(teamsFromTitle(42)).toEqual([]);
  });

  it('erkennt Spieltitel aus Hallenplanung', () => {
    expect(teamsFromTitle('U17 Heimspiel gegen Ratingen')).toEqual(['U17']);
    expect(teamsFromTitle('U15 Auswärtsspiel in Neuss')).toEqual(['U15']);
    expect(teamsFromTitle('U13 Testspiel gegen Krefeld')).toEqual(['U13']);
    expect(teamsFromTitle('U20 PO-Blocker')).toEqual(['U20']);
  });

  it('deckt alle bekannten Teams ab', () => {
    for (const team of TEAMS) {
      expect(teamsFromTitle(`${team} Training`)).toContain(team);
    }
  });
});

describe('titleBelongsToTeam', () => {
  it('trifft bei kombinierten Trainings beide Teams', () => {
    expect(titleBelongsToTeam('U13/15 Training', 'U13')).toBe(true);
    expect(titleBelongsToTeam('U13/15 Training', 'U15')).toBe(true);
    expect(titleBelongsToTeam('U13/15 Training', 'U17')).toBe(false);
  });

  it('ignoriert Groß- und Kleinschreibung des Teamnamens', () => {
    expect(titleBelongsToTeam('Damen Training', 'damen')).toBe(true);
  });

  it('liefert false für unbekannte Teams', () => {
    expect(titleBelongsToTeam('U17 Training', 'U8')).toBe(false);
    expect(titleBelongsToTeam('U17 Training', '')).toBe(false);
  });
});
