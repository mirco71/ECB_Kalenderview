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

  // Hide admin-only elements for editors
  if (currentUser.role !== 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = 'none';
    });
  }

  // Set default filter dates: current week
  const now = new Date();
  const monday = getMondayOfWeek(now);
  const nextSunday = new Date(monday);
  nextSunday.setDate(nextSunday.getDate() + 13); // 2 weeks ahead
  document.getElementById('eventFilterStart').value = toLocalDate(monday);
  document.getElementById('eventFilterEnd').value = toLocalDate(nextSunday);

  // Load data
  await loadCategories();
  await loadEvents();
  if (currentUser.role === 'admin') {
    await loadUsers();
  }

  initStats();
});

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
  return date.toISOString().split('T')[0];
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

async function loadEvents() {
  const start = document.getElementById('eventFilterStart').value;
  const end = document.getElementById('eventFilterEnd').value;

  if (!start || !end) return;

  const startISO = new Date(start).toISOString();
  const endDate = new Date(end);
  endDate.setDate(endDate.getDate() + 1);
  const endISO = endDate.toISOString();

  try {
    const result = await API.getEvents(startISO, endISO);
    events = result.termine;
    const tbody = document.getElementById('eventsTableBody');

    if (events.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999">Keine Termine im gewählten Zeitraum</td></tr>';
      return;
    }

    // Only numeric ids are interpolated into the inline handlers; all
    // user-controlled strings are looked up from `events` inside the handler,
    // never injected into HTML attributes.
    tbody.innerHTML = events.map(t => `
      <tr>
        <td>${escapeHtml(t.titel)}</td>
        <td><span class="color-preview" style="background:${escapeHtml(t.farbHex)}"></span>${escapeHtml(t.farbName)}</td>
        <td>${formatDatetime(new Date(t.start).toISOString())}</td>
        <td>${formatDatetime(new Date(t.ende).toISOString())}</td>
        <td>${t.ganztaegig ? '✅' : ''}</td>
        <td>${t.series_id ? '🔁' : ''}</td>
        <td class="actions">
          <button class="btn-icon" title="Bearbeiten" onclick="editEvent(${t.id})">✏️</button>
          <button class="btn-icon" title="Löschen" onclick="deleteEvent(${t.id})">🗑️</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('Fehler beim Laden: ' + err.message, 'error');
  }
}

document.getElementById('eventForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('eventId').value;
  const data = {
    title: document.getElementById('eventTitle').value,
    category_id: parseInt(document.getElementById('eventCategory').value),
    start_time: new Date(document.getElementById('eventStart').value).toISOString(),
    end_time: new Date(document.getElementById('eventEnd').value).toISOString(),
    all_day: document.getElementById('eventAllDay').checked,
    description: document.getElementById('eventDescription').value,
    location: document.getElementById('eventLocation').value,
  };

  try {
    if (id) {
      await API.updateEvent(id, data);
      showToast('Termin aktualisiert');
    } else {
      const repeatUntil = document.getElementById('eventRepeatUntil').value;
      if (repeatUntil) {
        const startDate = new Date(document.getElementById('eventStart').value);
        const untilDate = new Date(repeatUntil);
        if (untilDate <= startDate) {
          showToast('Enddatum der Wiederholung muss nach dem Startdatum liegen', 'error');
          return;
        }
        const diffMs = untilDate.getTime() - startDate.getTime();
        const diffWeeks = Math.ceil(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
        const repeatWeeks = Math.min(Math.max(diffWeeks, 2), 52);
        data.repeat_weeks = repeatWeeks;
      }
      const result = await API.createEvent(data);
      if (result.count && result.count > 1) {
        showToast(`${result.count} Termine erstellt (Wochenserie)`);
      } else {
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
    document.getElementById('repeatRow').style.display = 'none';

    document.getElementById('eventFormSection').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteEvent(id) {
  const event = events.find(e => e.id === id);
  if (!event) return;
  const title = event.titel;
  const seriesId = event.series_id;

  if (seriesId) {
    const choice = prompt(
      `Termin "${title}" gehört zu einer Serie.\n\n` +
      `Eingabe:\n` +
      `  1 = Nur diesen Termin löschen\n` +
      `  2 = Ganze Serie löschen\n` +
      `  (Abbrechen = nichts tun)`
    );
    if (choice === '1') {
      try {
        await API.deleteEvent(id);
        showToast('Termin gelöscht');
        await loadEvents();
      } catch (err) {
        showToast(err.message, 'error');
      }
    } else if (choice === '2') {
      try {
        await API.deleteEventSeries(seriesId);
        showToast('Terminserie gelöscht');
        await loadEvents();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  } else {
    if (!confirm(`Termin "${title}" wirklich löschen?`)) return;
    try {
      await API.deleteEvent(id);
      showToast('Termin gelöscht');
      await loadEvents();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
}

function resetEventForm() {
  document.getElementById('eventForm').reset();
  document.getElementById('eventId').value = '';
  document.getElementById('eventRepeatUntil').value = '';
  document.getElementById('repeatRow').style.display = '';
  document.getElementById('eventFormTitle').textContent = 'Neuen Termin erstellen';
  document.getElementById('eventSubmitBtn').textContent = 'Termin erstellen';
  document.getElementById('eventCancelBtn').style.display = 'none';
}

// ============================================================
//  CATEGORIES
// ============================================================

async function loadCategories() {
  try {
    categories = await API.getCategories();

    // Populate event form dropdown
    const select = document.getElementById('eventCategory');
    select.innerHTML = categories.map(c =>
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
        <td class="actions admin-only">
          <button class="btn-icon" title="Bearbeiten" onclick="editCategory(${c.id})">✏️</button>
          <button class="btn-icon" title="Löschen" onclick="deleteCategory(${c.id})">🗑️</button>
        </td>
      </tr>
    `).join('');

    // Hide admin-only if editor
    if (currentUser && currentUser.role !== 'admin') {
      document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = 'none';
      });
    }
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
        <td>${u.role === 'admin' ? '👑 Admin' : '✏️ Editor'}</td>
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
  document.getElementById('statsStart').value = toLocalDate(new Date(first.getTime() - first.getTimezoneOffset() * 60000));
  document.getElementById('statsEnd').value = toLocalDate(new Date(last.getTime() - last.getTimezoneOffset() * 60000));
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
  summary.innerHTML = `
    <div class="stats-card"><div class="stats-label">Zeitraum</div><div class="stats-value">${escapeHtml(formatDatum(start))} – ${escapeHtml(formatDatum(end))}</div></div>
    <div class="stats-card"><div class="stats-label">Analysierte Termine</div><div class="stats-value">${result.gesamt.anzahl}</div></div>
    <div class="stats-card"><div class="stats-label">Gesamtdauer</div><div class="stats-value">${escapeHtml(formatDauer(result.gesamt.dauerMinuten))}</div></div>
  `;

  const rows = [];
  for (const g of result.gruppen) {
    rows.push(`
      <tr>
        <td><span class="color-preview" style="background:${escapeHtml(g.color_hex)}"></span>${escapeHtml(g.name)}</td>
        <td style="text-align:right">${g.anzahl}</td>
        <td style="text-align:right"><strong>${escapeHtml(formatDauer(g.dauerMinuten))}</strong></td>
        <td style="text-align:right">${escapeHtml(formatDauer(g.dauerMinuten / g.anzahl))}</td>
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

  document.getElementById('statsResult').style.display = '';
  document.getElementById('statsCsvBtn').style.display = rows.length ? '' : 'none';
}

function formatDatum(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

function exportStatsCsv() {
  if (!lastStats) return;

  const lines = ['Kategorie;Titel;Anzahl;Dauer (Minuten);Dauer (formatiert)'];
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
