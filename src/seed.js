// Synthetic demo data only. Run `npm run seed` to RESET the database to this known state.
const { hash } = require('./auth');

const PASSWORDS = { ADMIN: 'Admin@123', TEACHER: 'Teacher@123', GUARDIAN: 'Guardian@123' };

function seed(db) {
  db.transaction(() => {
    for (const t of ['payments', 'invoices', 'results', 'exams', 'attendance', 'assignments', 'students', 'sections',
      'classes', 'subjects', 'grading_rules', 'audit_logs', 'users']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare('DELETE FROM sqlite_sequence').run(); // restart ids so demo data is deterministic

    const user = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)');
    const u = (name, email, role) => Number(user.run(name, email, hash(PASSWORDS[role]), role).lastInsertRowid);
    const admin = u('Demo Admin', 'admin@school.test', 'ADMIN');
    const asha = u('Asha Verma', 'asha.teacher@school.test', 'TEACHER');
    const ravi = u('Ravi Kumar', 'ravi.teacher@school.test', 'TEACHER');
    const meera = u('Meera Singh', 'meera.guardian@school.test', 'GUARDIAN');
    const arjun = u('Arjun Patel', 'arjun.guardian@school.test', 'GUARDIAN');

    const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);
    const c5 = ins('INSERT INTO classes (name) VALUES (?)', 'Class 5');
    const c6 = ins('INSERT INTO classes (name) VALUES (?)', 'Class 6');
    const s5a = ins('INSERT INTO sections (class_id,name) VALUES (?,?)', c5, 'A');
    const s5b = ins('INSERT INTO sections (class_id,name) VALUES (?,?)', c5, 'B');
    const s6a = ins('INSERT INTO sections (class_id,name) VALUES (?,?)', c6, 'A');
    const math = ins('INSERT INTO subjects (name) VALUES (?)', 'Mathematics');
    const eng = ins('INSERT INTO subjects (name) VALUES (?)', 'English');
    const sci = ins('INSERT INTO subjects (name) VALUES (?)', 'Science');

    const assign = 'INSERT INTO assignments (teacher_id,section_id,subject_id) VALUES (?,?,?)';
    ins(assign, asha, s5a, math); ins(assign, asha, s5a, sci); // Asha: 5-A only
    ins(assign, ravi, s5a, eng); ins(assign, ravi, s5b, math); // Ravi: 5-A and 5-B

    const stu = 'INSERT INTO students (name,admission_no,section_id,guardian_id) VALUES (?,?,?,?)';
    const aarav = ins(stu, 'Aarav Singh', 'ADM001', s5a, meera);
    const kabir = ins(stu, 'Kabir Patel', 'ADM002', s5a, arjun);
    const rohan = ins(stu, 'Rohan Das', 'ADM003', s5a, arjun);
    const diya = ins(stu, 'Diya Singh', 'ADM004', s5b, meera);
    const anaya = ins(stu, 'Anaya Patel', 'ADM005', s6a, arjun);

    for (const [min, g] of [[90, 'A+'], [80, 'A'], [70, 'B'], [60, 'C'], [50, 'D'], [0, 'F']]) {
      ins('INSERT INTO grading_rules (min_percent,grade) VALUES (?,?)', min, g);
    }

    const midterm = ins('INSERT INTO exams (name,section_id,subject_id,total_marks,exam_date) VALUES (?,?,?,?,?)', 'Midterm', s5a, math, 100, '2026-10-10');
    const unit = ins('INSERT INTO exams (name,section_id,subject_id,total_marks,exam_date) VALUES (?,?,?,?,?)', 'Unit Test 1', s5a, sci, 50, '2026-09-20');
    const res = 'INSERT INTO results (exam_id,student_id,marks,entered_by) VALUES (?,?,?,?)';
    ins(res, midterm, aarav, 92, asha); ins(res, midterm, kabir, 78, asha); ins(res, midterm, rohan, 45, asha);
    ins(res, unit, aarav, 40, asha); ins(res, unit, kabir, 31, asha);

    const today = new Date();
    const day = (offset) => new Date(today.getTime() - offset * 86400000).toISOString().slice(0, 10);
    const att = 'INSERT INTO attendance (student_id,date,session,status,marked_by) VALUES (?,?,?,?,?)';
    for (const [offset, marks] of [[1, ['PRESENT', 'ABSENT', 'LATE']], [0, ['PRESENT', 'PRESENT', 'PRESENT']]]) {
      [aarav, kabir, rohan].forEach((id, i) => ins(att, id, day(offset), 'MORNING', marks[i], asha));
    }

    const inv = 'INSERT INTO invoices (student_id,title,amount,due_date) VALUES (?,?,?,?)';
    const i1 = ins(inv, aarav, 'Term 1 Tuition', 20000, '2026-12-01');
    ins(inv, kabir, 'Term 1 Tuition', 20000, '2026-12-01');
    const i3 = ins(inv, diya, 'Term 1 Tuition', 20000, '2026-12-01');
    ins(inv, anaya, 'Transport Fee', 6000, '2026-12-15');
    const pay = 'INSERT INTO payments (invoice_id,amount,idempotency_key,paid_by) VALUES (?,?,?,?)';
    ins(pay, i1, 5000, 'seed-payment-0001', meera);
    ins(pay, i3, 20000, 'seed-payment-0002', meera);

    ins("INSERT INTO audit_logs (actor_id,action,entity,details) VALUES (?, 'SEED', 'database', ?)", admin, JSON.stringify({ note: 'demo data loaded' }));
  })();
}

module.exports = { seed, PASSWORDS };

if (require.main === module) {
  const { openDb } = require('./db');
  seed(openDb());
  console.log('Database seeded. Demo logins (synthetic):');
  console.log('  admin@school.test / Admin@123');
  console.log('  asha.teacher@school.test / Teacher@123   (assigned to Class 5 - A only)');
  console.log('  ravi.teacher@school.test / Teacher@123   (assigned to Class 5 - A and 5 - B)');
  console.log('  meera.guardian@school.test / Guardian@123');
  console.log('  arjun.guardian@school.test / Guardian@123');
}
