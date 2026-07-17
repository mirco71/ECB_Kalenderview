/**
 * Admin panel logic — manages events, categories, and users.
 */

let currentUser = null;
let categories = [];

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
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
    const tbody = document.getElementById('eventsTableBody');

    if (result.termine.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999">Keine Termine im gewählten Zeitraum</td></tr>';
      return;
    }

    tbody.innerHTML = result.termine.map(t => `
      <tr>
        <td>${escapeHtml(t.titel)}</td>
        <td><span class="color-preview" style="background:${t.farbHex}"></span>${escapeHtml(t.farbName)}</td>
        <td>${formatDatetime(new Date(t.start).toISOString())}</td>
        <td>${formatDatetime(new Date(t.ende).toISOString())}</td>
        <td>${t.ganztaegig ? '✅' : ''}</td>
        <td>${t.series_id ? '🔁' : ''}</td>
        <td class="actions">
          <button class="btn-icon" title="Bearbeiten" onclick="editEvent(${t.id})">✏️</button>
          <button class="btn-icon" title="Löschen" onclick="deleteEvent(${t.id}, '${escapeHtml(t.titel)}', ${t.series_id ? `'${t.series_id}'` : 'null'})">🗑️</button>
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

async function deleteEvent(id, title, seriesId) {
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
        <td><span class="color-preview" style="background:${c.color_hex}"></span></td>
        <td>${escapeHtml(c.name)}</td>
        <td>${c.sort_order}</td>
        <td class="actions admin-only">
          <button class="btn-icon" title="Bearbeiten" onclick="editCategory(${c.id})">✏️</button>
          <button class="btn-icon" title="Löschen" onclick="deleteCategory(${c.id}, '${escapeHtml(c.name)}')">🗑️</button>
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

  document.getElementById('categoryFormTitle').textContent = 'Kategorie bearbeiten';
  document.getElementById('categorySubmitBtn').textContent = 'Kategorie aktualisieren';
  document.getElementById('categoryCancelBtn').style.display = '';

  document.getElementById('categoryFormSection').scrollIntoView({ behavior: 'smooth' });
}

async function deleteCategory(id, name) {
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
    const users = await API.getUsers();
    const tbody = document.getElementById('usersTableBody');

    tbody.innerHTML = users.map(u => `
      <tr>
        <td>${u.id}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.display_name)}</td>
        <td>${u.role === 'admin' ? '👑 Admin' : '✏️ Editor'}</td>
        <td class="actions">
          <button class="btn-icon" title="Bearbeiten" onclick="editUser(${u.id}, '${escapeHtml(u.username)}', '${escapeHtml(u.display_name)}', '${u.role}')">✏️</button>
          ${u.id !== currentUser.id ? `<button class="btn-icon" title="Löschen" onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')">🗑️</button>` : ''}
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

function editUser(id, username, displayName, role) {
  document.getElementById('userId').value = id;
  document.getElementById('userUsername').value = username;
  document.getElementById('userDisplayName').value = displayName;
  document.getElementById('userRole').value = role;
  document.getElementById('userPassword').value = '';
  document.getElementById('userPassword').required = false;
  document.getElementById('userPassword').placeholder = 'Leer lassen = nicht ändern';

  document.getElementById('userFormTitle').textContent = 'Benutzer bearbeiten';
  document.getElementById('userSubmitBtn').textContent = 'Benutzer aktualisieren';
  document.getElementById('userCancelBtn').style.display = '';
}

async function deleteUser(id, username) {
  if (!confirm(`Benutzer "${username}" wirklich löschen?`)) return;

  try {
    await API.deleteUser(id);
    showToast('Benutzer gelöscht');
    await loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
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
