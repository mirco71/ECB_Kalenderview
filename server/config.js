require('dotenv').config();
const crypto = require('crypto');

/**
 * Resolves the JWT signing secret.
 * - Production: a strong secret is mandatory — the app refuses to start with a
 *   missing, too-short, or well-known placeholder value (prevents forgeable tokens).
 * - Development/Test: falls back to an ephemeral random secret (valid only for the
 *   lifetime of the process) so local runs work without configuration.
 */
function resolveJwtSecret() {
  const secret = process.env.JWT_SECRET;
  const isPlaceholder = !secret || secret.length < 16 ||
    ['change-me', 'change-me-to-a-random-secret-string'].includes(secret);

  if (!isPlaceholder) return secret;

  if ((process.env.NODE_ENV || 'development') === 'production') {
    throw new Error(
      'JWT_SECRET fehlt oder ist zu schwach. Bitte eine lange, zufällige Zeichenkette ' +
      'setzen (mind. 16 Zeichen), z. B. `openssl rand -hex 32`.'
    );
  }

  console.warn(
    '⚠️  JWT_SECRET nicht (sicher) gesetzt — verwende ein temporäres Zufalls-Secret. ' +
    'Nur für Entwicklung/Tests geeignet; Tokens werden bei jedem Neustart ungültig.'
  );
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Whether the session cookie gets the Secure flag (and the site is served over
 * HTTPS). SECURE_TRANSPORT=true/false is taken literally; if unset it follows
 * NODE_ENV=production. For tests in the LAN over http://IP:Port set
 * SECURE_TRANSPORT=false, otherwise the browser refuses to store the cookie.
 */
function resolveSecureTransport() {
  const wert = process.env.SECURE_TRANSPORT;
  if (wert === 'true') return true;
  if (wert === 'false') return false;
  return (process.env.NODE_ENV || 'development') === 'production';
}

module.exports = {
  port: parseInt(process.env.PORT) || 3000,
  jwtSecret: resolveJwtSecret(),
  dbPath: process.env.DB_PATH || './data/calendar.db',
  calendarName: process.env.CALENDAR_NAME || 'Kalender',
  startHour: parseInt(process.env.START_HOUR) || 6,
  endHour: parseInt(process.env.END_HOUR) || 23,
  nodeEnv: process.env.NODE_ENV || 'development',
  secureTransport: resolveSecureTransport(),
  // Optional CORS allow-list. The bundled frontend is served same-origin and
  // needs no CORS at all; only set this if a separate origin must call the API.
  corsOrigin: process.env.CORS_ORIGIN || null,
};
