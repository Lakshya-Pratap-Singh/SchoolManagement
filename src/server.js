try { process.loadEnvFile?.(); } catch { /* .env is optional */ }

if (process.env.VERCEL) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('Set JWT_SECRET to a random value of at least 32 characters in Vercel project settings.');
  }
  // Vercel instances have only temporary writable storage; this is demo-only.
  process.env.DB_FILE = '/tmp/school-management-demo.db';
}

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
