/**
 * Google Kalender Viewer - Wochenansicht mit Zeitraster (lesend)
 * 
 * ANLEITUNG:
 * 1. Apps Script erstellen (script.google.com)
 * 2. Diesen Code einfügen
 * 3. KALENDER_ID unten anpassen
 * 4. Als Web-App bereitstellen
 */

// ============ KONFIGURATION ============

const KALENDER_ID = "eisbelegung@eissporthalle-solingen.de"; // Deine Kalender-ID hier eintragen

// Zeitraster-Einstellungen
const START_STUNDE = 5;   // Kalender beginnt um 6:00 Uhr
const END_STUNDE = 23;    // Kalender endet um 23:00 Uhr

// ============ WEB-APP EINSTIEGSPUNKT ============

function doGet() {
  return HtmlService.createHtmlOutput(getHtmlContent())
    .setTitle('Kalender Wochenansicht')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ============ KALENDER-DATEN ABRUFEN ============

function holeWochenTermine(startDatum) {
  try {
    const kalender = CalendarApp.getCalendarById(KALENDER_ID);
    
    if (!kalender) {
      return {
        erfolg: false,
        fehler: "Kalender nicht gefunden!"
      };
    }
    
    const start = new Date(startDatum);
    const ende = new Date(start);
    ende.setDate(ende.getDate() + 7);
    
    const termine = kalender.getEvents(start, ende);
    
    const terminListe = termine.map(termin => {
      const farbe = termin.getColor() || "standard";
      
      return {
        titel: termin.getTitle(),
        start: termin.getStartTime().getTime(),
        ende: termin.getEndTime().getTime(),
        farbe: farbe,
        farbName: getFarbName(farbe),
        ganztaegig: termin.isAllDayEvent(),
        beschreibung: termin.getDescription() || "",
        ort: termin.getLocation() || ""
      };
    });
    
    return {
      erfolg: true,
      kalenderName: kalender.getName(),
      termine: terminListe,
      startStunde: START_STUNDE,
      endStunde: END_STUNDE
    };
    
  } catch (error) {
    return {
      erfolg: false,
      fehler: error.message
    };
  }
}

function getFarbName(farbe) {
  const farben = {
    "1": "Lavender",
    "2": "STB",
    "3": "Grape",
    "4": "Flamingo",
    "5": "Hobbies",
    "6": "Tangerine",
    "7": "ECB",
    "8": "Vermietung",
    "9": "Blueberry",
    "10": "Basil",
    "11": "öffentliche Laufzeit",
    "standard": "ECB",
    "": "ECB"
  };
  return farben[farbe] || "Unbekannt";
}

// ============ HTML CONTENT ============

function getHtmlContent() {
  return `
<!DOCTYPE html>
<html>
<head>
  <base target="_top">
  <meta charset="UTF-8">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: #f5f5f5;
      padding: 20px;
      overflow-x: auto;
    }
    
    .container {
      max-width: 1600px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    
    .header {
      background: linear-gradient(135deg, #1a73e8 0%, #4285f4 100%);
      color: white;
      padding: 20px 30px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .header h1 {
      font-size: 24px;
      font-weight: 500;
    }
    
    .nav-controls {
      display: flex;
      gap: 15px;
      align-items: center;
    }
    
    .nav-btn {
      background: rgba(255,255,255,0.2);
      border: 1px solid rgba(255,255,255,0.3);
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
    }
    
    .nav-btn:hover {
      background: rgba(255,255,255,0.3);
    }
    
    .week-info {
      font-size: 16px;
      font-weight: 500;
    }
    
    .calendar-wrapper {
      overflow-x: auto;
      padding: 20px;
    }
    
    .calendar-grid {
      display: grid;
      grid-template-columns: 60px repeat(7, 1fr);
      min-width: 900px;
      border: 1px solid #e0e0e0;
    }
    
    .time-column {
      grid-column: 1;
      background: #f8f9fa;
      border-right: 2px solid #e0e0e0;
    }
    
    .day-header-row {
      display: contents;
    }
    
    .corner-cell {
      grid-column: 1;
      grid-row: 1;
      background: #f8f9fa;
      border-right: 2px solid #e0e0e0;
      border-bottom: 2px solid #e0e0e0;
      position: sticky;
      top: 0;
      z-index: 20;
    }
    
    .day-header {
      padding: 15px 10px;
      text-align: center;
      background: #f8f9fa;
      border-bottom: 2px solid #e0e0e0;
      border-right: 1px solid #e0e0e0;
      position: sticky;
      top: 0;
      z-index: 15;
    }
    
    .day-name {
      font-size: 11px;
      color: #666;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    
    .day-number {
      font-size: 18px;
      font-weight: 600;
      color: #202124;
      margin-top: 5px;
    }
    
    .day-header.today {
      background: #e8f0fe;
    }
    
    .day-header.today .day-number {
      background: #1a73e8;
      color: white;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 5px;
    }
    
    .time-slot {
      height: 60px;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 5px;
      font-size: 11px;
      color: #5f6368;
      background: #f8f9fa;
      position: sticky;
      left: 0;
      z-index: 10;
    }
    
    .day-column {
      position: relative;
      border-right: 1px solid #e0e0e0;
    }
    
    .hour-cell {
      height: 60px;
      border-bottom: 1px solid #e0e0e0;
      position: relative;
    }
    
    .hour-cell:hover {
      background: #f8f9fa;
    }
    
    .event {
      position: absolute;
      left: 2px;
      right: 2px;
      padding: 4px 6px;
      border-radius: 3px;
      border-left: 3px solid;
      cursor: pointer;
      overflow: hidden;
      font-size: 11px;
      transition: all 0.2s;
      z-index: 5;
    }
    
    .event:hover {
      z-index: 100;
      box-shadow: 0 4px 8px rgba(0,0,0,0.2);
      transform: scale(1.02);
    }
    
    .event-title {
      font-weight: 600;
      color: #202124;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }
    
    .event-time {
      font-size: 10px;
      color: #5f6368;
      margin-top: 2px;
    }
    
    /* Farben für Termine */
    .event[data-color="1"] { 
      background: rgba(164, 189, 252, 0.3);
      border-left-color: #a4bdfc;
    }
    .event[data-color="2"] { 
      background: rgba(122, 231, 191, 0.3);
      border-left-color: #7ae7bf;
    }
    .event[data-color="3"] { 
      background: rgba(219, 173, 255, 0.3);
      border-left-color: #dbadff;
    }
    .event[data-color="4"] { 
      background: rgba(255, 136, 124, 0.3);
      border-left-color: #ff887c;
    }
    .event[data-color="5"] { 
      background: rgba(251, 215, 91, 0.3);
      border-left-color: #fbd75b;
    }
    .event[data-color="6"] { 
      background: rgba(255, 184, 120, 0.3);
      border-left-color: #ffb878;
    }
    .event[data-color="7"] { 
      background: rgba(70, 214, 219, 0.3);
      border-left-color: #46d6db;
    }
    .event[data-color="8"] { 
      background: rgba(225, 225, 225, 0.5);
      border-left-color: #e1e1e1;
    }
    .event[data-color="9"] { 
      background: rgba(84, 132, 237, 0.3);
      border-left-color: #5484ed;
    }
    .event[data-color="10"] { 
      background: rgba(81, 183, 73, 0.3);
      border-left-color: #51b749;
    }
    .event[data-color="11"] { 
      background: rgba(220, 33, 39, 0.3);
      border-left-color: #dc2127;
    }
    .event[data-color="standard"], .event[data-color=""] { 
      background: rgba(70, 214, 219, 0.3);
      border-left-color: #46d6db;
    }
    
    .all-day-section {
      background: #fff8e1;
      padding: 10px;
      border-bottom: 2px solid #e0e0e0;
      display: none;
    }
    
    .all-day-section.has-events {
      display: grid;
      grid-template-columns: 60px repeat(7, 1fr);
      gap: 5px;
    }
    
    .all-day-label {
      font-size: 11px;
      color: #666;
      font-weight: 600;
      padding: 5px;
    }
    
    .all-day-event {
      padding: 6px 8px;
      border-radius: 3px;
      border-left: 3px solid;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      cursor: pointer;
    }
    
    .loading {
      text-align: center;
      padding: 40px;
      color: #5f6368;
    }
    
    .error {
      background: #fce8e6;
      color: #c5221f;
      padding: 20px;
      margin: 20px;
      border-radius: 4px;
      border-left: 4px solid #c5221f;
    }
    
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 15px;
      padding: 15px 30px;
      background: #f8f9fa;
      border-top: 1px solid #e0e0e0;
      font-size: 12px;
    }
    
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .legend-color {
      width: 16px;
      height: 16px;
      border-radius: 2px;
    }
    
    @media (max-width: 768px) {
      .header {
        flex-direction: column;
        gap: 15px;
      }
      
      .nav-controls {
        width: 100%;
        justify-content: space-between;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 id="kalenderName">📅 Kalender</h1>
      <div class="nav-controls">
        <button class="nav-btn" onclick="vorherigeSemaine()">← Vorherige</button>
        <span class="week-info" id="weekInfo">KW --</span>
        <button class="nav-btn" onclick="heutigeSemaine()">Heute</button>
        <button class="nav-btn" onclick="naechsteSemaine()">Nächste →</button>
      </div>
    </div>
    
    <div id="kalenderContent">
      <div class="loading">⏳ Lade Kalender...</div>
    </div>
    
    <div class="legend" id="legend"></div>
  </div>
  
  <script>
    let aktuellesDatum = new Date();
    let startStunde = 6;
    let endStunde = 23;
    
    function getMondayOfWeek(date) {
      const d = new Date(date);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      return new Date(d.setDate(diff));
    }
    
    function getKalenderwoche(date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 4 - (d.getDay() || 7));
      const yearStart = new Date(d.getFullYear(), 0, 1);
      return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    }
    
    function vorherigeSemaine() {
      aktuellesDatum.setDate(aktuellesDatum.getDate() - 7);
      ladeKalender();
    }
    
    function naechsteSemaine() {
      aktuellesDatum.setDate(aktuellesDatum.getDate() + 7);
      ladeKalender();
    }
    
    function heutigeSemaine() {
      aktuellesDatum = new Date();
      ladeKalender();
    }
    
    function formatDatum(date) {
      return date.toLocaleDateString('de-DE', { 
        day: '2-digit', 
        month: '2-digit', 
        year: 'numeric' 
      });
    }
    
    function formatZeit(date) {
      return date.toLocaleTimeString('de-DE', { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
    }
    
    function ladeKalender() {
      const montag = getMondayOfWeek(aktuellesDatum);
      const sonntag = new Date(montag);
      sonntag.setDate(sonntag.getDate() + 6);
      
      const kw = getKalenderwoche(montag);
      document.getElementById('weekInfo').textContent = 
        \`KW \${kw} | \${formatDatum(montag)} - \${formatDatum(sonntag)}\`;
      
      document.getElementById('kalenderContent').innerHTML = 
        '<div class="loading">⏳ Lade Termine...</div>';
      
      google.script.run
        .withSuccessHandler(zeigeKalender)
        .withFailureHandler(zeigeFehler)
        .holeWochenTermine(montag.toISOString());
    }
    
    function zeigeKalender(result) {
      if (!result.erfolg) {
        zeigeFehler(result.fehler);
        return;
      }
      
      document.getElementById('kalenderName').textContent = 
        '📅 ' + result.kalenderName;
      
      startStunde = result.startStunde;
      endStunde = result.endStunde;
      
      const montag = getMondayOfWeek(aktuellesDatum);
      const tage = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
      const heute = new Date();
      heute.setHours(0, 0, 0, 0);
      
      let html = '<div class="calendar-wrapper"><div class="calendar-grid">';
      
      // Ecke oben links
      html += '<div class="corner-cell"></div>';
      
      // Tag-Header
      for (let i = 0; i < 7; i++) {
        const tag = new Date(montag);
        tag.setDate(tag.getDate() + i);
        tag.setHours(0, 0, 0, 0);
        
        const istHeute = tag.getTime() === heute.getTime();
        
        html += \`
          <div class="day-header \${istHeute ? 'today' : ''}">
            <div class="day-name">\${tage[i]}</div>
            <div class="day-number">\${tag.getDate()}.\${tag.getMonth() + 1}.</div>
          </div>
        \`;
      }
      
      // Zeitraster und Termine
      for (let stunde = startStunde; stunde <= endStunde; stunde++) {
        // Zeit-Label links
        html += \`<div class="time-slot">\${stunde}:00</div>\`;
        
        // Spalten für jeden Tag
        for (let tagIndex = 0; tagIndex < 7; tagIndex++) {
          const tag = new Date(montag);
          tag.setDate(tag.getDate() + tagIndex);
          
          html += \`<div class="hour-cell" id="cell-\${tagIndex}-\${stunde}">\`;
          
          // Termine für diese Stunde und diesen Tag
          const stundenTermine = result.termine.filter(t => {
            if (t.ganztaegig) return false;
            
            const tStart = new Date(t.start);
            const tEnde = new Date(t.ende);
            const tagesStart = new Date(tag);
            tagesStart.setHours(0, 0, 0, 0);
            const tagesEnde = new Date(tag);
            tagesEnde.setHours(23, 59, 59, 999);
            
            // Prüfe ob Termin in diesem Tag ist
            if (tStart < tagesStart || tStart > tagesEnde) return false;
            
            // Prüfe ob Termin in dieser Stunde startet oder läuft
            const stundenStart = stunde;
            const stundenEnde = stunde + 1;
            const terminStunde = tStart.getHours();
            const terminMinute = tStart.getMinutes();
            const terminEndeStunde = tEnde.getHours();
            
            return (terminStunde === stunde) || 
                   (terminStunde < stunde && terminEndeStunde > stunde);
          });
          
          stundenTermine.forEach(termin => {
            const tStart = new Date(termin.start);
            const tEnde = new Date(termin.ende);
            
            // Berechne Position und Höhe
            const startStunde = tStart.getHours();
            const startMinute = tStart.getMinutes();
            const endeStunde = tEnde.getHours();
            const endeMinute = tEnde.getMinutes();
            
            // Nur anzeigen wenn Termin in dieser Stunde startet
            if (startStunde === stunde) {
              const topOffset = (startMinute / 60) * 60;
              const durationMinutes = (endeStunde * 60 + endeMinute) - (startStunde * 60 + startMinute);
              const height = (durationMinutes / 60) * 60;
              
              html += \`
                <div class="event" 
                     data-color="\${termin.farbe}"
                     style="top: \${topOffset}px; height: \${Math.max(height, 20)}px;"
                     title="\${termin.beschreibung || termin.titel}">
                  <div class="event-title">\${termin.titel}</div>
                  <div class="event-time">\${formatZeit(tStart)} - \${formatZeit(tEnde)}</div>
                </div>
              \`;
            }
          });
          
          html += '</div>';
        }
      }
      
      html += '</div></div>';
      
      document.getElementById('kalenderContent').innerHTML = html;
      
      // Legende erstellen
      erstelleLegende(result.termine);
    }
    
    function erstelleLegende(termine) {
      const farben = new Set();
      termine.forEach(t => farben.add(t.farbe + '|' + t.farbName));
      
      const farbMap = {
        "1": "#a4bdfc", "2": "#7ae7bf", "3": "#dbadff", "4": "#ff887c",
        "5": "#fbd75b", "6": "#ffb878", "7": "#46d6db", "8": "#e1e1e1",
        "9": "#5484ed", "10": "#51b749", "11": "#dc2127", 
        "standard": "#46d6db", "": "#46d6db"
      };
      
      let html = '<strong>Kategorien:</strong>';
      Array.from(farben).sort().forEach(item => {
        const [farbId, farbName] = item.split('|');
        html += \`
          <div class="legend-item">
            <div class="legend-color" style="background: \${farbMap[farbId]};"></div>
            <span>\${farbName}</span>
          </div>
        \`;
      });
      
      document.getElementById('legend').innerHTML = html;
    }
    
    function zeigeFehler(error) {
      document.getElementById('kalenderContent').innerHTML = 
        \`<div class="error"><strong>❌ Fehler:</strong> \${error}</div>\`;
    }
    
    // Initiales Laden
    ladeKalender();
  </script>
</body>
</html>
  `;
}