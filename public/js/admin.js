/**
 * Admin panel logic — manages events, categories, and users.
 */

let currentUser = null;
let categories = [];
let events = [];
let users = [];

// ============ INIT ============

document.addEventListener('DOMContentLoaded', async () => {
  // Check auth
  if (!API.isLoggedIn()) {
    window.location.href = '/login.html';
    return;
  }

  try {
    currentUser = await API.me();
    document.getElementById('userInfo').textContent =
      `${currentUser.display_name} (${currentUser.role})`;
  } catch (err) {
    // Token invalid/expired
    API.logout();
    window.location.href = '/login.html';
    return;
  }

  rollenSichtbarkeitAnwenden();

  // Set default filter dates: current week
  const now = new Date();
  const monday = getMondayOfWeek(now);
  const nextSunday = new Date(monday);
  nextSunday.setDate(nextSunday.getDate() + 13); // 2 weeks ahead
  document.getElementById('eventFilterStart').value = toLocalDate(monday);
  document.getElementById('eventFilterEnd').value = toLocalDate(nextSunday);

  initSeriesForm();

  // Load data
  await loadCategories();
  await loadEvents();
  if (currentUser.role === 'admin') {
    await loadUsers();
    await loadSyncTokens();
    initBulkDelete();
  }

  initStats();
  initPasswordModal();
});

/**
 * Blendet Bereiche aus, für die die Rolle keine Berechtigung hat.
 * Muss nach jedem innerHTML-Rendern erneut laufen, weil dabei neue
 * .admin-only-Elemente in den DOM kommen.
 */
function rollenSichtbarkeitAnwenden() {
  if (!currentUser) return;

  const verstecken = (selektor) =>
    document.querySelectorAll(selektor).forEach(el => { el.style.display = 'none'; });

  if (currentUser.role !== 'admin') verstecken('.admin-only');
  // Ein Eismeister arbeitet ausschließlich im Termine-Tab.
  if (currentUser.role === 'eismeister') verstecken('.not-eismeister');
}

const ROLLEN_ANZEIGE = {
  admin: '👑 Admin',
  editor: '✏️ Editor',
  eismeister: '🧊 Eismeister',
};

/** Kategorien, in denen der angemeldete Benutzer Termine bearbeiten darf. */
function bearbeitbareKategorien() {
  if (currentUser && currentUser.role === 'eismeister') {
    return categories.filter(c => c.eismeister_managed);
  }
  return categories;
}

/** Spiegelt die Server-Prüfung, um Aktionen auszublenden, die 403 liefern würden. */
function darfKategorieBearbeiten(categoryId) {
  if (!currentUser || currentUser.role !== 'eismeister') return true;
  const kategorie = categories.find(c => String(c.id) === String(categoryId));
  return !!kategorie && !!kategorie.eismeister_managed;
}

function initSeriesForm() {
  const today = new Date();
  const until = new Date(today);
  until.setDate(until.getDate() + 7 * 12); // sensible default: a 12-week block

  document.getElementById('seriesWeekday').value = String(today.getDay());
  document.getElementById('seriesDateFrom').value = toLocalDate(today);
  document.getElementById('seriesDateTo').value = toLocalDate(until);

  ['seriesWeekday', 'seriesTimeFrom', 'seriesTimeTo', 'seriesDateFrom', 'seriesDateTo']
    .forEach(id => document.getElementById(id).addEventListener('input', updateSeriesPreview));

  // Click on the backdrop (not the dialog itself) closes the series dialog
  document.getElementById('seriesModal').addEventListener('click', (e) => {
    if (e.target.id === 'seriesModal') closeSeriesModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openSeries) closeSeriesModal();
  });

  setEventMode('single');
}

// ============ TAB SWITCHING ============

function switchTab(tabName) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');
}

// ============ LOGOUT ============

function logout() {
  API.logout();
  window.location.href = '/login.html';
}

// ============ TOAST ============

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============ UTILITIES ============

function getMondayOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

