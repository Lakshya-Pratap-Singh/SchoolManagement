const fs = require('fs');
const path = require('path');
// Node's built-in SQLite (Node 22.13+): nothing native to compile, nothing extra to install.
// process.getBuiltinModule also keeps Jest's module resolver out of the way.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

// DB_FILE=':memory:' is used by the tests.
function openDb(file = process.env.DB_FILE || './data/school.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')); // repeatable "migration"

  // Tiny transaction helper: db.transaction(fn)() or db.transaction(fn).immediate()
  // IMMEDIATE takes the write lock up-front, so "check balance then insert payment" cannot interleave.
  const wrap = (begin, fn) => (...args) => {
    db.exec(begin);
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  };
  db.transaction = (fn) => Object.assign(wrap('BEGIN', fn), { immediate: wrap('BEGIN IMMEDIATE', fn) });
  return db;
}

module.exports = { openDb };
