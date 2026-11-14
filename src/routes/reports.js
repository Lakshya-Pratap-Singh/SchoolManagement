// Dashboard + reports + audit trail (admin only).
const express = require('express');
const { requireRole } = require('../auth');
const { paginate } = require('../util');

module.exports = (db) => {
  const r = express.Router();
  const adm = requireRole('ADMIN');

  const feeTotals = () => {
    const billed = db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM invoices').get().n;
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM payments').get().n;
    // Outstanding computed independently, invoice by invoice, so the equation below is a real check.
    const outstanding = db.prepare(`SELECT COALESCE(SUM(i.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id),0)),0) AS n FROM invoices i`).get().n;
    return { billed, paid, outstanding, reconciled: billed - paid === outstanding };
  };

  r.get('/dashboard', adm, (_req, res) => {
    const count = (sql) => db.prepare(sql).get().n;
    const today = new Date().toISOString().slice(0, 10);
    const att = db.prepare(`SELECT status, COUNT(*) AS n FROM attendance WHERE date = ? GROUP BY status`).all(today);
    res.json({
      counts: {
        students: count('SELECT COUNT(*) AS n FROM students'),
        teachers: count("SELECT COUNT(*) AS n FROM users WHERE role='TEACHER'"),
        guardians: count("SELECT COUNT(*) AS n FROM users WHERE role='GUARDIAN'"),
        sections: count('SELECT COUNT(*) AS n FROM sections')
      },
      attendanceToday: Object.fromEntries(['PRESENT', 'ABSENT', 'LATE'].map((s) => [s, att.find((a) => a.status === s)?.n || 0])),
      fees: feeTotals()
    });
  });

  r.get('/reports/fees', adm, (req, res) => {
    const { page, limit, offset } = paginate(req.query);
    const total = db.prepare('SELECT COUNT(DISTINCT student_id) AS n FROM invoices').get().n;
    const data = db.prepare(`
      SELECT s.id AS student_id, s.name, SUM(i.amount) AS billed,
        COALESCE(SUM((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id)),0) AS paid
      FROM invoices i JOIN students s ON s.id = i.student_id GROUP BY s.id ORDER BY (billed - paid) DESC, s.name LIMIT ? OFFSET ?`)
      .all(limit, offset).map((x) => ({ ...x, outstanding: x.billed - x.paid }));
    res.json({ data, page, limit, total, totals: feeTotals() });
  });

  r.get('/reports/academic', adm, (_req, res) => {
    const data = db.prepare(`
      SELECT e.id, e.name, c.name || ' - ' || sec.name AS section_label, sub.name AS subject_name, e.total_marks,
        COUNT(r.id) AS entered, ROUND(AVG(100.0 * r.marks / e.total_marks), 1) AS average_percent
      FROM exams e JOIN sections sec ON sec.id = e.section_id JOIN classes c ON c.id = sec.class_id
      JOIN subjects sub ON sub.id = e.subject_id LEFT JOIN results r ON r.exam_id = e.id
      GROUP BY e.id ORDER BY e.exam_date DESC`).all();
    res.json({ data });
  });

  r.get('/audit-logs', adm, (req, res) => {
    const { page, limit, offset } = paginate(req.query);
    const total = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
    const data = db.prepare(`SELECT l.id, l.action, l.entity, l.entity_id, l.details, l.created_at, u.name AS actor
      FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
    res.json({ data, page, limit, total });
  });

  return r;
};
