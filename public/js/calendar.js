/**
 * Calendar rendering logic — migrated from Code.gs client-side JS.
 * Replaces google.script.run with fetch() calls via API helper.
 */

let aktuellesDatum = new Date();
let startStunde = 6;
let endStunde = 23;
// Angemeldete Benutzer (Editor wie Admin) dürfen Termine direkt im Kalender
// löschen — die API erlaubt beiden Rollen das Löschen.
let darfBearbeiten = false;
let termineImBlick = [];

// ============ DATE UTILITIES ============

function getMondayOfWeek(date) {
  const d = new Date(date);
  // Auf Mitternacht normalisieren: Sonst trägt der Montag die aktuelle Uhrzeit,
  // und die Wochenabfrage (end_time > Montag) verliert alle Montags-Termine, die
  // vor der aktuellen Uhrzeit enden — die Woche sähe dann fälschlich leer aus.
  d.setHours(0, 0, 0, 0);
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

function formatDatum(date) {
  return date.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function formatZeit(date) {
  return date.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ============ NAVIGATION ============

function vorherigeWoche() {
  aktuellesDatum.setDate(aktuellesDatum.getDate() - 7);
  ladeKalender();
}

function naechsteWoche() {
  aktuellesDatum.setDate(aktuellesDatum.getDate() + 7);
  ladeKalender();
}

function heutigeWoche() {
  aktuellesDatum = new Date();
  ladeKalender();
}

// ============ LOAD CALENDAR ============

async function ladeKalender() {
  const montag = getMondayOfWeek(aktuellesDatum);
  const sonntag = new Date(montag);
  sonntag.setDate(sonntag.getDate() + 6);

  const kw = getKalenderwoche(montag);
  document.getElementById('weekInfo').textContent =
    `KW ${kw} | ${formatDatum(montag)} - ${formatDatum(sonntag)}`;

  document.getElementById('kalenderContent').innerHTML =
    '<div class="loading">⏳ Lade Termine...</div>';

  try {
    const ende = new Date(montag);
    ende.setDate(ende.getDate() + 7);

    const result = await API.getEvents(montag.toISOString(), ende.toISOString());
    termineImBlick = result.termine;
    zeigeKalender(result);
  } catch (error) {
    zeigeFehler(error.message || error);
  }
}

// ============ RENDER CALENDAR ============

function zeigeKalender(result) {
  if (!result.erfolg) {
    zeigeFehler(result.fehler || 'Unbekannter Fehler');
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

  let html = '';

  // Collect all-day events for inline rendering in day columns
  const ganztaegigTermine = result.termine.filter(t => t.ganztaegig);

  // ========== TIME GRID CALENDAR ==========
  html += '<div class="calendar-wrapper"><div class="calendar-grid">';

  // Corner cell
  html += '<div class="corner-cell"></div>';

  // Day headers
  for (let i = 0; i < 7; i++) {
    const tag = new Date(montag);
    tag.setDate(tag.getDate() + i);
    tag.setHours(0, 0, 0, 0);

    const istHeute = tag.getTime() === heute.getTime();

    html += `
      <div class="day-header ${istHeute ? 'today' : ''}">
        <div class="day-name">${tage[i]}</div>
        <div class="day-number">${tag.getDate()}.${tag.getMonth() + 1}.</div>
      </div>
    `;
  }

  // Time grid and events
  for (let stunde = startStunde; stunde <= endStunde; stunde++) {
    // Time label
    html += `<div class="time-slot">${stunde}:00</div>`;

    // Column for each day
    for (let tagIndex = 0; tagIndex < 7; tagIndex++) {
      const tag = new Date(montag);
      tag.setDate(tag.getDate() + tagIndex);

      html += `<div class="hour-cell" id="cell-${tagIndex}-${stunde}">`;

      // All-day events rendered in the first hour cell of each day
      if (stunde === startStunde) {
        const tagStart = new Date(tag);
        tagStart.setHours(0, 0, 0, 0);

        ganztaegigTermine.forEach(termin => {
          const tStart = new Date(termin.start);
          tStart.setHours(0, 0, 0, 0);
          const tEnde = new Date(termin.ende);
          tEnde.setHours(23, 59, 59, 999);

          if (tagStart >= tStart && tagStart <= tEnde) {
            const totalHours = endStunde - startStunde + 1;
            const fullHeight = totalHours * 60;
            const seriesBadge = termin.series_id ? ' 🔁' : '';
            html += `
              <div class="event all-day-inline"
                   style="top: 0; height: ${fullHeight}px; background: ${escapeHtml(termin.farbBg)}; border-left-color: ${escapeHtml(termin.farbHex)};"
                   title="${escapeHtml(termin.beschreibung || termin.titel)}${termin.series_id ? ' (Wochenserie)' : ''} (Ganztägig)">
                ${loeschButton(termin)}
                <div class="event-title">${escapeHtml(termin.titel)}${seriesBadge}</div>
                <div class="event-time">Ganztägig</div>
              </div>
            `;
          }
        });
      }

      // Events for this hour and day (excluding all-day)
      const stundenTermine = result.termine.filter(t => {
        if (t.ganztaegig) return false;

        const tStart = new Date(t.start);
        const tEnde = new Date(t.ende);
        const tagesStart = new Date(tag);
        tagesStart.setHours(0, 0, 0, 0);
        const tagesEnde = new Date(tag);
        tagesEnde.setHours(23, 59, 59, 999);

        if (tStart < tagesStart || tStart > tagesEnde) return false;

        const terminStunde = tStart.getHours();
        const terminEndeStunde = tEnde.getHours();
        const terminEndeMinute = tEnde.getMinutes();

        // Show if event starts in this hour or spans across it
        return (terminStunde === stunde) ||
               (terminStunde < stunde && (terminEndeStunde > stunde || (terminEndeStunde === stunde && terminEndeMinute > 0)));
      });

      stundenTermine.forEach(termin => {
        const tStart = new Date(termin.start);
        const tEnde = new Date(termin.ende);

        const terminStartStunde = tStart.getHours();
        const terminStartMinute = tStart.getMinutes();
        const terminEndeStunde = tEnde.getHours();
        const terminEndeMinute = tEnde.getMinutes();

        // Only render when event starts in this hour cell
        if (terminStartStunde === stunde) {
          const topOffset = (terminStartMinute / 60) * 60;
          const durationMinutes = (terminEndeStunde * 60 + terminEndeMinute) - (terminStartStunde * 60 + terminStartMinute);
          const height = (durationMinutes / 60) * 60;

          const seriesBadge = termin.series_id ? ' 🔁' : '';
          html += `
            <div class="event"
                 style="top: ${topOffset}px; height: ${Math.max(height, 20)}px; background: ${escapeHtml(termin.farbBg)}; border-left-color: ${escapeHtml(termin.farbHex)};"
                 title="${escapeHtml(termin.beschreibung || termin.titel)}${termin.series_id ? ' (Wochenserie)' : ''}">
              ${loeschButton(termin)}
              <div class="event-title">${escapeHtml(termin.titel)}${seriesBadge}</div>
              <div class="event-time">${formatZeit(tStart)} - ${formatZeit(tEnde)}</div>
            </div>
          `;
        }
      });

      html += '</div>';
    }
  }

  html += '</div></div>';

  document.getElementById('kalenderContent').innerHTML = html;

  // Build legend
  erstelleLegende(result.termine);
}

// ============ LEGEND ============

function erstelleLegende(termine) {
  const farben = new Map();
  termine.forEach(t => {
    if (!farben.has(t.farbName)) {
      farben.set(t.farbName, t.farbHex);
    }
  });

  let html = '<strong>Kategorien:</strong>';
  const sorted = Array.from(farben.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  sorted.forEach(([name, hex]) => {
    html += `
      <div class="legend-item">
        <div class="legend-color" style="background: ${escapeHtml(hex)};"></div>
        <span>${escapeHtml(name)}</span>
      </div>
    `;
  });

  document.getElementById('legend').innerHTML = html;
}

// ============ LÖSCHEN IM KALENDER ============

/**
 * Lösch-Button am Termin — nur für angemeldete Benutzer. Es wird ausschließlich
 * die numerische ID in den Handler interpoliert; Titel und Serien-ID werden im
 * Handler aus `termineImBlick` nachgeschlagen, nie in ein HTML-Attribut geschrieben.
 */
function loeschButton(termin) {
  if (!darfBearbeiten) return '';
  return `<button class="event-delete" title="Termin löschen" onclick="loescheTermin(${termin.id})">🗑️</button>`;
}

async function loescheTermin(id) {
  const termin = termineImBlick.find(t => t.id === id);
  if (!termin) return;

  try {
    if (termin.series_id) {
      const nurDieser = confirm(
        `"${termin.titel}" gehört zu einer Wochenserie.\n\n` +
        `OK = nur diesen Termin löschen\n` +
        `Abbrechen = Serie unverändert lassen\n\n` +
        `(Die ganze Serie löschst du im Admin-Bereich unter Termine.)`
      );
      if (!nurDieser) return;
    } else if (!confirm(`Termin "${termin.titel}" wirklich löschen?`)) {
      return;
    }

    await API.deleteEvent(id);
    await ladeKalender();
  } catch (error) {
    alert('Löschen fehlgeschlagen: ' + (error.message || error));
  }
}

// ============ ERROR ============

function zeigeFehler(error) {
  document.getElementById('kalenderContent').innerHTML =
    `<div class="error"><strong>❌ Fehler:</strong> ${escapeHtml(String(error))}</div>`;
}

// ============ UTIL ============

function escapeHtml(text) {
  // Escapes both text- and attribute-context special chars. Quotes MUST be
  // escaped because these values are also interpolated into double-quoted
  // HTML attributes (title="…") — the DOM textContent trick does not escape them.
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============ INIT ============

document.addEventListener('DOMContentLoaded', async () => {
  // Token gegen die API prüfen statt nur auf sein Vorhandensein zu vertrauen —
  // ein abgelaufener Token würde sonst Buttons zeigen, die nur 401 liefern.
  if (API.isLoggedIn()) {
    try {
      await API.me();
      darfBearbeiten = true;
    } catch (err) {
      darfBearbeiten = false;
    }
  }
  ladeKalender();
});
