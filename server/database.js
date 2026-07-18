const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');

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
  const dbPath = path.resolve(config.dbPath);

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

  // Seed categories
  seedCategories();

  return db;
}

// ============ SCHEMA MIGRATIONS ============

function migrate() {
  // sql.js requires executing statements one at a time for CREATE TABLE
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor')),
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color_hex TEXT NOT NULL,
    color_bg TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    group_by_title INTEGER NOT NULL DEFAULT 0
  )`);

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

  // Migration: add group_by_title flag to categories (for existing databases).
  // Steuert, ob eine Kategorie in der Abrechnung zusätzlich nach Termin-Titel
  // aufgeschlüsselt wird. Der ALTER schlägt beim zweiten Lauf fehl, deshalb wird
  // der Erst-Default (Hobbies, wie im alten Abrechnungs-Tool) im selben try gesetzt.
  try {
    db.exec('ALTER TABLE categories ADD COLUMN group_by_title INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE categories SET group_by_title = 1 WHERE id = 5');
  } catch(e) {}
}

// ============ SEED CATEGORIES ============

function seedCategories() {
  const count = db.prepare('SELECT COUNT(*) as count FROM categories').get();
  if (count.count > 0) return;

  // Letzte Spalte: group_by_title — in der Abrechnung zusätzlich nach Termin-Titel
  // aufschlüsseln. Nur Hobbies, wie im alten Abrechnungs-Tool. Vermietung läuft
  // bewusst in einer Summe zusammen. Im Kategorien-Tab jederzeit änderbar.
  const categories = [
    [1, 'Lavender', '#a4bdfc', 'rgba(164, 189, 252, 0.3)', 1, 0],
    [2, 'STB', '#7ae7bf', 'rgba(122, 231, 191, 0.3)', 2, 0],
    [3, 'Grape', '#dbadff', 'rgba(219, 173, 255, 0.3)', 3, 0],
    [4, 'Flamingo', '#ff887c', 'rgba(255, 136, 124, 0.3)', 4, 0],
    [5, 'Hobbies', '#fbd75b', 'rgba(251, 215, 91, 0.3)', 5, 1],
    [6, 'Tangerine', '#ffb878', 'rgba(255, 184, 120, 0.3)', 6, 0],
    [7, 'ECB', '#46d6db', 'rgba(70, 214, 219, 0.3)', 7, 0],
    [8, 'Vermietung', '#e1e1e1', 'rgba(225, 225, 225, 0.5)', 8, 0],
    [9, 'Blueberry', '#5484ed', 'rgba(84, 132, 237, 0.3)', 9, 0],
    [10, 'Basil', '#51b749', 'rgba(81, 183, 73, 0.3)', 10, 0],
    [11, 'öffentliche Laufzeit', '#dc2127', 'rgba(220, 33, 39, 0.3)', 11, 0],
  ];

  for (const cat of categories) {
    db.prepare(
      'INSERT INTO categories (id, name, color_hex, color_bg, sort_order, group_by_title) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(...cat);
  }

  console.log('✅ Seeded 11 categories');
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
