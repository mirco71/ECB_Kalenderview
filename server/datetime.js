/**
 * Date/time helpers for weekly series.
 *
 * All calculations run in the server's local timezone, which is pinned to
 * Europe/Berlin via the TZ env var (Dockerfile / docker-compose.yml). That
 * matters: a series is defined as "tuesdays 18:00–20:00", which is wall-clock
 * local time. Computing it in UTC would shift every event by the offset and
 * would not follow the DST change that falls in the middle of a winter season.
 * Events are still stored absolutely (toISOString → UTC) — only the generation
 * is local.
 */

/** Formats a Date as a local YYYY-MM-DD string (not UTC — unlike toISOString). */
function toLocalDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Formats a Date as a local HH:MM string. */
function toLocalTimeString(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

/**
 * Builds a local Date from a YYYY-MM-DD date and an HH:MM time.
 * Deliberately uses the Date(y, m, d, h, min) constructor rather than parsing
 * an ISO string, because the latter would be interpreted as UTC.
 */
function localDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0);
}

/** Hard cap on generated events, so a typo in the end date cannot flood the DB. */
const MAX_SERIES_EVENTS = 200;

/**
 * Generates the occurrences of a weekly series.
 * @param {number} weekday 0=Sunday .. 6=Saturday (matches Date#getDay)
 * @returns {{start: Date, end: Date}[]} chronological, may be empty
 */
function generateSeriesDates(weekday, dateFrom, dateTo, timeFrom, timeTo) {
  const first = localDateTime(dateFrom, timeFrom);
  // Advance to the first matching weekday on or after dateFrom
  first.setDate(first.getDate() + ((weekday - first.getDay()) + 7) % 7);

  const last = localDateTime(dateTo, '23:59');
  const [endH, endMin] = timeTo.split(':').map(Number);
  const [startH, startMin] = timeFrom.split(':').map(Number);
  const durationMinutes = (endH * 60 + endMin) - (startH * 60 + startMin);

  const dates = [];
  const cursor = new Date(first);
  while (cursor <= last && dates.length < MAX_SERIES_EVENTS) {
    const start = new Date(cursor);
    dates.push({ start, end: new Date(start.getTime() + durationMinutes * 60000) });
    cursor.setDate(cursor.getDate() + 7);
    // Re-apply the wall-clock time: a DST change shifts the raw timestamp by an
    // hour, and "tuesdays 18:00" must stay 18:00 across it.
    cursor.setHours(startH, startMin, 0, 0);
  }
  return dates;
}

module.exports = {
  toLocalDateString,
  toLocalTimeString,
  localDateTime,
  generateSeriesDates,
  MAX_SERIES_EVENTS,
};
