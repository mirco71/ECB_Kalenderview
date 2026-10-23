/**
 * Farbwerte aus der Datenbank, die an die öffentliche Kalenderansicht gehen.
 *
 * Das Frontend schreibt sie in style-Attribute. Die Eingabe wird beim Anlegen
 * einer Kategorie validiert (categories.js), aber ein Wert, der anders in die
 * Datenbank gelangt ist (Import, Migration, direkter Zugriff), darf nie
 * ungeprüft nach außen gehen — sonst ließe sich CSS/HTML einschleusen.
 * Deshalb prüfen alle Ausgabepfade mit safeHex()/safeBg().
 */

// 6-stellige Hex-Farbe.
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

// 6-stellige Hex-Farbe oder rgb()/rgba() mit rein numerischen Komponenten.
const COLOR_PATTERN = /^(#[0-9a-fA-F]{6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;

const DEFAULT_HEX = '#888888';
const DEFAULT_BG = 'rgba(136,136,136,0.2)';

function safeHex(value) {
  return typeof value === 'string' && HEX_PATTERN.test(value) ? value : DEFAULT_HEX;
}

function safeBg(value) {
  return typeof value === 'string' && COLOR_PATTERN.test(value) ? value : DEFAULT_BG;
}

module.exports = { HEX_PATTERN, COLOR_PATTERN, DEFAULT_HEX, DEFAULT_BG, safeHex, safeBg };
