const { forbidden, notFound } = require('./util');

// Row-level rules live here so every route uses the same checks.
function teacherSectionIds(db, teacherId) {
  return db.prepare('SELECT DISTINCT section_id FROM assignments WHERE teacher_id = ?').all(teacherId).map((r) => r.section_id);
}

function assertSectionAccess(db, user, sectionId) {
  if (user.role === 'ADMIN') return;
  if (user.role === 'TEACHER' && teacherSectionIds(db, user.id).includes(sectionId)) return;
  throw forbidden('You are not assigned to this class section');
}

function assertSubjectAccess(db, user, sectionId, subjectId) {
  if (user.role === 'ADMIN') return;
  const a = db.prepare('SELECT 1 FROM assignments WHERE teacher_id=? AND section_id=? AND subject_id=?').get(user.id, sectionId, subjectId);
  if (user.role === 'TEACHER' && a) return;
  throw forbidden('You are not assigned to teach this subject in this section');
}

// Returns the student if the caller may see it; guardians only see their own children.
function getStudentFor(db, user, studentId) {
  const s = db.prepare(`
    SELECT s.*, sec.name AS section_name, c.name AS class_name
    FROM students s JOIN sections sec ON sec.id = s.section_id JOIN classes c ON c.id = sec.class_id
    WHERE s.id = ?`).get(studentId);
  if (!s) throw notFound('Student not found');
  if (user.role === 'ADMIN') return s;
  if (user.role === 'GUARDIAN' && s.guardian_id === user.id) return s;
  if (user.role === 'TEACHER' && teacherSectionIds(db, user.id).includes(s.section_id)) return s;
  throw forbidden('You cannot access this student');
}

// Grade = rule with the highest min_percent that the percentage reaches.
function gradeFor(rules, percent) {
  const sorted = [...rules].sort((a, b) => b.min_percent - a.min_percent);
  return (sorted.find((r) => percent >= r.min_percent) || { grade: 'N/A' }).grade;
}

// Fee status derived from the ledger, never stored (so it cannot drift).
function invoiceWithBalance(db, inv) {
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS p FROM payments WHERE invoice_id=?').get(inv.id).p;
  const outstanding = inv.amount - paid;
  return { ...inv, paid, outstanding, status: outstanding === 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID' };
}

module.exports = { teacherSectionIds, assertSectionAccess, assertSubjectAccess, getStudentFor, gradeFor, invoiceWithBalance };
