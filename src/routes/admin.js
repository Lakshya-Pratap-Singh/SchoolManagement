// Academic administration: classes, sections, subjects, assignments, users (teachers/guardians), students.
const express = require('express');
const { requireRole, hash } = require('../auth');
const { validate, paginate, audit, notFound, bad } = require('../util');
const { teacherSectionIds, getStudentFor } = require('../access');

module.exports = (db) => {
  const r = express.Router();
  const admin = requireRole('ADMIN');

  // ---- simple lookup tables: classes & subjects ----
  for (const [path, table] of [['classes', 'classes'], ['subjects', 'subjects']]) {
    r.get(`/${path}`, (_req, res) => res.json({ data: db.prepare(`SELECT * FROM ${table} ORDER BY name`).all() }));
    r.post(`/${path}`, admin, (req, res) => {
      const { name } = validate(req.body, { name: 'string' });
      const id = db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid;
      audit(db, req.user, 'CREATE', table, id, { name });
      res.status(201).json({ id: Number(id), name });
    });
    r.delete(`/${path}/:id`, admin, (req, res) => {
      const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
      if (!info.changes) throw notFound();
      audit(db, req.user, 'DELETE', table, Number(req.params.id));
      res.status(204).end();
    });
  }

  // ---- sections ----
  r.get('/sections', requireRole('ADMIN', 'TEACHER'), (req, res) => {
    let sql = `SELECT sec.id, sec.name, sec.class_id, c.name AS class_name, c.name || ' - ' || sec.name AS label
               FROM sections sec JOIN classes c ON c.id = sec.class_id`;
    const params = [];
    if (req.user.role === 'TEACHER') {
      const ids = teacherSectionIds(db, req.user.id);
      if (!ids.length) return res.json({ data: [] });
      sql += ` WHERE sec.id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }
    res.json({ data: db.prepare(sql + ' ORDER BY c.name, sec.name').all(...params) });
  });
  r.post('/sections', admin, (req, res) => {
    const { class_id, name } = validate(req.body, { class_id: 'int+', name: 'string' });
    const id = db.prepare('INSERT INTO sections (class_id, name) VALUES (?, ?)').run(class_id, name).lastInsertRowid;
    audit(db, req.user, 'CREATE', 'sections', id, { class_id, name });
    res.status(201).json({ id: Number(id), class_id, name });
  });
  r.delete('/sections/:id', admin, (req, res) => {
    if (!db.prepare('DELETE FROM sections WHERE id = ?').run(req.params.id).changes) throw notFound();
    audit(db, req.user, 'DELETE', 'sections', Number(req.params.id));
    res.status(204).end();
  });

  // ---- teacher/class/subject assignments ----
  r.get('/assignments', requireRole('ADMIN', 'TEACHER'), (req, res) => {
    const where = req.user.role === 'TEACHER' ? 'WHERE a.teacher_id = ?' : '';
    const rows = db.prepare(`
      SELECT a.id, a.teacher_id, u.name AS teacher_name, a.section_id, c.name || ' - ' || sec.name AS section_label,
             a.subject_id, sub.name AS subject_name
      FROM assignments a JOIN users u ON u.id = a.teacher_id JOIN sections sec ON sec.id = a.section_id
      JOIN classes c ON c.id = sec.class_id JOIN subjects sub ON sub.id = a.subject_id ${where}
      ORDER BY section_label, subject_name`).all(...(where ? [req.user.id] : []));
    res.json({ data: rows });
  });
  r.post('/assignments', admin, (req, res) => {
    const v = validate(req.body, { teacher_id: 'int+', section_id: 'int+', subject_id: 'int+' });
    const t = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'TEACHER'").get(v.teacher_id);
    if (!t) throw bad('teacher_id must be a teacher');
    const id = db.prepare('INSERT INTO assignments (teacher_id, section_id, subject_id) VALUES (?,?,?)')
      .run(v.teacher_id, v.section_id, v.subject_id).lastInsertRowid;
    audit(db, req.user, 'CREATE', 'assignments', id, v);
    res.status(201).json({ id: Number(id), ...v });
  });
  r.delete('/assignments/:id', admin, (req, res) => {
    if (!db.prepare('DELETE FROM assignments WHERE id = ?').run(req.params.id).changes) throw notFound();
    audit(db, req.user, 'DELETE', 'assignments', Number(req.params.id));
    res.status(204).end();
  });

  // ---- users: teachers & guardians (admin only) ----
  r.get('/users', admin, (req, res) => {
    const { page, limit, offset } = paginate(req.query);
    const where = [];
    const params = [];
    if (['TEACHER', 'GUARDIAN', 'ADMIN'].includes(req.query.role)) { where.push('role = ?'); params.push(req.query.role); }
    if (req.query.q) { where.push('(name LIKE ? OR email LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${w}`).get(...params).n;
    const data = db.prepare(`SELECT id, name, email, role, phone FROM users ${w} ORDER BY name LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ data, page, limit, total });
  });
  r.post('/users', admin, (req, res) => {
    const v = validate(req.body, { name: 'string', email: 'email', role: ['TEACHER', 'GUARDIAN'] });
    if (typeof req.body.password !== 'string' || req.body.password.length < 8) throw bad('Validation failed', { password: 'min 8 characters' });
    const id = db.prepare('INSERT INTO users (name, email, password_hash, role, phone) VALUES (?,?,?,?,?)')
      .run(v.name, v.email.toLowerCase(), hash(req.body.password), v.role, req.body.phone || null).lastInsertRowid;
    audit(db, req.user, 'CREATE', 'users', id, { email: v.email, role: v.role });
    res.status(201).json({ id: Number(id), name: v.name, email: v.email.toLowerCase(), role: v.role });
  });

  // ---- students ----
  r.get('/students', (req, res) => {
    const { page, limit, offset } = paginate(req.query);
    const where = [];
    const params = [];
    if (req.user.role === 'GUARDIAN') { where.push('s.guardian_id = ?'); params.push(req.user.id); }
    if (req.user.role === 'TEACHER') {
      const ids = teacherSectionIds(db, req.user.id);
      if (!ids.length) return res.json({ data: [], page, limit, total: 0 });
      where.push(`s.section_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids);
    }
    if (req.query.section_id) { where.push('s.section_id = ?'); params.push(Number(req.query.section_id)); }
    if (req.query.q) { where.push('(s.name LIKE ? OR s.admission_no LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const base = `FROM students s JOIN sections sec ON sec.id = s.section_id JOIN classes c ON c.id = sec.class_id
                  JOIN users g ON g.id = s.guardian_id ${w}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params).n;
    const data = db.prepare(`SELECT s.id, s.name, s.admission_no, s.section_id, s.guardian_id, g.name AS guardian_name,
                             c.name || ' - ' || sec.name AS section_label ${base} ORDER BY s.name LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    res.json({ data, page, limit, total });
  });
  r.get('/students/:id', (req, res) => res.json(getStudentFor(db, req.user, Number(req.params.id))));
  const studentRules = { name: 'string', admission_no: 'string', section_id: 'int+', guardian_id: 'int+' };
  const checkGuardian = (id) => {
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'GUARDIAN'").get(id)) throw bad('guardian_id must be a guardian');
  };
  r.post('/students', admin, (req, res) => {
    const v = validate(req.body, studentRules);
    checkGuardian(v.guardian_id);
    const id = db.prepare('INSERT INTO students (name, admission_no, section_id, guardian_id) VALUES (?,?,?,?)')
      .run(v.name, v.admission_no, v.section_id, v.guardian_id).lastInsertRowid;
    audit(db, req.user, 'CREATE', 'students', id, v);
    res.status(201).json({ id: Number(id), ...v });
  });
  r.put('/students/:id', admin, (req, res) => {
    const v = validate(req.body, studentRules);
    checkGuardian(v.guardian_id);
    const info = db.prepare('UPDATE students SET name=?, admission_no=?, section_id=?, guardian_id=? WHERE id=?')
      .run(v.name, v.admission_no, v.section_id, v.guardian_id, req.params.id);
    if (!info.changes) throw notFound('Student not found');
    audit(db, req.user, 'UPDATE', 'students', Number(req.params.id), v);
    res.json({ id: Number(req.params.id), ...v });
  });
  r.delete('/students/:id', admin, (req, res) => {
    if (!db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id).changes) throw notFound('Student not found');
    audit(db, req.user, 'DELETE', 'students', Number(req.params.id));
    res.status(204).end();
  });

  return r;
};