function toLocalDate(date) {
  // Deliberately not toISOString() — that converts to UTC and returns the
  // previous day for times before the UTC offset (e.g. 00:30 CEST).
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toLocalDatetime(isoString) {
  const d = new Date(isoString);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function formatDatetime(isoString) {
  return new Date(isoString).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function escapeHtml(text) {
  // Escapes text- and attribute-context special chars (quotes included), so
  // interpolating stored values into double-quoted HTML attributes is safe.
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ============================================================
//  EVENTS
// ============================================================

const WEEKDAY_ADVERBS = ['sonntags', 'montags', 'dienstags', 'mittwochs', 'donnerstags', 'freitags', 'samstags'];

async function loadEvents() {
  const start = document.getElementById('eventFilterStart').value;
  const end = document.getElementById('eventFilterEnd').value;

  if (!start || !end) return;

  const startISO = new Date(start).toISOString();
  const endDate = new Date(end);
  endDate.setDate(endDate.getDate() + 1);
  const endISO = endDate.toISOString();

  try {
    // includeExtern: Auswärtsspiele belegen die Halle nicht und fehlen deshalb
    // in der Kalenderansicht — in der Verwaltung müssen sie trotzdem sichtbar sein.
    const result = await API.getEvents(startISO, endISO, true);
    events = result.termine;
    const tbody = document.getElementById('eventsTableBody');

    if (events.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999">Keine Termine im gewählten Zeitraum</td></tr>';
      return;
    }

    // A series collapses into a single row (first occurrence in range decides
    // the position); single events render as before.
    const rows = [];
    const seenSeries = new Set();

    for (const t of events) {
      if (t.series_id) {
        if (seenSeries.has(t.series_id)) continue;
        seenSeries.add(t.series_id);
        rows.push(renderSeriesRow(t));
      } else {
        rows.push(renderEventRow(t));
      }
    }

    tbody.innerHTML = rows.join('');
  } catch (err) {
    showToast('Fehler beim Laden: ' + err.message, 'error');
  }
}

// Only numeric ids / the series UUID are interpolated into the inline handlers;
// all user-controlled strings are looked up from `events` inside the handler,
// never injected into HTML attributes.
function renderEventRow(t) {
  // Termine fremder Kategorien bleiben sichtbar, aber ohne Aktionen — der Server
  // würde sie mit 403 ablehnen.
  const aktionen = darfKategorieBearbeiten(t.farbe)
    ? `<button class="btn-icon" title="Bearbeiten" onclick="editEvent(${t.id})">✏️</button>
       <button class="btn-icon" title="Löschen" onclick="deleteEvent(${t.id})">🗑️</button>`
    : '';

  return `
    <tr>
      <td>${escapeHtml(t.titel)}</td>
      <td><span class="color-preview" style="background:${escapeHtml(t.farbHex)}"></span>${escapeHtml(t.farbName)}</td>
      <td>${formatDatetime(new Date(t.start).toISOString())}</td>
      <td>${formatDatetime(new Date(t.ende).toISOString())}</td>
      <td>${t.ganztaegig ? '✅' : ''}</td>
      <td class="actions">${aktionen}</td>
    </tr>
  `;
}

function renderSeriesRow(t) {
  const s = t.serie;
  const rhythm = s
    ? `${WEEKDAY_ADVERBS[s.wochentag]} ${s.zeitVon}–${s.zeitBis} Uhr`
    : 'Serie';
  const period = s ? `${formatDatum(s.datumVon)} – ${formatDatum(s.datumBis)}` : '';
  const count = s ? `${s.anzahl} Termine` : '';
  const darf = darfKategorieBearbeiten(t.farbe);

  return `
    <tr class="${darf ? 'series-row' : ''}" ${darf ? `onclick="openSeriesModal('${escapeHtml(t.series_id)}')"` : ''}>
      <td>🔁 ${escapeHtml(t.titel)}<span class="series-badge">${escapeHtml(count)}</span></td>
      <td><span class="color-preview" style="background:${escapeHtml(t.farbHex)}"></span>${escapeHtml(t.farbName)}</td>
      <td colspan="2">${escapeHtml(rhythm)} · ${escapeHtml(period)}</td>
      <td></td>
      <td class="actions">
        ${darf ? `<button class="btn-icon" title="Serie öffnen" onclick="event.stopPropagation();openSeriesModal('${escapeHtml(t.series_id)}')">📂</button>` : ''}
      </td>
    </tr>
  `;
}

// ============ EINZEL- / SERIENTERMIN ============

let eventMode = 'single';

function setEventMode(mode) {
  eventMode = mode;
  const isSeries = mode === 'series';

  document.getElementById('singleFields').style.display = isSeries ? 'none' : '';
  document.getElementById('seriesFields').style.display = isSeries ? '' : 'none';
  document.getElementById('allDayGroup').style.display = isSeries ? 'none' : '';
  document.querySelectorAll('#eventModeSwitch .mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  document.getElementById('eventSubmitBtn').textContent =
    isSeries ? 'Serie erstellen' : 'Termin erstellen';

  // required only applies to the fields of the active mode, otherwise the
  // browser blocks submit on hidden inputs it cannot focus.
  document.getElementById('eventStart').required = !isSeries;
  document.getElementById('eventEnd').required = !isSeries;
  ['seriesTimeFrom', 'seriesTimeTo', 'seriesDateFrom', 'seriesDateTo'].forEach(id => {
    document.getElementById(id).required = isSeries;
  });

  if (isSeries) updateSeriesPreview();
}

/**
 * Live preview of what the series will produce. This is the whole point of the
 * explicit series mode — the old form silently rounded a "repeat until" date
 * into a week count and the user only saw the result after saving.
 */
function updateSeriesPreview() {
  const box = document.getElementById('seriesPreview');
  const weekday = parseInt(document.getElementById('seriesWeekday').value);
  const timeFrom = document.getElementById('seriesTimeFrom').value;
  const timeTo = document.getElementById('seriesTimeTo').value;
  const dateFrom = document.getElementById('seriesDateFrom').value;
  const dateTo = document.getElementById('seriesDateTo').value;

  if (!dateFrom || !dateTo || !timeFrom || !timeTo) {
    box.className = 'series-preview';
    box.textContent = 'Bitte Zeitraum und Uhrzeiten ausfüllen.';
    return;
  }
  if (timeTo <= timeFrom) {
    box.className = 'series-preview invalid';
    box.textContent = 'Die Endzeit muss nach der Startzeit liegen.';
    return;
  }
  if (dateTo < dateFrom) {
    box.className = 'series-preview invalid';
    box.textContent = 'Das Enddatum muss nach dem Startdatum liegen.';
    return;
  }

  const dates = seriesOccurrences(weekday, dateFrom, dateTo);
  if (dates.length === 0) {
    box.className = 'series-preview invalid';
    box.textContent = `Im gewählten Zeitraum liegt kein ${WEEKDAY_NAMES[weekday]}.`;
    return;
  }

  const first = dates[0];
  const last = dates[dates.length - 1];
  box.className = 'series-preview';
  box.textContent =
    `${dates.length} Termine · ${WEEKDAY_ADVERBS[weekday]} ${timeFrom}–${timeTo} Uhr · ` +
    `erster ${formatDatumShort(first)}, letzter ${formatDatumShort(last)}`;
}

const WEEKDAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/** Mirrors generateSeriesDates() on the server — preview only, the server decides. */
function seriesOccurrences(weekday, dateFrom, dateTo) {
  const [fy, fm, fd] = dateFrom.split('-').map(Number);
  const cursor = new Date(fy, fm - 1, fd);
  cursor.setDate(cursor.getDate() + ((weekday - cursor.getDay()) + 7) % 7);

  const [ty, tm, td] = dateTo.split('-').map(Number);
  const last = new Date(ty, tm - 1, td, 23, 59);

  const dates = [];
  while (cursor <= last && dates.length < 200) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return dates;
}

function formatDatumShort(date) {
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

document.getElementById('eventForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('eventId').value;
  const title = document.getElementById('eventTitle').value;
  const categoryId = parseInt(document.getElementById('eventCategory').value);
  const description = document.getElementById('eventDescription').value;
  const location = document.getElementById('eventLocation').value;

  try {
    if (eventMode === 'series' && !id) {
      const result = await API.createSeries({
        title,
        category_id: categoryId,
        weekday: parseInt(document.getElementById('seriesWeekday').value),
        time_from: document.getElementById('seriesTimeFrom').value,
        time_to: document.getElementById('seriesTimeTo').value,
        date_from: document.getElementById('seriesDateFrom').value,
        date_to: document.getElementById('seriesDateTo').value,
        description,
        location,
      });
      showToast(`${result.serie.anzahl} Termine erstellt`);
    } else {
      const data = {
        title,
        category_id: categoryId,
        start_time: new Date(document.getElementById('eventStart').value).toISOString(),
        end_time: new Date(document.getElementById('eventEnd').value).toISOString(),
        all_day: document.getElementById('eventAllDay').checked,
        description,
        location,
      };
      if (id) {
        await API.updateEvent(id, data);
        showToast('Termin aktualisiert');
      } else {
        await API.createEvent(data);
        showToast('Termin erstellt');
      }
    }
    resetEventForm();
    await loadEvents();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function editEvent(id) {
  try {
    const t = await API.request('GET', `/api/events/${id}`);

    // Editing always works on a single event — a series is managed in its own dialog.
    setEventMode('single');
    document.getElementById('eventModeSwitch').style.display = 'none';

    document.getElementById('eventId').value = t.id;
    document.getElementById('eventTitle').value = t.titel;
    document.getElementById('eventCategory').value = t.farbe; // category_id as string
    document.getElementById('eventStart').value = toLocalDatetime(new Date(t.start).toISOString());
    document.getElementById('eventEnd').value = toLocalDatetime(new Date(t.ende).toISOString());
    document.getElementById('eventAllDay').checked = t.ganztaegig;
    document.getElementById('eventDescription').value = t.beschreibung;
    document.getElementById('eventLocation').value = t.ort;

    document.getElementById('eventFormTitle').textContent = 'Termin bearbeiten';
    document.getElementById('eventSubmitBtn').textContent = 'Termin aktualisieren';
    document.getElementById('eventCancelBtn').style.display = '';

    document.getElementById('eventFormSection').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteEvent(id) {
  const event = events.find(e => e.id === id);
  const title = event ? event.titel : '';
  if (!confirm(`Termin "${title}" wirklich löschen?`)) return;

  try {
    await API.deleteEvent(id);
    showToast('Termin gelöscht');
    await loadEvents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function resetEventForm() {
  document.getElementById('eventForm').reset();
  document.getElementById('eventId').value = '';
  document.getElementById('eventModeSwitch').style.display = '';
  document.getElementById('eventFormTitle').textContent = 'Neuen Termin erstellen';
  document.getElementById('eventCancelBtn').style.display = 'none';
  setEventMode('single');
}

// ============ SERIEN-DETAIL ============

let openSeries = null;

async function openSeriesModal(seriesId) {
  try {
    openSeries = await API.getSeries(seriesId);
    renderSeriesModal();
    document.getElementById('seriesModal').style.display = '';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function closeSeriesModal() {
  document.getElementById('seriesModal').style.display = 'none';
  openSeries = null;
}

function renderSeriesModal() {
  const { serie, termine } = openSeries;

  document.getElementById('seriesModalTitle').textContent = serie.titel;
  document.getElementById('seriesModalSubtitle').textContent =
    `${WEEKDAY_ADVERBS[serie.wochentag]} ${serie.zeitVon}–${serie.zeitBis} Uhr · ` +
    `${formatDatum(serie.datumVon)} – ${formatDatum(serie.datumBis)} · ${serie.anzahl} Termine`;

  document.getElementById('seriesEditTitle').value = serie.titel;
  document.getElementById('seriesEditTimeFrom').value = serie.zeitVon;
  document.getElementById('seriesEditTimeTo').value = serie.zeitBis;

  const catSelect = document.getElementById('seriesEditCategory');
  catSelect.innerHTML = bearbeitbareKategorien().map(c =>
    `<option value="${c.id}">${escapeHtml(c.name)}</option>`
  ).join('');
  catSelect.value = serie.category_id;

  const wdSelect = document.getElementById('seriesEditWeekday');
  wdSelect.innerHTML = WEEKDAY_NAMES.map((name, i) =>
    `<option value="${i}">${escapeHtml(name)}</option>`
  ).join('');
  wdSelect.value = String(serie.wochentag);

  document.getElementById('seriesEventsBody').innerHTML = termine.map(t => {
    const start = new Date(t.start);
    const end = new Date(t.ende);
    return `
      <tr class="${t.abweichend ? 'deviating' : ''}">
        <td>${escapeHtml(formatWeekdayDate(start))}${t.abweichend ? '<span class="deviating-badge">abweichend</span>' : ''}</td>
        <td><input type="time" value="${escapeHtml(toTimeValue(start))}" onchange="updateOccurrenceTime(${t.id}, this.value, null)"></td>
        <td><input type="time" value="${escapeHtml(toTimeValue(end))}" onchange="updateOccurrenceTime(${t.id}, null, this.value)"></td>
        <td class="actions">
          <button class="btn-icon" title="Diesen Termin löschen" onclick="deleteOccurrence(${t.id})">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');
}

function formatWeekdayDate(date) {
  return date.toLocaleDateString('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function toTimeValue(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Changes the time of a single occurrence. The date is kept and only the
 * wall-clock time replaced, so the event stays on its day of the series.
 */
async function updateOccurrenceTime(eventId, newFrom, newTo) {
  const t = openSeries.termine.find(x => x.id === eventId);
  if (!t) return;

  const start = new Date(t.start);
  const end = new Date(t.ende);

  if (newFrom) {
    const [h, m] = newFrom.split(':').map(Number);
    start.setHours(h, m, 0, 0);
  }
  if (newTo) {
    const [h, m] = newTo.split(':').map(Number);
    end.setHours(h, m, 0, 0);
  }

  if (end <= start) {
    showToast('Endzeit muss nach Startzeit liegen', 'error');
    renderSeriesModal();
    return;
  }

  try {
    await API.updateEvent(eventId, {
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    });
    showToast('Termin angepasst');
    openSeries = await API.getSeries(openSeries.serie.id);
    renderSeriesModal();
    await loadEvents();
  } catch (err) {
    showToast(err.message, 'error');
    renderSeriesModal();
  }
}

async function deleteOccurrence(eventId) {
  const t = openSeries.termine.find(x => x.id === eventId);
  if (!t) return;
  if (!confirm(`Termin am ${formatWeekdayDate(new Date(t.start))} löschen?\n\nDie übrigen Termine der Serie bleiben bestehen.`)) return;

  try {
    await API.deleteEvent(eventId);
    showToast('Termin gelöscht');
    openSeries = await API.getSeries(openSeries.serie.id);
    renderSeriesModal();
    await loadEvents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveSeriesHeader() {
  const serie = openSeries.serie;
  const newFrom = document.getElementById('seriesEditTimeFrom').value;
  const newTo = document.getElementById('seriesEditTimeTo').value;
  const timeChanged = newFrom !== serie.zeitVon || newTo !== serie.zeitBis;
  const newWeekday = parseInt(document.getElementById('seriesEditWeekday').value);
  const weekdayChanged = newWeekday !== serie.wochentag;
  const deviating = openSeries.termine.filter(t => t.abweichend).length;

  if (timeChanged && deviating > 0) {
    const ok = confirm(
      `${deviating} Termin(e) dieser Serie haben eine abweichende Uhrzeit.\n\n` +
      `Beim Übernehmen werden sie auf ${newFrom}–${newTo} Uhr zurückgesetzt.\n\nFortfahren?`
    );
    if (!ok) return;
  }

  if (weekdayChanged) {
    const ok = confirm(
      `Alle ${openSeries.termine.length} Termine der Serie werden von ${WEEKDAY_NAMES[serie.wochentag]} ` +
      `auf ${WEEKDAY_NAMES[newWeekday]} verschoben (jeweils in ihrer Woche). Die Uhrzeiten bleiben.\n\nFortfahren?`
    );
    if (!ok) return;
  }

  try {
    const data = {
      title: document.getElementById('seriesEditTitle').value,
      category_id: parseInt(document.getElementById('seriesEditCategory').value),
    };
    if (timeChanged) {
      data.time_from = newFrom;
      data.time_to = newTo;
    }
    if (weekdayChanged) data.weekday = newWeekday;
    openSeries = await API.updateSeries(serie.id, data);
    showToast('Serie aktualisiert');
    renderSeriesModal();
    await loadEvents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteWholeSeries() {
  const serie = openSeries.serie;
  if (!confirm(`Die ganze Serie "${serie.titel}" mit ${serie.anzahl} Terminen löschen?`)) return;

  try {
    await API.deleteEventSeries(serie.id);
    showToast('Terminserie gelöscht');
    closeSeriesModal();
    await loadEvents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============================================================
//  CATEGORIES
// ============================================================

async function loadCategories() {
  try {
    categories = await API.getCategories();

    // Populate event form dropdown — ein Eismeister sieht nur seine Kategorien
    const select = document.getElementById('eventCategory');
    select.innerHTML = bearbeitbareKategorien().map(c =>
      `<option value="${c.id}">${escapeHtml(c.name)}</option>`
    ).join('');

    // Populate table
    const tbody = document.getElementById('categoriesTableBody');
    tbody.innerHTML = categories.map(c => `
      <tr>
        <td><span class="color-preview" style="background:${escapeHtml(c.color_hex)}"></span></td>
        <td>${escapeHtml(c.name)}</td>
        <td>${c.sort_order}</td>
        <td>${c.group_by_title ? 'nach Titel' : 'gesamt'}</td>
        <td>${c.login_required ? '🔒 nur angemeldet' : 'öffentlich'}${c.eismeister_managed ? ' · Eismeister' : ''}</td>
        <td class="actions admin-only">
          <button class="btn-icon" title="Bearbeiten" onclick="editCategory(${c.id})">✏️</button>
          <button class="btn-icon" title="Löschen" onclick="deleteCategory(${c.id})">🗑️</button>
        </td>
      </tr>
    `).join('');

    rollenSichtbarkeitAnwenden();
  } catch (err) {
    showToast('Kategorien laden fehlgeschlagen: ' + err.message, 'error');
  }
}

document.getElementById('categoryForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('categoryId').value;
  const colorHex = document.getElementById('categoryColor').value;
  const data = {
    name: document.getElementById('categoryName').value,
    color_hex: colorHex,
    color_bg: hexToRgba(colorHex, 0.3),
    sort_order: parseInt(document.getElementById('categorySortOrder').value) || 0,
    group_by_title: document.getElementById('categoryGroupByTitle').checked,
    login_required: document.getElementById('categoryLoginRequired').checked,
    eismeister_managed: document.getElementById('categoryEismeisterManaged').checked,
  };

  try {
    if (id) {
      await API.updateCategory(id, data);
      showToast('Kategorie aktualisiert');
    } else {
      await API.createCategory(data);
      showToast('Kategorie erstellt');
    }
    resetCategoryForm();
    await loadCategories();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

function editCategory(id) {
  const cat = categories.find(c => c.id === id);
  if (!cat) return;

  document.getElementById('categoryId').value = cat.id;
  document.getElementById('categoryName').value = cat.name;
  document.getElementById('categoryColor').value = cat.color_hex;
  document.getElementById('categorySortOrder').value = cat.sort_order;
  document.getElementById('categoryGroupByTitle').checked = !!cat.group_by_title;
  document.getElementById('categoryLoginRequired').checked = !!cat.login_required;
  document.getElementById('categoryEismeisterManaged').checked = !!cat.eismeister_managed;

  document.getElementById('categoryFormTitle').textContent = 'Kategorie bearbeiten';
  document.getElementById('categorySubmitBtn').textContent = 'Kategorie aktualisieren';
  document.getElementById('categoryCancelBtn').style.display = '';

  document.getElementById('categoryFormSection').scrollIntoView({ behavior: 'smooth' });
}

async function deleteCategory(id) {
  const cat = categories.find(c => c.id === id);
  const name = cat ? cat.name : '';
  if (!confirm(`Kategorie "${name}" wirklich löschen?`)) return;

  try {
    await API.deleteCategory(id);
    showToast('Kategorie gelöscht');
    await loadCategories();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function resetCategoryForm() {
  document.getElementById('categoryForm').reset();
  document.getElementById('categoryId').value = '';
  document.getElementById('categoryColor').value = '#1a73e8';
  document.getElementById('categoryGroupByTitle').checked = false;
  document.getElementById('categoryLoginRequired').checked = false;
  document.getElementById('categoryEismeisterManaged').checked = false;
  document.getElementById('categoryFormTitle').textContent = 'Neue Kategorie erstellen';
  document.getElementById('categorySubmitBtn').textContent = 'Kategorie erstellen';
  document.getElementById('categoryCancelBtn').style.display = 'none';
}

// ============================================================
//  USERS (admin only)
// ============================================================

async function loadUsers() {
  if (!currentUser || currentUser.role !== 'admin') return;

  try {
    users = await API.getUsers();
    const tbody = document.getElementById('usersTableBody');

    // Inline handlers receive only numeric ids; username/display_name are
    // looked up from `users` in the handler, never injected into attributes.
    tbody.innerHTML = users.map(u => `
      <tr>
        <td>${u.id}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.display_name)}</td>
        <td>${ROLLEN_ANZEIGE[u.role] || escapeHtml(u.role)}</td>
        <td class="actions">
          <button class="btn-icon" title="Bearbeiten" onclick="editUser(${u.id})">✏️</button>
          ${u.id !== currentUser.id ? `<button class="btn-icon" title="Löschen" onclick="deleteUser(${u.id})">🗑️</button>` : ''}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('Benutzer laden fehlgeschlagen: ' + err.message, 'error');
  }
}

document.getElementById('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('userId').value;
  const data = {
    username: document.getElementById('userUsername').value,
    display_name: document.getElementById('userDisplayName').value,
    role: document.getElementById('userRole').value,
  };

  const password = document.getElementById('userPassword').value;
  if (password) {
    data.password = password;
  } else if (!id) {
    showToast('Passwort ist für neue Benutzer erforderlich', 'error');
    return;
  }

  try {
    if (id) {
      await API.updateUser(id, data);
      showToast('Benutzer aktualisiert');
    } else {
      await API.createUser(data);
      showToast('Benutzer erstellt');
    }
    resetUserForm();
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

function editUser(id) {
  const user = users.find(u => u.id === id);
  if (!user) return;

  document.getElementById('userId').value = user.id;
  document.getElementById('userUsername').value = user.username;
  document.getElementById('userDisplayName').value = user.display_name;
  document.getElementById('userRole').value = user.role;
  document.getElementById('userPassword').value = '';
  document.getElementById('userPassword').required = false;
  document.getElementById('userPassword').placeholder = 'Leer lassen = nicht ändern';

  document.getElementById('userFormTitle').textContent = 'Benutzer bearbeiten';
  document.getElementById('userSubmitBtn').textContent = 'Benutzer aktualisieren';
  document.getElementById('userCancelBtn').style.display = '';
}

async function deleteUser(id) {
  const user = users.find(u => u.id === id);
  const username = user ? user.username : '';
  if (!confirm(`Benutzer "${username}" wirklich löschen?`)) return;

  try {
    await API.deleteUser(id);
    showToast('Benutzer gelöscht');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============================================================
//  STATS / ABRECHNUNG
// ============================================================

// Vorauswahl entsprechend dem alten Abrechnungs-Tool:
// STB, Hobbies, ECB, Vermietung, öffentliche Laufzeit
const STATS_DEFAULT_CATEGORY_IDS = [2, 5, 7, 8, 11];

let lastStats = null;

function initStats() {
  // Kategorie-Checkboxen aus den geladenen Kategorien aufbauen
  const container = document.getElementById('statsCategories');
  container.innerHTML = categories.map(c => `
    <label class="stats-cat">
      <input type="checkbox" value="${c.id}" ${STATS_DEFAULT_CATEGORY_IDS.includes(c.id) ? 'checked' : ''}>
      <span class="color-preview" style="background:${escapeHtml(c.color_hex)}"></span>${escapeHtml(c.name)}
    </label>
  `).join('');

  // Zeitraum-Presets
  document.getElementById('statsPresetMonth').addEventListener('click', () => setStatsRange(0));
  document.getElementById('statsPresetLastMonth').addEventListener('click', () => setStatsRange(-1));
  document.getElementById('statsPresetYear').addEventListener('click', () => {
    const now = new Date();
    document.getElementById('statsStart').value = `${now.getFullYear()}-01-01`;
    document.getElementById('statsEnd').value = `${now.getFullYear()}-12-31`;
  });

  // Standard: aktueller Monat (Abrechnungsrhythmus des alten Tools)
  setStatsRange(0);

  document.getElementById('statsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await runStats();
  });
  document.getElementById('statsCsvBtn').addEventListener('click', exportStatsCsv);
}

function setStatsRange(monthOffset) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const last = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0);
  // toLocalDate is timezone-correct, so no offset compensation is needed here
  document.getElementById('statsStart').value = toLocalDate(first);
  document.getElementById('statsEnd').value = toLocalDate(last);
}

function formatDauer(minuten) {
  const stunden = Math.floor(minuten / 60);
  const min = Math.round(minuten % 60);
  if (stunden === 0) return `${min} Min`;
  if (min === 0) return `${stunden} Std`;
  return `${stunden} Std ${min} Min`;
}

async function runStats() {
  const start = document.getElementById('statsStart').value;
  const end = document.getElementById('statsEnd').value;
  const ids = Array.from(document.querySelectorAll('#statsCategories input:checked')).map(cb => cb.value);

  if (!start || !end) {
    showToast('Bitte Zeitraum auswählen', 'error');
    return;
  }
  if (ids.length === 0) {
    showToast('Bitte mindestens eine Kategorie auswählen', 'error');
    return;
  }

  const startISO = new Date(start).toISOString();
  const endDate = new Date(end);
  endDate.setDate(endDate.getDate() + 1); // Enddatum inklusive
  const endISO = endDate.toISOString();

  try {
    const result = await API.request(
      'GET',
      `/api/stats?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}&category_ids=${ids.join(',')}`
    );
    lastStats = result;
    renderStats(result, start, end);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderStats(result, start, end) {
  const summary = document.getElementById('statsSummary');
  // Die Bruttosumme nur zeigen, wenn sie abweicht — sonst wäre sie eine
  // verwirrende Dopplung. Die Differenz ist genau die Zeit, in der mehrere
  // Einheiten gleichzeitig auf dem Eis waren.
  const brutto = result.gesamt.dauerBruttoMinuten;
  const bruttoKarte = (brutto != null && Math.round(brutto) !== Math.round(result.gesamt.dauerMinuten))
    ? `<div class="stats-card"><div class="stats-label">Summe der Einheiten</div><div class="stats-value">${escapeHtml(formatDauer(brutto))}</div></div>`
    : '';
  summary.innerHTML = `
    <div class="stats-card"><div class="stats-label">Zeitraum</div><div class="stats-value">${escapeHtml(formatDatum(start))} – ${escapeHtml(formatDatum(end))}</div></div>
    <div class="stats-card"><div class="stats-label">Analysierte Termine</div><div class="stats-value">${result.gesamt.anzahl}</div></div>
    <div class="stats-card"><div class="stats-label">Belegte Hallenzeit</div><div class="stats-value">${escapeHtml(formatDauer(result.gesamt.dauerMinuten))}</div></div>
    ${bruttoKarte}
  `;

  const rows = [];
  for (const g of result.gruppen) {
    rows.push(`
      <tr>
        <td><span class="color-preview" style="background:${escapeHtml(g.color_hex)}"></span>${escapeHtml(g.name)}</td>
        <td style="text-align:right">${g.anzahl}</td>
        <td style="text-align:right"><strong>${escapeHtml(formatDauer(g.dauerMinuten))}</strong></td>
        <td style="text-align:right">${escapeHtml(formatDauer((g.dauerBruttoMinuten ?? g.dauerMinuten) / g.anzahl))}</td>
      </tr>
    `);
    if (g.titel) {
      for (const t of g.titel) {
        rows.push(`
          <tr class="stats-subrow">
            <td style="padding-left:28px">↳ ${escapeHtml(t.titel)}</td>
            <td style="text-align:right">${t.anzahl}</td>
            <td style="text-align:right">${escapeHtml(formatDauer(t.dauerMinuten))}</td>
            <td style="text-align:right">${escapeHtml(formatDauer(t.dauerMinuten / t.anzahl))}</td>
          </tr>
        `);
      }
    }
  }

  document.getElementById('statsTableBody').innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="4" style="text-align:center;color:#999">Keine Termine mit den gewählten Kategorien im Zeitraum</td></tr>';

  renderUeberschneidungen(result.ueberschneidungen);

  document.getElementById('statsResult').style.display = '';
  document.getElementById('statsCsvBtn').style.display = rows.length ? '' : 'none';
}

// Zeigt gleichzeitige Termine an. Für die abgerechnete Zeit sind sie
// unschädlich (die zählt jede belegte Minute einmal), aber der Hinweis macht
// sichtbar, welche Einheiten parallel laufen — etwa gemeinsame Trainings
// mehrerer Mannschaften.
function renderUeberschneidungen(ueb) {
  const box = document.getElementById('statsUeberschneidungen');
  if (!box) return;

  if (!ueb || !ueb.anzahl) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }

  const faelle = ueb.faelle.map(f => `
    <li>
      ${escapeHtml(formatDatum(f.datum))}:
      <strong>${escapeHtml(f.titelA)}</strong> und <strong>${escapeHtml(f.titelB)}</strong>
      — ${escapeHtml(formatDauer(f.minuten))} gleichzeitig
    </li>
  `).join('');

  const weitere = ueb.weitere
    ? `<li>… und ${ueb.weitere} weitere</li>`
    : '';

  box.innerHTML = `
    <strong>⚠ ${ueb.anzahl} zeitliche Überschneidung${ueb.anzahl === 1 ? '' : 'en'}
    (${escapeHtml(formatDauer(ueb.minuten))})</strong>
    <p>Die belegte Hallenzeit oben zählt diese Zeit nur einmal. Häufigste Ursache:
    parallele Trainings, etwa gemeinsame Einheiten mehrerer Mannschaften.</p>
    <ul>${faelle}${weitere}</ul>
  `;
  box.style.display = '';
}

function formatDatum(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

function exportStatsCsv() {
  if (!lastStats) return;

  const lines = ['Kategorie;Titel;Anzahl;Belegte Zeit (Minuten);Belegte Zeit (formatiert)'];
  for (const g of lastStats.gruppen) {
    lines.push(`${csvEscape(g.name)};;${g.anzahl};${Math.round(g.dauerMinuten)};${csvEscape(formatDauer(g.dauerMinuten))}`);
    if (g.titel) {
      for (const t of g.titel) {
        lines.push(`${csvEscape(g.name)};${csvEscape(t.titel)};${t.anzahl};${Math.round(t.dauerMinuten)};${csvEscape(formatDauer(t.dauerMinuten))}`);
      }
    }
  }
  lines.push(`Gesamt;;${lastStats.gesamt.anzahl};${Math.round(lastStats.gesamt.dauerMinuten)};${csvEscape(formatDauer(lastStats.gesamt.dauerMinuten))}`);

  // BOM für korrekte Umlaute in Excel; Semikolon als Trenner (deutsches Excel)
  const BOM = String.fromCharCode(0xFEFF);
  const blob = new Blob([BOM + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `abrechnung_${document.getElementById('statsStart').value}_${document.getElementById('statsEnd').value}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvEscape(value) {
  const s = String(value);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function resetUserForm() {
  document.getElementById('userForm').reset();
  document.getElementById('userId').value = '';
  document.getElementById('userPassword').required = true;
  document.getElementById('userPassword').placeholder = '';
  document.getElementById('userFormTitle').textContent = 'Neuen Benutzer erstellen';
  document.getElementById('userSubmitBtn').textContent = 'Benutzer erstellen';
  document.getElementById('userCancelBtn').style.display = 'none';
}

// ============================================================
//  EIGENES PASSWORT ÄNDERN (alle Rollen)
// ============================================================

function initPasswordModal() {
  document.getElementById('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const aktuell = document.getElementById('pwCurrent').value;
    const neu = document.getElementById('pwNew').value;

    if (neu !== document.getElementById('pwRepeat').value) {
      showToast('Die beiden neuen Passwörter stimmen nicht überein', 'error');
      return;
    }

    try {
      await API.changePassword(aktuell, neu);
      showToast('Passwort geändert');
      closePasswordModal();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Klick auf den Hintergrund schließt den Dialog
  document.getElementById('passwordModal').addEventListener('click', (e) => {
    if (e.target.id === 'passwordModal') closePasswordModal();
  });
}

function openPasswordModal() {
  document.getElementById('passwordForm').reset();
  document.getElementById('passwordModal').style.display = '';
  document.getElementById('pwCurrent').focus();
}

function closePasswordModal() {
  document.getElementById('passwordModal').style.display = 'none';
  // Eingegebene Passwörter nicht im DOM stehen lassen
  document.getElementById('passwordForm').reset();
}

// ============================================================
//  TERMINE IM ZEITRAUM LÖSCHEN (admin only)
// ============================================================

// Letzte Vorschau. Löschen ist nur mit gültiger Vorschau möglich; jede Änderung
// an Zeitraum oder Auswahl setzt sie zurück, damit nie etwas anderes gelöscht
// wird als das, was angezeigt wurde.
let bulkVorschau = null;

function initBulkDelete() {
  // Alle Kategorien vorausgewählt — abwählen ist die bewusste Einschränkung
  document.getElementById('bulkCategories').innerHTML = categories.map(c => `
    <label class="stats-cat">
      <input type="checkbox" value="${c.id}" checked>
      <span class="color-preview" style="background:${escapeHtml(c.color_hex)}"></span>${escapeHtml(c.name)}
    </label>
  `).join('');

  const form = document.getElementById('bulkDeleteForm');
  form.addEventListener('input', bulkVorschauVerwerfen);
  form.addEventListener('change', bulkVorschauVerwerfen);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await bulkVorschauHolen();
  });
}

function bulkAuswahl() {
  return {
    date_from: document.getElementById('bulkFrom').value,
    date_to: document.getElementById('bulkTo').value,
    category_ids: Array.from(document.querySelectorAll('#bulkCategories input:checked'))
      .map(cb => parseInt(cb.value)),
  };
}

function bulkVorschauVerwerfen() {
  bulkVorschau = null;
  document.getElementById('bulkDeleteBtn').disabled = true;
  document.getElementById('bulkPreview').style.display = 'none';
}

async function bulkVorschauHolen() {
  const auswahl = bulkAuswahl();
  if (auswahl.category_ids.length === 0) {
    showToast('Bitte mindestens eine Kategorie auswählen', 'error');
    return;
  }

  try {
    const ergebnis = await API.bulkDeleteEvents(auswahl, true);
    bulkVorschau = { auswahl, ergebnis };
    zeigeBulkVorschau(ergebnis);
    document.getElementById('bulkDeleteBtn').disabled = ergebnis.anzahl === 0;
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function zeigeBulkVorschau(e) {
  const box = document.getElementById('bulkPreview');
  box.style.display = '';

  if (e.anzahl === 0) {
    box.innerHTML = '<p>Im Zeitraum liegen keine Termine der gewählten Kategorien.</p>';
    return;
  }

  const kategorien = e.nachKategorie
    .map(k => `<li>${escapeHtml(k.name)}: ${k.anzahl}</li>`).join('');
  const hinweise = [];
  if (e.serienBetroffen) hinweise.push(`${e.serienBetroffen} Serie(n) betroffen`);
  if (e.ausHallenplanung) hinweise.push(`${e.ausHallenplanung} Spiel(e) aus Hallenplanung`);
  const einzeln = e.details
    .map(d => `<li>${escapeHtml(formatDatetime(d.start))} · ${escapeHtml(d.titel)} <small>(${escapeHtml(d.kategorie)})</small></li>`)
    .join('');
  const rest = e.anzahl > e.details.length ? `<li>… und ${e.anzahl - e.details.length} weitere</li>` : '';

  box.innerHTML = `
    <p><strong>${e.anzahl} Termine</strong> würden gelöscht${hinweise.length ? ' — ' + escapeHtml(hinweise.join(', ')) : ''}.</p>
    <ul>${kategorien}</ul>
    <details><summary>Einzelne Termine anzeigen</summary><ul>${einzeln}${rest}</ul></details>
  `;
}

async function bulkDeleteAusfuehren() {
  if (!bulkVorschau) return;
  const { auswahl, ergebnis } = bulkVorschau;

  const folgen = [
    'Das lässt sich nicht rückgängig machen. Vorher ein Backup der Datenbank ziehen.',
    'Die Bridge entfernt die Termine beim nächsten Lauf auch aus den Google-Kalendern; aus den Kalender-Feeds verschwinden sie sofort.',
  ];
  if (ergebnis.ausHallenplanung) {
    folgen.push(`${ergebnis.ausHallenplanung} Spiel(e) stammen aus Hallenplanung und erscheinen beim nächsten Veröffentlichen wieder.`);
  }

  if (!confirm(
    `${ergebnis.anzahl} Termine von ${formatDatum(auswahl.date_from)} bis ${formatDatum(auswahl.date_to)} löschen?\n\n` +
    folgen.map(f => '• ' + f).join('\n')
  )) return;

  try {
    const res = await API.bulkDeleteEvents(auswahl, false);
    showToast(`${res.anzahl} Termine gelöscht`);
    bulkVorschauVerwerfen();
    await loadEvents();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============================================================
//  SYNC-TOKENS (admin only)
// ============================================================

let syncTokens = [];

async function loadSyncTokens() {
  if (!currentUser || currentUser.role !== 'admin') return;

  try {
    syncTokens = await API.getSyncTokens();
    const tbody = document.getElementById('syncTokensTableBody');

    if (syncTokens.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999">Noch kein Token angelegt</td></tr>';
      return;
    }

    // Nur die numerische ID landet im Handler; die Bezeichnung wird beim
    // Widerrufen aus `syncTokens` nachgeschlagen.
    tbody.innerHTML = syncTokens.map(t => `
      <tr>
        <td>${escapeHtml(t.label)}</td>
        <td><code>${escapeHtml(t.prefix)}…</code></td>
        <td>${escapeHtml(t.created_by_name || '—')}</td>
        <td>${formatDatetime(t.created_at)}</td>
        <td>${t.last_used_at ? formatDatetime(t.last_used_at) : 'nie'}</td>
        <td class="actions">
          <button class="btn-icon" title="Widerrufen" onclick="deleteSyncToken(${t.id})">🗑️</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('Sync-Tokens laden fehlgeschlagen: ' + err.message, 'error');
  }
}

document.getElementById('syncTokenForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = document.getElementById('syncTokenLabel').value;

  try {
    const neu = await API.createSyncToken(label);
    // Einzige Gelegenheit, den Klartext zu sehen — gespeichert ist nur der Hash.
    document.getElementById('syncTokenValue').textContent = neu.token;
    document.getElementById('syncTokenResult').style.display = '';
    document.getElementById('syncTokenForm').reset();
    showToast('Token erstellt');
    await loadSyncTokens();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function kopiereSyncToken() {
  const wert = document.getElementById('syncTokenValue').textContent;
  try {
    await navigator.clipboard.writeText(wert);
    showToast('Token in die Zwischenablage kopiert');
  } catch (err) {
    showToast('Kopieren nicht möglich — Wert von Hand markieren', 'error');
  }
}

function verbergeSyncToken() {
  document.getElementById('syncTokenResult').style.display = 'none';
  document.getElementById('syncTokenValue').textContent = '';
}

async function deleteSyncToken(id) {
  const token = syncTokens.find(t => t.id === id);
  const label = token ? token.label : '';
  if (!confirm(
    `Token "${label}" widerrufen?\n\n` +
    'Der Rechner, auf dem es eingetragen ist, kann danach nicht mehr veröffentlichen, ' +
    'bis dort ein neues Token hinterlegt wird.'
  )) return;

  try {
    await API.deleteSyncToken(id);
    showToast('Token widerrufen');
    await loadSyncTokens();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
