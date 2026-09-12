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
// 'woche' oder 'monat'. Die Wahl überlebt einen Reload.
let ansichtsModus = localStorage.getItem('ecb_ansicht') === 'monat' ? 'monat' : 'woche';
// In der Monatsansicht der Tag, den das Tagespanel zeigt (Standard: heute).
let gewaehlterTag = null;

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

/**
 * Lokales YYYY-MM-DD. Bewusst nicht über toISOString(), das nach UTC umrechnet
 * und abends den Vortag liefern würde.
 */
function toLocalDate(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

function istGleicherTag(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

// ============ NAVIGATION ============

// Die Pfeile bewegen sich in der Einheit der aktuellen Ansicht.
function zurueck() {
  if (ansichtsModus === 'monat') return vorherigerMonat();
  aktuellesDatum.setDate(aktuellesDatum.getDate() - 7);
  ladeKalender();
}

function vor() {
  if (ansichtsModus === 'monat') return naechsterMonat();
  aktuellesDatum.setDate(aktuellesDatum.getDate() + 7);
  ladeKalender();
}

function heuteAnzeigen() {
  aktuellesDatum = new Date();
  gewaehlterTag = null;
  ladeKalender();
}

/**
 * Verschiebt um ganze Monate. setMonth() allein würde überlaufen — der 31. Januar
 * plus ein Monat ergibt den 3. März. Deshalb vorher auf den Monatsletzten klemmen.
 */
function monatVerschieben(anzahl) {
  const tag = aktuellesDatum.getDate();
  const ziel = new Date(aktuellesDatum.getFullYear(), aktuellesDatum.getMonth() + anzahl, 1);
  const letzterTag = new Date(ziel.getFullYear(), ziel.getMonth() + 1, 0).getDate();
  ziel.setDate(Math.min(tag, letzterTag));
  aktuellesDatum = ziel;
  gewaehlterTag = null;
  ladeKalender();
}

function vorherigerMonat() { monatVerschieben(-1); }
function naechsterMonat() { monatVerschieben(1); }

function springeZuDatum(wert) {
  if (!wert) return;
  const [y, m, d] = wert.split('-').map(Number);
  aktuellesDatum = new Date(y, m - 1, d);
  gewaehlterTag = null;
  ladeKalender();
}

function setzeAnsicht(modus) {
  ansichtsModus = modus;
  localStorage.setItem('ecb_ansicht', modus);
  ladeKalender();
}

/** Hält Ansichts-Buttons und Datumsfeld am aktuellen Zustand. */
function aktualisiereNavigation() {
  const istMonat = ansichtsModus === 'monat';
  document.getElementById('btnWoche').classList.toggle('active', !istMonat);
  document.getElementById('btnMonat').classList.toggle('active', istMonat);
  document.getElementById('datumSprung').value = toLocalDate(aktuellesDatum);

  // Im Monatsmodus bewegen die Hauptpfeile schon ganze Monate — die
  // zusätzlichen Monatsknöpfe wären dann doppelt.
  const anzeige = istMonat ? 'none' : '';
  document.getElementById('btnMonatZurueck').style.display = anzeige;
  document.getElementById('btnMonatVor').style.display = anzeige;
}

// ============ LOAD CALENDAR ============

function ladeKalender() {
  aktualisiereNavigation();
  return ansichtsModus === 'monat' ? ladeMonat() : ladeWoche();
}

async function ladeWoche() {
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

/**
 * Lädt das Monatsraster. Es zeigt immer sechs Wochen ab dem Montag der Woche,
 * die den Monatsersten enthält — so bleibt die Höhe über alle Monate gleich und
 * das Raster springt beim Blättern nicht.
 */
async function ladeMonat() {
  const ersterDesMonats = new Date(aktuellesDatum.getFullYear(), aktuellesDatum.getMonth(), 1);
  const rasterStart = getMondayOfWeek(ersterDesMonats);
  const rasterEnde = new Date(rasterStart);
  rasterEnde.setDate(rasterEnde.getDate() + 42);

  document.getElementById('weekInfo').textContent =
    aktuellesDatum.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  document.getElementById('kalenderContent').innerHTML =
    '<div class="loading">⏳ Lade Termine...</div>';

  try {
    const result = await API.getEvents(rasterStart.toISOString(), rasterEnde.toISOString());
    termineImBlick = result.termine;
    startStunde = result.startStunde;
    endStunde = result.endStunde;

    document.getElementById('kalenderName').textContent = '📅 ' + result.kalenderName;
    zeigeMonat(result, rasterStart, ersterDesMonats.getMonth());
    erstelleLegende(result.termine);
  } catch (error) {
    zeigeFehler(error.message || error);
  }
}

// ============ OVERLAP LAYOUT ============

/**
 * Weist überlappenden Terminen Spalten zu, damit sie nebeneinander statt
 * deckungsgleich übereinander dargestellt werden. Liefert eine Map von
 * Termin-ID auf { col, cols }: die Spalte des Termins und die Gesamtzahl der
 * Spalten seiner Überlappungsgruppe. Ganztägige Termine bleiben außen vor.
 *
 * Termine verschiedener Tage überlappen zeitlich nie (die Zeitstempel liegen
 * mindestens einen Tag auseinander), deshalb trennt die reine Intervall-Logik
 * die Tage von selbst.
 */
function berechneUeberlappungsLayout(termine) {
  const layout = new Map();
  const timed = termine
    .filter(t => !t.ganztaegig)
    .slice()
    .sort((a, b) => a.start - b.start || a.ende - b.ende);

  let cluster = [];
  let clusterEnde = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    // Endzeit des jeweils zuletzt einsortierten Termins je Spalte.
    const spaltenEnde = [];
    for (const ev of cluster) {
      let platziert = false;
      for (let c = 0; c < spaltenEnde.length; c++) {
        if (ev.start >= spaltenEnde[c]) {
          spaltenEnde[c] = ev.ende;
          layout.set(ev.id, { col: c, cols: 0 });
          platziert = true;
          break;
        }
      }
      if (!platziert) {
        spaltenEnde.push(ev.ende);
        layout.set(ev.id, { col: spaltenEnde.length - 1, cols: 0 });
      }
    }
    for (const ev of cluster) layout.get(ev.id).cols = spaltenEnde.length;
    cluster = [];
    clusterEnde = -Infinity;
  };

  for (const ev of timed) {
    // Beginnt der Termin erst nach dem Ende der ganzen bisherigen Gruppe,
    // fängt eine neue Überlappungsgruppe an.
    if (ev.start >= clusterEnde) flush();
    cluster.push(ev);
    clusterEnde = Math.max(clusterEnde, ev.ende);
  }
  flush();

  return layout;
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

  // Spalten-Zuordnung für überlappende Termine (einmal pro Woche berechnet).
  const spaltenLayout = berechneUeberlappungsLayout(result.termine);

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

          // Überlappende Termine nebeneinander legen: Breite und Versatz aus der
          // Spalten-Zuordnung. Einzelne Termine bleiben unangetastet (volle
          // Breite über das CSS: left/right = 2px).
          const spalte = spaltenLayout.get(termin.id);
          const spaltenStil = spalte && spalte.cols > 1
            ? ` left: calc(${spalte.col} / ${spalte.cols} * 100% + 2px); width: calc(100% / ${spalte.cols} - 4px); right: auto;`
            : '';

          html += `
            <div class="event"
                 style="top: ${topOffset}px; height: ${Math.max(height, 20)}px; background: ${escapeHtml(termin.farbBg)}; border-left-color: ${escapeHtml(termin.farbHex)};${spaltenStil}"
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

// ============ RENDER MONTH ============

/**
 * Monatsraster (sechs Wochen) neben einem Tagespanel für den gewählten Tag.
 * Das Raster gibt den Überblick, das Panel die Uhrzeiten — in den schmalen
 * Tageszellen wäre ein Stundenraster nicht lesbar.
 */
function zeigeMonat(result, rasterStart, monat) {
  const heute = new Date();
  const tagZumAnzeigen = gewaehlterTag ? new Date(gewaehlterTag) : heute;
  const tage = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  let html = '<div class="month-layout"><div class="month-side"><div class="month-grid">';
  html += tage.map(t => `<div class="month-weekday">${t}</div>`).join('');

  for (let i = 0; i < 42; i++) {
    const tag = new Date(rasterStart);
    tag.setDate(tag.getDate() + i);

    const fremderMonat = tag.getMonth() !== monat;
    const istHeute = istGleicherTag(tag, heute);
    const istGewaehlt = istGleicherTag(tag, tagZumAnzeigen);

    const tagesTermine = result.termine
      .filter(t => istGleicherTag(new Date(t.start), tag))
      .sort((a, b) => a.start - b.start);

    const klassen = ['month-cell'];
    if (fremderMonat) klassen.push('other-month');
    if (istHeute) klassen.push('today');
    if (istGewaehlt) klassen.push('selected');

    // Nur das ISO-Datum landet im Handler — keine benutzergesteuerten Strings.
    html += `<div class="${klassen.join(' ')}" onclick="waehleTag('${toLocalDate(tag)}')">
      <div class="month-daynum">${tag.getDate()}</div>
      <div class="month-chips">`;

    const sichtbar = tagesTermine.slice(0, 3);
    for (const termin of sichtbar) {
      const zeit = termin.ganztaegig ? '' : formatZeit(new Date(termin.start)) + ' ';
      html += `<div class="month-chip"
                    style="background: ${escapeHtml(termin.farbBg)}; border-left-color: ${escapeHtml(termin.farbHex)};"
                    title="${escapeHtml(termin.titel)}">${escapeHtml(zeit)}${escapeHtml(termin.titel)}</div>`;
    }
    if (tagesTermine.length > sichtbar.length) {
      html += `<div class="month-more">+${tagesTermine.length - sichtbar.length} weitere</div>`;
    }

    html += '</div></div>';
  }

  html += '</div></div>';
  html += tagesPanelHtml(result.termine, tagZumAnzeigen, istGleicherTag(tagZumAnzeigen, heute));
  html += '</div>';

  document.getElementById('kalenderContent').innerHTML = html;

  // Auf die aktuelle Uhrzeit scrollen, aber eine Stunde Kontext darüber lassen.
  if (istGleicherTag(tagZumAnzeigen, heute)) {
    const panel = document.getElementById('tagesPanelScroll');
    if (panel) {
      const stunde = Math.max(heute.getHours() - 1, startStunde);
      panel.scrollTop = (stunde - startStunde) * 60;
    }
  }
}

/** Stundenraster eines einzelnen Tages, inklusive Überlappungs-Layout. */
function tagesPanelHtml(termine, tag, istHeute) {
  const tagesTermine = termine.filter(t => istGleicherTag(new Date(t.start), tag));
  const ganztaegig = tagesTermine.filter(t => t.ganztaegig);
  const spaltenLayout = berechneUeberlappungsLayout(tagesTermine);

  const titel = tag.toLocaleDateString('de-DE', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  });

  let html = `<div class="day-panel">
    <div class="day-panel-header${istHeute ? ' today' : ''}">${escapeHtml(titel)}</div>`;

  if (ganztaegig.length) {
    html += '<div class="day-panel-allday">';
    for (const termin of ganztaegig) {
      html += `<div class="month-chip" style="background: ${escapeHtml(termin.farbBg)}; border-left-color: ${escapeHtml(termin.farbHex)};">
        ${escapeHtml(termin.titel)} (ganztägig)</div>`;
    }
    html += '</div>';
  }

  html += '<div class="day-panel-scroll" id="tagesPanelScroll"><div class="day-panel-grid">';

  for (let stunde = startStunde; stunde <= endStunde; stunde++) {
    html += `<div class="time-slot">${stunde}:00</div><div class="hour-cell">`;

    for (const termin of tagesTermine) {
      if (termin.ganztaegig) continue;
      const tStart = new Date(termin.start);
      if (tStart.getHours() !== stunde) continue;

      const tEnde = new Date(termin.ende);
      const topOffset = (tStart.getMinutes() / 60) * 60;
      const dauer = (tEnde.getHours() * 60 + tEnde.getMinutes()) - (tStart.getHours() * 60 + tStart.getMinutes());
      const spalte = spaltenLayout.get(termin.id);
      const spaltenStil = spalte && spalte.cols > 1
        ? ` left: calc(${spalte.col} / ${spalte.cols} * 100% + 2px); width: calc(100% / ${spalte.cols} - 4px); right: auto;`
        : '';
      const seriesBadge = termin.series_id ? ' 🔁' : '';

      html += `<div class="event"
                    style="top: ${topOffset}px; height: ${Math.max((dauer / 60) * 60, 20)}px; background: ${escapeHtml(termin.farbBg)}; border-left-color: ${escapeHtml(termin.farbHex)};${spaltenStil}"
                    title="${escapeHtml(termin.beschreibung || termin.titel)}">
        ${loeschButton(termin)}
        <div class="event-title">${escapeHtml(termin.titel)}${seriesBadge}</div>
        <div class="event-time">${formatZeit(tStart)} - ${formatZeit(tEnde)}</div>
      </div>`;
    }

    html += '</div>';
  }

  html += '</div></div></div>';
  return html;
}

/** Klick auf eine Tageszelle: Tagespanel auf diesen Tag umstellen. */
function waehleTag(isoDatum) {
  const [y, m, d] = isoDatum.split('-').map(Number);
  gewaehlterTag = new Date(y, m - 1, d);
  ladeMonat();
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
