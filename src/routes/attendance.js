const express = require('express');
const { requireRole } = require('../auth');
const { validate, audit, bad, isDate } = require('../util');
const { assertSectionAccess, getStudentFor } = require('../access');

module.exports = (db) => {
  const r = express.Router();

  // Mark a whole section for one date + session. Re-submitting safely UPDATES (never duplicates):
  // the UNIQUE(student_id, date, session) constraint + upsert guarantees one row per student/date/session.
  r.post('/attendance', requireRole('ADMIN', 'TEACHER'), (req, res) => {
    const v = validate(req.body, { section_id: 'int+', date: 'date', session: ['MORNING', 'AFTERNOON'] });
    assertSectionAccess(db, req.user, v.section_id);
    const records = req.body.records;
    if (!Array.isArray(records) || !records.length) throw bad('records must be a non-empty array');
    const ids = new Set(db.prepare('SELECT id FROM students WHERE section_id = ?').all(v.section_id).map((s) => s.id));
    const seen = new Set();
    for (const rec of records) {
      if (!ids.has(rec?.student_id)) throw bad(`student ${rec?.student_id} is not in this section`);
      if (!['PRESENT', 'ABSENT', 'LATE'].includes(rec.status)) throw bad(`invalid status for student ${rec.student_id}`);
      if (seen.has(rec.student_id)) throw bad(`student ${rec.student_id} listed twice`);
      seen.add(rec.student_id);
    }
    const upsert = db.prepare(`
      INSERT INTO attendance (student_id, date, session, status, marked_by) VALUES (?,?,?,?,?)
      ON CONFLICT(student_id, date, session) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`);
    db.transaction(() => {
      for (const rec of records) upsert.run(rec.student_id, v.date, v.session, rec.status, req.user.id);
      audit(db, req.user, 'MARK_ATTENDANCE', 'sections', v.section_id, { date: v.date, session: v.session, count: records.length });
    })();
    res.json({ saved: records.length });
  });

  // Existing marks for a section/date/session (to pre-fill the form).
  r.get('/attendance', requireRole('ADMIN', 'TEACHER'), (req, res) => {
    const sectionId = Number(req.query.section_id);
    if (!sectionId || !isDate(req.query.date)) throw bad('section_id and date are required');
    assertSectionAccess(db, req.user, sectionId);
    const data = db.prepare(`
      SELECT a.student_id, a.status FROM attendance a JOIN students s ON s.id = a.student_id
      WHERE s.section_id = ? AND a.date = ? AND a.session = ?`).all(sectionId, req.query.date, req.query.session || 'MORNING');
    res.json({ data });
  });

  // Class summary: attended% = (PRESENT + LATE) / all marked sessions.
  r.get('/attendance/summary', requireRole('ADMIN', 'TEACHER'), (req, res) => {
    const sectionId = Number(req.query.section_id);
    if (!sectionId) throw bad('section_id is required');
    assertSectionAccess(db, req.user, sectionId);
    const from = isDate(req.query.from) ? req.query.from : '0000-01-01';
    const to = isDate(req.query.to) ? req.query.to : '9999-12-31';
    const data = db.prepare(`
      SELECT s.id AS student_id, s.name,
        COALESCE(SUM(a.status='PRESENT'),0) AS present, COALESCE(SUM(a.status='ABSENT'),0) AS absent,
        COALESCE(SUM(a.status='LATE'),0) AS late, COUNT(a.id) AS total,
        CASE WHEN COUNT(a.id)=0 THEN NULL ELSE ROUND(100.0*SUM(a.status IN ('PRESENT','LATE'))/COUNT(a.id),1) END AS percent
      FROM students s LEFT JOIN attendance a ON a.student_id = s.id AND a.date BETWEEN ? AND ?
      WHERE s.section_id = ? GROUP BY s.id ORDER BY s.name`).all(from, to, sectionId);
    res.json({ data });
  });

  // Per-student summary (admin / assigned teacher / the student's own guardian).
  r.get('/students/:id/attendance', (req, res) => {
    const s = getStudentFor(db, req.user, Number(req.params.id));
    const rows = db.prepare('SELECT date, session, status FROM attendance WHERE student_id = ? ORDER BY date DESC, session').all(s.id);
    const count = (st) => rows.filter((x) => x.status === st).length;
    const total = rows.length;
    res.json({
      student: { id: s.id, name: s.name },
      summary: { total, present: count('PRESENT'), absent: count('ABSENT'), late: count('LATE'),
        percent: total ? Math.round((1000 * (count('PRESENT') + count('LATE'))) / total) / 10 : null },
      records: rows.slice(0, 60)
    });
  });

  return r;
};
