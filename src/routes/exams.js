// Exams, marks entry, configurable grading rules, report cards.
const express = require('express');
const { requireRole } = require('../auth');
const { validate, audit, bad, notFound, paginate } = require('../util');
const { assertSubjectAccess, getStudentFor, gradeFor } = require('../access');

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = (db) => {
  const r = express.Router();
  const rules = () => db.prepare('SELECT min_percent, grade FROM grading_rules ORDER BY min_percent DESC').all();

  const examRow = (id) => {
    const e = db.prepare(`
      SELECT e.*, c.name || ' - ' || sec.name AS section_label, sub.name AS subject_name
      FROM exams e JOIN sections sec ON sec.id = e.section_id JOIN classes c ON c.id = sec.class_id
      JOIN subjects sub ON sub.id = e.subject_id WHERE e.id = ?`).get(id);
    if (!e) throw notFound('Exam not found');
    return e;
  };

  // ---- grading rules (admin configures, everyone signed-in can read) ----
  r.get('/grading-rules', (_req, res) => res.json({ data: rules() }));
  r.put('/grading-rules', requireRole('ADMIN'), (req, res) => {
    const list = req.body?.rules;
    if (!Array.isArray(list) || !list.length) throw bad('rules must be a non-empty array');
    const mins = new Set();
    for (const x of list) {
      if (typeof x.min_percent !== 'number' || x.min_percent < 0 || x.min_percent > 100) throw bad('min_percent must be 0-100');
      if (typeof x.grade !== 'string' || !x.grade.trim()) throw bad('grade is required');
      if (mins.has(x.min_percent)) throw bad('duplicate min_percent');
      mins.add(x.min_percent);
    }
    if (!mins.has(0)) throw bad('one rule must start at 0 so every score gets a grade');
    db.transaction(() => {
      db.prepare('DELETE FROM grading_rules').run();
      const ins = db.prepare('INSERT INTO grading_rules (min_percent, grade) VALUES (?,?)');
      for (const x of list) ins.run(x.min_percent, x.grade.trim());
      audit(db, req.user, 'UPDATE', 'grading_rules', null, { rules: list });
    })();
    res.json({ data: rules() });
  });

  // ---- exams ----
  r.get('/exams', requireRole('ADMIN', 'TEACHER'), (req, res) => {
    const { page, limit, offset } = paginate(req.query);
    const teacher = req.user.role === 'TEACHER';
    const from = `FROM exams e JOIN sections sec ON sec.id = e.section_id JOIN classes c ON c.id = sec.class_id
      JOIN subjects sub ON sub.id = e.subject_id
      ${teacher ? 'JOIN assignments a ON a.section_id = e.section_id AND a.subject_id = e.subject_id AND a.teacher_id = ?' : ''}`;
    const params = teacher ? [req.user.id] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;
    const data = db.prepare(`SELECT e.*, c.name || ' - ' || sec.name AS section_label, sub.name AS subject_name ${from}
      ORDER BY e.exam_date DESC, e.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ data, page, limit, total });
  });

  r.post('/exams', requireRole('ADMIN'), (req, res) => {
    const v = validate(req.body, { name: 'string', section_id: 'int+', subject_id: 'int+', total_marks: 'int+', exam_date: 'date' });
    const id = db.prepare('INSERT INTO exams (name, section_id, subject_id, total_marks, exam_date) VALUES (?,?,?,?,?)')
      .run(v.name, v.section_id, v.subject_id, v.total_marks, v.exam_date).lastInsertRowid;
    audit(db, req.user, 'CREATE', 'exams', id, v);
    res.status(201).json(examRow(id));
  });

  // Marks sheet: every student in the section with marks (or null), percent and computed grade.
  r.get('/exams/:id/results', requireRole('ADMIN', 'TEACHER'), (req, res) => {
    const e = examRow(Number(req.params.id));
    assertSubjectAccess(db, req.user, e.section_id, e.subject_id);
    const g = rules();
    const rows = db.prepare(`
      SELECT s.id AS student_id, s.name, s.admission_no, r.marks FROM students s
      LEFT JOIN results r ON r.student_id = s.id AND r.exam_id = ? WHERE s.section_id = ? ORDER BY s.name`).all(e.id, e.section_id);
    res.json({
      exam: e,
      data: rows.map((x) => {
        if (x.marks === null) return { ...x, percent: null, grade: null };
        const percent = round2((100 * x.marks) / e.total_marks);
        return { ...x, percent, grade: gradeFor(g, percent) };
      })
    });
  });

  r.put('/exams/:id/results', requireRole('ADMIN', 'TEACHER'), (req, res) => {
    const e = examRow(Number(req.params.id));
    assertSubjectAccess(db, req.user, e.section_id, e.subject_id);
    const list = req.body?.results;
    if (!Array.isArray(list) || !list.length) throw bad('results must be a non-empty array');
    const inSection = new Set(db.prepare('SELECT id FROM students WHERE section_id = ?').all(e.section_id).map((s) => s.id));
    for (const x of list) {
      if (!inSection.has(x?.student_id)) throw bad(`student ${x?.student_id} is not in this exam's section`);
      if (typeof x.marks !== 'number' || !Number.isFinite(x.marks) || x.marks < 0 || x.marks > e.total_marks) {
        throw bad(`marks for student ${x.student_id} must be between 0 and ${e.total_marks}`);
      }
    }
    const upsert = db.prepare(`INSERT INTO results (exam_id, student_id, marks, entered_by) VALUES (?,?,?,?)
      ON CONFLICT(exam_id, student_id) DO UPDATE SET marks = excluded.marks, entered_by = excluded.entered_by`);
    db.transaction(() => {
      for (const x of list) upsert.run(e.id, x.student_id, x.marks, req.user.id);
      audit(db, req.user, 'ENTER_MARKS', 'exams', e.id, { count: list.length });
    })();
    res.json({ saved: list.length });
  });

  // ---- report card (admin, assigned teacher, or the student's own guardian) ----
  r.get('/students/:id/report-card', (req, res) => {
    const s = getStudentFor(db, req.user, Number(req.params.id));
    const g = rules();
    const rows = db.prepare(`
      SELECT e.name AS exam, sub.name AS subject, e.exam_date, e.total_marks, r.marks
      FROM results r JOIN exams e ON e.id = r.exam_id JOIN subjects sub ON sub.id = e.subject_id
      WHERE r.student_id = ? ORDER BY e.exam_date, sub.name`).all(s.id);
    const subjects = rows.map((x) => {
      const percent = round2((100 * x.marks) / x.total_marks);
      return { ...x, percent, grade: gradeFor(g, percent) };
    });
    const obtained = subjects.reduce((a, x) => a + x.marks, 0);
    const total = subjects.reduce((a, x) => a + x.total_marks, 0);
    const percent = total ? round2((100 * obtained) / total) : null;
    res.json({
      student: { id: s.id, name: s.name, admission_no: s.admission_no, class: s.class_name, section: s.section_name },
      subjects,
      overall: { obtained, total, percent, grade: percent === null ? null : gradeFor(g, percent) }
    });
  });

  return r;
};
