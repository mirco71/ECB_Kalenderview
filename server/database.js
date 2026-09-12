const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { toLocalDateString, toLocalTimeString } = require('./datetime');

let db = null;
let dbReady = null;

/**
 * Wrapper around sql.js to provide a better-sqlite3-compatible API.
 * All route files use db.prepare(sql).get/all/run(...params) — this
 * wrapper translates those calls to sql.js equivalents.
 */
class DatabaseWrapper {
  constructor(sqlDb, dbPath) {
    this._db = sqlDb;
    this._dbPath = dbPath;
  }

  prepare(sql) {
    const self = this;
    return {
      get(...params) {
        try {
          const stmt = self._db.prepare(sql);
          if (params.length) stmt.bind(params);
          if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return row;
          }
          stmt.free();
          return undefined;
        } catch (err) {
          // If the SQL is invalid or table doesn't exist
          throw err;
        }
      },
      all(...params) {
        const results = [];
        try {
          const stmt = self._db.prepare(sql);
          if (params.length) stmt.bind(params);
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
        } catch (err) {
          throw err;
        }
        return results;
      },
      run(...params) {
        if (params.length) {
          self._db.run(sql, params);
        } else {
          self._db.run(sql);
        }
        // Get last insert rowid
        const idResult = self._db.exec("SELECT last_insert_rowid() as id");
        const lastInsertRowid = idResult.length > 0 ? idResult[0].values[0][0] : 0;
        const changes = self._db.getRowsModified();
        self._save();
        return { lastInsertRowid, changes };
      },
    };
  }

  exec(sql) {
    this._db.run(sql);
    this._save();
  }

  pragma(pragmaStr) {
    try {
      this._db.run(`PRAGMA ${pragmaStr}`);
    } catch (e) {
      // Some pragmas may not be supported in sql.js, ignore
    }
  }

  _save() {
    if (this._dbPath && this._dbPath !== ':memory:') {
      try {
        const data = this._db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(this._dbPath, buffer);
      } catch (err) {
        console.error('Error saving database:', err);
      }
    }
  }
}

// ============ INITIALIZATION ============

