try { process.loadEnvFile?.(); } catch { /* .env is optional */ }
const { openDb } = require('./db');
const { seed } = require('./seed');
const { createApp } = require('./app');

const db = openDb();
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  seed(db); // first run: load demo data so reviewers can log in immediately
  console.log('Empty database detected: loaded demo data.');
}
const port = process.env.PORT || 3000;
createApp(db).listen(port, () => console.log(`School app running at http://localhost:${port}  (API docs: /api-docs)`));
