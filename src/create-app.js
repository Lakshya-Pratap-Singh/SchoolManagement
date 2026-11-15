const path = require('path');
const express = require('express');
const { sign, authenticate, compare, hash } = require('./auth');
const { HttpError, validate } = require('./util');

const DUMMY_HASH = hash('not-a-real-password'); // equalises timing for unknown emails

function createApp(db, app = express()) {
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', (req, res) => {
    const { email, password } = validate(req.body, { email: 'email', password: 'string' });
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    const student = u ? null : db.prepare(`
      SELECT s.id, s.name, a.email, a.password_hash
      FROM student_accounts a JOIN students s ON s.id = a.student_id WHERE a.email = ?`).get(email.toLowerCase());
    const account = u || student;
    const ok = compare(password, account ? account.password_hash : DUMMY_HASH);
    if (!account || !ok) throw new HttpError(401, 'Invalid email or password');
    if (student) {
      const user = { id: student.id, student_id: student.id, name: student.name, email: student.email, role: 'STUDENT' };
      return res.json({ token: sign(user), user });
    }
    res.json({ token: sign(u), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
  });

  // Everything below needs a valid token. Role/row checks happen inside each route.
  app.use('/api', authenticate(db));
  app.get('/api/auth/me', (req, res) => res.json(req.user));
  app.use('/api', require('./routes/admin')(db));
  app.use('/api', require('./routes/attendance')(db));
  app.use('/api', require('./routes/exams')(db));
  app.use('/api', require('./routes/fees')(db));
  app.use('/api', require('./routes/reports')(db));
  app.use('/api', require('./routes/timetable')(db));
  app.use('/api', (req, _res, next) => next(new HttpError(404, `No route for ${req.method} ${req.path}`)));

  // API docs (Swagger UI loaded from a CDN in the browser; nothing to install).
  app.get('/openapi.yaml', (_req, res) => res.sendFile(path.join(__dirname, '..', 'openapi.yaml')));
  app.get('/api-docs', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>API docs</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css"></head><body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/openapi.yaml', dom_id: '#ui' });</script></body></html>`));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // One predictable error shape: { error: { message, details? } }
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err.type === 'entity.parse.failed') { status = 400; message = 'Malformed JSON body'; }
    else if (err.code === 'ERR_SQLITE_ERROR' && [2067, 1555].includes(err.errcode)) { status = 409; message = 'A record with these values already exists'; } // UNIQUE / PRIMARY KEY
    else if (err.code === 'ERR_SQLITE_ERROR' && err.errcode === 787) { status = 409; message = 'Related record is missing, or this record is still in use'; } // FOREIGN KEY
    else if (err.code === 'ERR_SQLITE_ERROR' && (err.errcode & 0xff) === 19) { status = 400; message = 'Value violates a database constraint'; } // CHECK / NOT NULL
    else if (status >= 500) { console.error(err); message = 'Internal server error'; }
    res.status(status).json({ error: { message, ...(err.details ? { details: err.details } : {}) } });
  });

  return app;
}

module.exports = { createApp };