async function initDatabase() {
  const SQL = await initSqlJs();
  // Keep the ':memory:' marker intact — resolving it would turn it into a real
  // path and defeat the in-memory check in _save() (tests would try to write it).
  const dbPath = config.dbPath === ':memory:' ? ':memory:' : path.resolve(config.dbPath);

  // Ensure data directory exists
  if (dbPath !== ':memory:') {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  // Load existing database or create new one
  let sqlDb;
  if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  db = new DatabaseWrapper(sqlDb, dbPath);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Run migrations
  migrate();

  // Backfill series records for pre-existing series_id groups
  backfillSeries();

  // Seed categories
  seedCategories();

  return db;
}

// ============ SCHEMA MIGRATIONS ============

// Die Kategorie der Eismeister-Dienstzeiten. Wird in frischen Datenbanken
// geseedet und in gewachsenen per Migration nachgezogen.
const EISMEISTER_KATEGORIE = {
  name: 'Eismeister',
  color_hex: '#5484ed',
  color_bg: 'rgba(84, 132, 237, 0.3)',
};

function migrate() {
  // sql.js requires executing statements one at a time for CREATE TABLE
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'eismeister')),
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // login_required = 1: Termine dieser Kategorie sind nur für angemeldete
  // Benutzer sichtbar — sie fehlen in der öffentlichen Kalenderansicht und in
  // allen iCalendar-Feeds (die kennen keine Anmeldung).
  // eismeister_managed = 1: die Rolle 'eismeister' darf Termine dieser Kategorie
  // anlegen, bearbeiten und löschen. Beide Kennzeichen sind absichtlich getrennt
  // schaltbar — eine interne Vermietung soll nicht automatisch in den
  // Eismeister-Bereich fallen.
  db.exec(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color_hex TEXT NOT NULL,
    color_bg TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    group_by_title INTEGER NOT NULL DEFAULT 0,
    login_required INTEGER NOT NULL DEFAULT 0,
    eismeister_managed INTEGER NOT NULL DEFAULT 0
  )`);

  // external_uid/source: Termine, die aus Hallenplanung stammen. Der Abgleich
  // fasst ausschließlich Zeilen mit external_uid an — von Hand angelegte
  // Termine (STB, Vermietung, öffentliche Laufzeit, Hobbies) und die
  // Trainings-Serien bleiben dadurch unberührt.
  // in_hall = 0 markiert Termine, die KEINE Eiszeit in Solingen belegen
  // (Auswärtsspiele). Sie gehören in die Team-Feeds, aber weder in die
  // Hallenansicht noch in die Abrechnung — sonst wären die ausgewiesenen
  // Stunden zu hoch.
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    description TEXT DEFAULT '',
    location TEXT DEFAULT '',
    series_id TEXT DEFAULT NULL,
    external_uid TEXT DEFAULT NULL,
    source TEXT DEFAULT NULL,
    in_hall INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  )`);

  // Serien-Definition. Die Einzeltermine einer Serie liegen weiterhin in `events`
  // und verweisen über events.series_id auf diesen Datensatz. Die Regel separat zu
  // speichern (statt sie aus den Terminen abzuleiten) ist nötig, weil einzelne
  // Termine gelöscht und in der Uhrzeit abweichend geändert werden dürfen — der
  // abgeleitete Zeitraum wäre danach falsch.
  db.exec(`CREATE TABLE IF NOT EXISTS series (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    weekday INTEGER NOT NULL,
    time_from TEXT NOT NULL,
    time_to TEXT NOT NULL,
    date_from TEXT NOT NULL,
    date_to TEXT NOT NULL,
    description TEXT DEFAULT '',
    location TEXT DEFAULT '',
    source TEXT DEFAULT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id),
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  )`);

  // Create indexes
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_time)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_events_end ON events(end_time)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_events_category ON events(category_id)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_events_series ON events(series_id)'); } catch(e) {}

  // Migration: add series_id column if missing (for existing databases)
  try { db.exec('ALTER TABLE events ADD COLUMN series_id TEXT DEFAULT NULL'); } catch(e) {}

  // Migration: Spalten für den Abgleich mit Hallenplanung (siehe CREATE TABLE).
  // Reine Spalten-Ergänzungen — alter Code ignoriert sie, ein Rollback der
  // Anwendung ist also gefahrlos. Der Default in_hall = 1 lässt alle
  // bestehenden Zeilen unverändert in Kalenderansicht und Abrechnung.
  try { db.exec('ALTER TABLE events ADD COLUMN external_uid TEXT DEFAULT NULL'); } catch(e) {}
  try { db.exec('ALTER TABLE events ADD COLUMN source TEXT DEFAULT NULL'); } catch(e) {}
  try { db.exec('ALTER TABLE events ADD COLUMN in_hall INTEGER NOT NULL DEFAULT 1'); } catch(e) {}

  // Herkunft auch auf der Serie: Daran erkennt der Trainings-Grundstock, dass er
  // für diese Saison schon gelaufen ist, und bricht ab statt die von Hand
  // gepflegten Ausfälle und Verschiebungen zu überschreiben.
  try { db.exec('ALTER TABLE series ADD COLUMN source TEXT DEFAULT NULL'); } catch(e) {}

  // Partieller Unique-Index: verhindert doppelte Fremdschlüssel, lässt aber
  // beliebig viele Zeilen ohne external_uid zu (alle manuellen Termine).
  try {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external_uid ' +
      'ON events(external_uid) WHERE external_uid IS NOT NULL'
    );
  } catch(e) {}

  // Migration: add group_by_title flag to categories (for existing databases).
  // Steuert, ob eine Kategorie in der Abrechnung zusätzlich nach Termin-Titel
  // aufgeschlüsselt wird. Der ALTER schlägt beim zweiten Lauf fehl, deshalb wird
  // der Erst-Default (Hobbies, wie im alten Abrechnungs-Tool) im selben try gesetzt.
  try {
    db.exec('ALTER TABLE categories ADD COLUMN group_by_title INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE categories SET group_by_title = 1 WHERE id = 5');
  } catch(e) {}

  // Migration: Kennzeichen für Sichtbarkeit und Eismeister-Zuständigkeit
  // (siehe CREATE TABLE categories). Jedes ALTER in eigenem try/catch, damit das
  // zweite auch dann läuft, wenn nur das erste schon existiert.
  try { db.exec('ALTER TABLE categories ADD COLUMN login_required INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.exec('ALTER TABLE categories ADD COLUMN eismeister_managed INTEGER NOT NULL DEFAULT 0'); } catch(e) {}

  migrateEismeisterRolle();
  seedEismeisterKategorie();
}

/**
 * Erweitert die CHECK-Constraint der users-Tabelle um die Rolle 'eismeister'.
 *
 * SQLite kann eine CHECK-Constraint nicht per ALTER TABLE ändern, und
 * `CREATE TABLE IF NOT EXISTS` fasst eine bestehende Tabelle nicht an — in
 * gewachsenen Datenbanken steckt deshalb noch `CHECK (role IN ('admin',
 * 'editor'))`, und das Anlegen eines Eismeisters würde dort scheitern. Bleibt
 * nur der Neuaufbau der Tabelle.
 *
 * Die Fremdschlüssel müssen dafür aus sein: events.created_by und
 * series.created_by verweisen auf users(id), der DROP würde sonst abgelehnt.
 */
function migrateEismeisterRolle() {
  try {
    const vorhanden = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get();
    if (!vorhanden || !vorhanden.sql || vorhanden.sql.includes('eismeister')) return;

    db.pragma('foreign_keys = OFF');
    db.exec(`CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'eismeister')),
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(
      'INSERT INTO users_new (id, username, password_hash, role, display_name, created_at, updated_at) ' +
      'SELECT id, username, password_hash, role, display_name, created_at, updated_at FROM users'
    );
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.pragma('foreign_keys = ON');

    console.log('✅ users-Tabelle für Rolle "eismeister" neu aufgebaut');
  } catch (err) {
    // Scheitert der Umbau, bleibt die alte Tabelle bestehen — der Fehler darf
    // nicht verschluckt werden, sonst schlägt später das Anlegen eines
    // Eismeisters ohne erkennbaren Grund fehl.
    console.error('Migration der users-Tabelle fehlgeschlagen:', err);
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Legt die Kategorie "Eismeister" in bestehenden Datenbanken an.
 * seedCategories() greift nur bei komplett leerer Tabelle, deshalb hier per
 * Namensprüfung. Die ID kommt aus AUTOINCREMENT — eine feste ID wäre riskant,
 * weil in gewachsenen Datenbanken schon eigene Kategorien liegen können.
 */
function seedEismeisterKategorie() {
  try {
    const anzahl = db.prepare('SELECT COUNT(*) as count FROM categories').get();
    if (anzahl.count === 0) return; // frische DB — seedCategories() übernimmt

    const vorhanden = db.prepare('SELECT id FROM categories WHERE name = ?').get(EISMEISTER_KATEGORIE.name);
    if (vorhanden) return;

    const maxSort = db.prepare('SELECT MAX(sort_order) as max FROM categories').get();
    db.prepare(
      'INSERT INTO categories (name, color_hex, color_bg, sort_order, group_by_title, login_required, eismeister_managed) ' +
      'VALUES (?, ?, ?, ?, 0, 1, 1)'
    ).run(
      EISMEISTER_KATEGORIE.name,
      EISMEISTER_KATEGORIE.color_hex,
      EISMEISTER_KATEGORIE.color_bg,
      (maxSort.max || 0) + 1
    );

    console.log('✅ Kategorie "Eismeister" angelegt');
  } catch (err) {
    console.error('Anlegen der Kategorie "Eismeister" fehlgeschlagen:', err);
  }
}

// ============ BACKFILL SERIES ============

/**
 * Creates a `series` record for every series_id group that predates the series
 * table (events created through the old repeat_weeks parameter). The definition
 * is reconstructed from the group's first event; the period spans first to last.
 * Idempotent — groups that already have a record are skipped.
 */
function backfillSeries() {
  const orphans = db
    .prepare(
      `SELECT e.series_id,
              MIN(e.start_time) AS first_start,
              MAX(e.start_time) AS last_start
       FROM events e
       WHERE e.series_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM series s WHERE s.id = e.series_id)
       GROUP BY e.series_id`
    )
    .all();

  if (orphans.length === 0) return;

  for (const group of orphans) {
    const first = db
      .prepare(
        `SELECT title, category_id, start_time, end_time, description, location, created_by
         FROM events WHERE series_id = ? ORDER BY start_time ASC`
      )
      .get(group.series_id);
    if (!first) continue;

    const start = new Date(first.start_time);
    const end = new Date(first.end_time);

    db.prepare(
      `INSERT INTO series (id, title, category_id, weekday, time_from, time_to,
                           date_from, date_to, description, location, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      group.series_id,
      first.title,
      first.category_id,
      start.getDay(),
      toLocalTimeString(start),
      toLocalTimeString(end),
      toLocalDateString(start),
      toLocalDateString(new Date(group.last_start)),
      first.description || '',
      first.location || '',
      first.created_by
    );
  }

  console.log(`✅ Backfilled ${orphans.length} series record(s)`);
}

// ============ SEED CATEGORIES ============

function seedCategories() {
  const count = db.prepare('SELECT COUNT(*) as count FROM categories').get();
  if (count.count > 0) return;

  // Spalten nach sort_order: group_by_title, login_required, eismeister_managed.
  // group_by_title wird in der Abrechnung zusätzlich nach Termin-Titel
  // aufgeschlüsselt — nur Hobbies, wie im alten Abrechnungs-Tool.
  const categories = [
    [2, 'STB', '#7ae7bf', 'rgba(122, 231, 191, 0.3)', 1, 0, 0, 0],
    [5, 'Hobbies', '#fbd75b', 'rgba(251, 215, 91, 0.3)', 2, 1, 0, 0],
    [7, 'ECB', '#46d6db', 'rgba(70, 214, 219, 0.3)', 3, 0, 0, 0],
    [8, 'Vermietung', '#e1e1e1', 'rgba(225, 225, 225, 0.5)', 4, 0, 0, 0],
    [11, 'öffentliche Laufzeit', '#dc2127', 'rgba(220, 33, 39, 0.3)', 5, 0, 0, 0],
    [12, EISMEISTER_KATEGORIE.name, EISMEISTER_KATEGORIE.color_hex, EISMEISTER_KATEGORIE.color_bg, 6, 0, 1, 1],
  ];

  for (const cat of categories) {
    db.prepare(
      'INSERT INTO categories (id, name, color_hex, color_bg, sort_order, group_by_title, login_required, eismeister_managed) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(...cat);
  }

  console.log('✅ Seeded 6 categories');
}

// ============ EXPORTS ============

// The init promise — all modules that need the db should await this
dbReady = initDatabase();

/**
 * Returns the database wrapper. Must be called after dbReady resolves.
 */
function getDb() {
  if (!db) throw new Error('Database not initialized. Await dbReady first.');
  return db;
}

module.exports = { getDb, dbReady };
