/**
 * Seed script — creates the initial admin user.
 * 
 * Usage:
 *   node server/seed.js
 *   node server/seed.js --username admin --password secret123 --name "Admin User"
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getDb, dbReady } = require('./database');
const { BCRYPT_ROUNDS } = require('./passwords');

const args = process.argv.slice(2);

function getArg(name, defaultValue) {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return defaultValue;
}

async function main() {
  await dbReady;
  const db = getDb();

  const username = getArg('username', 'admin');
  const password = getArg('password', 'admin123');
  const displayName = getArg('name', 'Administrator');

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.log(`⚠️  Benutzer "${username}" existiert bereits (ID: ${existing.id})`);
    process.exit(0);
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  const result = db
    .prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, 'admin', displayName);

  console.log(`✅ Admin-Benutzer erstellt:`);
  console.log(`   Benutzername: ${username}`);
  console.log(`   Passwort:     ${password}`);
  console.log(`   ID:           ${result.lastInsertRowid}`);
  console.log(`\n⚠️  Bitte ändern Sie das Passwort nach dem ersten Login!`);
}

main().catch(err => {
  console.error('Fehler:', err);
  process.exit(1);
});
