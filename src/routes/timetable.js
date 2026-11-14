const express = require('express');
const { requireRole } = require('../auth');
const { validate, audit, bad, forbidden, notFound, conflict } = require('../util');
const { getStudentFor, assertSectionAccess } = require('../access');

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const ORDER = "CASE weekday WHEN 'MONDAY' THEN 1 WHEN 'TUESDAY' THEN 2 WHEN 'WEDNESDAY' THEN 3 WHEN 'THURSDAY' THEN 4 ELSE 5 END";

module.exports = (db) => {
  const r = express.Router();
  const admin = requireRole('ADMIN');

  const validateEntry = (body) => {
    const entry = validate(body, {
      section_id: 'int+',
      assignment_id: 'int+',
      weekday: WEEKDAYS,
      period: 'int+',
      start_time: 'string',
      end_time: 'string'
    });
    const validTime = (time) => /^\d{2}:\d{2}$/.test(time) && Number(time.slice(0, 2)) < 24 && Number(time.slice(3)) < 60;
    if (entry.period > 6) throw bad('period must be between 1 and 6');
    if (!validTime(entry.start_time) || !validTime(entry.end_time) || entry.start_time >= entry.end_time) {
      throw bad('start_time and end_time must be valid 24-hour times, with the end after the start');
    }
    const assignment = db.prepare('SELECT id, teacher_id, section_id FROM assignments WHERE id=?').get(entry.assignment_id);
    if (!assignment || assignment.section_id !== entry.section_id) throw bad('assignment_id must belong to the selected section');
    return { ...entry, teacher_id: assignment.teacher_id };
  };

  const assertAvailable = (entry, id = 0) => {
    const slotConflict = db.prepare(`
      SELECT 1 FROM timetable_entries te JOIN assignments a ON a.id=te.assignment_id
      WHERE te.weekday=? AND te.id<>? AND te.start_time<? AND te.end_time>?
        AND (te.section_id=? OR a.teacher_id=?)`).get(
      entry.weekday, id, entry.end_time, entry.start_time, entry.section_id, entry.teacher_id
    );
    if (slotConflict) throw conflict('The section or teacher is already scheduled during that time');
  };

  r.get('/timetable', requireRole('ADMIN', 'TEACHER', 'GUARDIAN', 'STUDENT'), (req, res) => {
    const where = [];
    const params = [];
    if (req.user.role === 'TEACHER') { where.push('a.teacher_id=?'); params.push(req.user.id); }
    if (req.user.role === 'GUARDIAN') {
      where.push('EXISTS (SELECT 1 FROM students s WHERE s.section_id=te.section_id AND s.guardian_id=?)');
      params.push(req.user.id);
    }
    if (req.user.role === 'STUDENT') {
      const student = getStudentFor(db, req.user, req.user.student_id);
      where.push('te.section_id=?');
      params.push(student.section_id);
    }
    if (req.query.section_id !== undefined) {
      const sectionId = Number(req.query.section_id);
      if (!Number.isInteger(sectionId) || sectionId < 1) throw bad('section_id must be a positive integer');
      if (req.user.role === 'TEACHER') assertSectionAccess(db, req.user, sectionId);
      if (req.user.role === 'GUARDIAN' && !db.prepare('SELECT 1 FROM students WHERE guardian_id=? AND section_id=?').get(req.user.id, sectionId)) {
        throw forbidden('You cannot view this section timetable');
      }
      if (req.user.role === 'STUDENT' && !db.prepare('SELECT 1 FROM students WHERE id=? AND section_id=?').get(req.user.student_id, sectionId)) {
        throw forbidden('You cannot view this section timetable');
      }
      where.push('te.section_id=?');
      params.push(sectionId);
    }
    const data = db.prepare(`
      SELECT te.id, te.section_id, sec.name AS section_name, c.name AS class_name,
        te.assignment_id, te.weekday, te.period, te.start_time, te.end_time,
        sub.name AS subject_name, u.name AS teacher_name
      FROM timetable_entries te
      JOIN sections sec ON sec.id=te.section_id
      JOIN classes c ON c.id=sec.class_id
      JOIN assignments a ON a.id=te.assignment_id
      JOIN subjects sub ON sub.id=a.subject_id
      JOIN users u ON u.id=a.teacher_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${ORDER}, te.period, c.name, sec.name`).all(...params);
    res.json({ data });
  });

  r.post('/timetable', admin, (req, res) => {
    const entry = validateEntry(req.body);
    const id = db.transaction(() => {
      assertAvailable(entry);
      const newId = db.prepare(`
        INSERT INTO timetable_entries (section_id,assignment_id,weekday,period,start_time,end_time)
        VALUES (?,?,?,?,?,?)`).run(
        entry.section_id, entry.assignment_id, entry.weekday, entry.period, entry.start_time, entry.end_time
      ).lastInsertRowid;
      audit(db, req.user, 'CREATE', 'timetable_entries', newId, entry);
      return newId;
    }).immediate();
    res.status(201).json({ id: Number(id), ...entry });
  });

  r.put('/timetable/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM timetable_entries WHERE id=?').get(id)) throw notFound('Timetable entry not found');
    const entry = validateEntry(req.body);
    db.transaction(() => {
      assertAvailable(entry, id);
      db.prepare(`
        UPDATE timetable_entries SET section_id=?,assignment_id=?,weekday=?,period=?,start_time=?,end_time=?
        WHERE id=?`).run(
        entry.section_id, entry.assignment_id, entry.weekday, entry.period, entry.start_time, entry.end_time, id
      );
      audit(db, req.user, 'UPDATE', 'timetable_entries', id, entry);
    }).immediate();
    res.json({ id, ...entry });
  });

  r.delete('/timetable/:id', admin, (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('DELETE FROM timetable_entries WHERE id=?').run(id).changes) throw notFound('Timetable entry not found');
    audit(db, req.user, 'DELETE', 'timetable_entries', id);
    res.status(204).end();
  });

  return r;
};
