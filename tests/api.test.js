const request = require('supertest');
const { openDb } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');
const { gradeFor } = require('../src/access');

let db, app;
const tokens = {};

// Fresh in-memory database for every test => tests are independent and repeatable.
beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp(db);
  for (const k of Object.keys(tokens)) delete tokens[k];
});

async function login(email, password) {
  if (tokens[email]) return tokens[email];
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return (tokens[email] = res.body.token);
}
const as = {
  admin: () => login('admin@school.test', 'Admin@123'),
  asha: () => login('asha.teacher@school.test', 'Teacher@123'), // assigned to 5-A only
  ravi: () => login('ravi.teacher@school.test', 'Teacher@123'), // 5-A English, 5-B Maths
  meera: () => login('meera.guardian@school.test', 'Guardian@123'), // guardian of Aarav (5-A) and Diya (5-B)
  arjun: () => login('arjun.guardian@school.test', 'Guardian@123'), // guardian of Kabir, Rohan, Anaya
  aarav: () => login('aarav.student@school.test', 'Student@123')
};
const call = async (who, method, url, body) => {
  const t = await as[who]();
  const req = request(app)[method](url).set('Authorization', `Bearer ${t}`);
  return body ? req.send(body) : req;
};
const sectionId = (label) => db.prepare("SELECT sec.id FROM sections sec JOIN classes c ON c.id=sec.class_id WHERE c.name || ' - ' || sec.name = ?").get(label).id;
const studentId = (name) => db.prepare('SELECT id FROM students WHERE name = ?').get(name).id;
const attendanceBody = (sec, status, date = '2026-11-02') => ({
  section_id: sec, date, session: 'MORNING',
  records: db.prepare('SELECT id FROM students WHERE section_id = ?').all(sec).map((s) => ({ student_id: s.id, status }))
});

describe('authentication', () => {
  test('rejects bad credentials and unauthenticated calls', async () => {
    const bad = await request(app).post('/api/auth/login').send({ email: 'admin@school.test', password: 'wrong-pass' });
    expect(bad.status).toBe(401);
    expect((await request(app).get('/api/students')).status).toBe(401);
    expect((await request(app).get('/api/students').set('Authorization', 'Bearer junk')).status).toBe(401);
  });
  test('validation errors use one predictable shape', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Validation failed');
    expect(res.body.error.details).toHaveProperty('email');
  });
});

describe('ACCEPTANCE 1: teacher can only use assigned classes', () => {
  test('assigned teacher can record attendance', async () => {
    const res = await call('asha', 'post', '/api/attendance', attendanceBody(sectionId('Class 5 - A'), 'PRESENT'));
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(3);
  });
  test('same teacher gets 403 for an unassigned section (checked on the server, not the UI)', async () => {
    const res = await call('asha', 'post', '/api/attendance', attendanceBody(sectionId('Class 5 - B'), 'PRESENT'));
    expect(res.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) n FROM attendance WHERE date='2026-11-02'").get().n).toBe(0);
  });
  test('teacher only lists assigned sections and students', async () => {
    const secs = (await call('asha', 'get', '/api/sections')).body.data.map((s) => s.label);
    expect(secs).toEqual(['Class 5 - A']);
    const students = (await call('asha', 'get', '/api/students')).body.data.map((s) => s.name).sort();
    expect(students).toEqual(['Aarav Singh', 'Kabir Patel', 'Rohan Das']);
    expect((await call('asha', 'get', `/api/students/${studentId('Diya Singh')}`)).status).toBe(403);
  });
  test('guardians and teachers cannot use admin-only actions', async () => {
    expect((await call('meera', 'post', '/api/attendance', attendanceBody(sectionId('Class 5 - A'), 'PRESENT'))).status).toBe(403);
    expect((await call('asha', 'post', '/api/classes', { name: 'Class 9' })).status).toBe(403);
    expect((await call('asha', 'get', '/api/invoices')).status).toBe(403);
    expect((await call('meera', 'get', '/api/audit-logs')).status).toBe(403);
  });
});

describe('ACCEPTANCE 2: duplicate attendance is safely handled', () => {
  test('re-submitting the same student/date/session updates; never creates a second row', async () => {
    const sec = sectionId('Class 5 - A');
    await call('asha', 'post', '/api/attendance', attendanceBody(sec, 'PRESENT'));
    const again = await call('asha', 'post', '/api/attendance', attendanceBody(sec, 'ABSENT'));
    expect(again.status).toBe(200);
    const rows = db.prepare("SELECT status FROM attendance WHERE date='2026-11-02' AND session='MORNING'").all();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'ABSENT')).toBe(true);
  });
  test('the database itself also refuses a duplicate (constraint backstop)', () => {
    const ins = () => db.prepare("INSERT INTO attendance (student_id,date,session,status,marked_by) VALUES (1,'2026-11-03','MORNING','PRESENT',2)").run();
    ins();
    expect(ins).toThrow(/UNIQUE/);
  });
  test('rejects students from another section and invalid statuses', async () => {
    const body = attendanceBody(sectionId('Class 5 - A'), 'PRESENT');
    body.records.push({ student_id: studentId('Diya Singh'), status: 'PRESENT' });
    expect((await call('asha', 'post', '/api/attendance', body)).status).toBe(400);
    const badStatus = attendanceBody(sectionId('Class 5 - A'), 'MAYBE');
    expect((await call('asha', 'post', '/api/attendance', badStatus)).status).toBe(400);
  });
  test('class and student summaries are correct', async () => {
    const sec = sectionId('Class 5 - A');
    const summary = (await call('asha', 'get', `/api/attendance/summary?section_id=${sec}`)).body.data;
    const aarav = summary.find((s) => s.name === 'Aarav Singh');
    expect(aarav).toMatchObject({ present: 2, absent: 0, late: 0, total: 2, percent: 100 });
    const kabir = summary.find((s) => s.name === 'Kabir Patel');
    expect(kabir).toMatchObject({ present: 1, absent: 1, total: 2, percent: 50 });
    const student = (await call('meera', 'get', `/api/students/${studentId('Aarav Singh')}/attendance`)).body;
    expect(student.summary.total).toBe(2);
  });
  test('audit trail records the action', async () => {
    await call('asha', 'post', '/api/attendance', attendanceBody(sectionId('Class 5 - A'), 'PRESENT'));
    const logs = (await call('admin', 'get', '/api/audit-logs')).body.data;
    expect(logs[0]).toMatchObject({ action: 'MARK_ATTENDANCE', actor: 'Asha Verma' });
  });
});

describe('ACCEPTANCE 3: exam results use configured marks and grading rules', () => {
  test('gradeFor boundaries (unit)', () => {
    const rules = [{ min_percent: 0, grade: 'F' }, { min_percent: 50, grade: 'D' }, { min_percent: 90, grade: 'A+' }];
    expect(gradeFor(rules, 90)).toBe('A+');
    expect(gradeFor(rules, 89.99)).toBe('D');
    expect(gradeFor(rules, 50)).toBe('D');
    expect(gradeFor(rules, 49.99)).toBe('F');
    expect(gradeFor(rules, 0)).toBe('F');
  });
  test('teacher enters marks; percent and grade are computed from the rules', async () => {
    const exam = db.prepare("SELECT id FROM exams WHERE name='Midterm'").get().id;
    const put = await call('asha', 'put', `/api/exams/${exam}/results`, { results: [{ student_id: studentId('Rohan Das'), marks: 85 }] });
    expect(put.status).toBe(200);
    const sheet = (await call('asha', 'get', `/api/exams/${exam}/results`)).body.data;
    expect(sheet.find((r) => r.name === 'Rohan Das')).toMatchObject({ marks: 85, percent: 85, grade: 'A' });
    expect(sheet.find((r) => r.name === 'Aarav Singh')).toMatchObject({ marks: 92, grade: 'A+' });
    expect(sheet.find((r) => r.name === 'Kabir Patel')).toMatchObject({ marks: 78, grade: 'B' });
  });
  test('changing the grading rules changes the grades (configurable, not hard-coded)', async () => {
    const exam = db.prepare("SELECT id FROM exams WHERE name='Midterm'").get().id;
    const res = await call('admin', 'put', '/api/grading-rules', { rules: [{ min_percent: 0, grade: 'Fail' }, { min_percent: 80, grade: 'Pass' }] });
    expect(res.status).toBe(200);
    const sheet = (await call('admin', 'get', `/api/exams/${exam}/results`)).body.data;
    expect(sheet.find((r) => r.name === 'Aarav Singh').grade).toBe('Pass'); // 92%
    expect(sheet.find((r) => r.name === 'Kabir Patel').grade).toBe('Fail'); // 78%
  });
  test('grading rules must cover 0% and be unique', async () => {
    expect((await call('admin', 'put', '/api/grading-rules', { rules: [{ min_percent: 50, grade: 'P' }] })).status).toBe(400);
    expect((await call('admin', 'put', '/api/grading-rules', { rules: [{ min_percent: 0, grade: 'F' }, { min_percent: 0, grade: 'X' }] })).status).toBe(400);
    expect((await call('asha', 'put', '/api/grading-rules', { rules: [{ min_percent: 0, grade: 'F' }] })).status).toBe(403);
  });
  test('rejects marks above the exam total, negative marks, and unassigned teachers', async () => {
    const exam = db.prepare("SELECT id FROM exams WHERE name='Midterm'").get().id;
    const rohan = studentId('Rohan Das');
    expect((await call('asha', 'put', `/api/exams/${exam}/results`, { results: [{ student_id: rohan, marks: 101 }] })).status).toBe(400);
    expect((await call('asha', 'put', `/api/exams/${exam}/results`, { results: [{ student_id: rohan, marks: -1 }] })).status).toBe(400);
    // Ravi teaches English in 5-A, not Maths => 403
    expect((await call('ravi', 'put', `/api/exams/${exam}/results`, { results: [{ student_id: rohan, marks: 50 }] })).status).toBe(403);
    // student from another section
    expect((await call('asha', 'put', `/api/exams/${exam}/results`, { results: [{ student_id: studentId('Diya Singh'), marks: 50 }] })).status).toBe(400);
  });
  test('report card totals and overall grade are correct', async () => {
    const rc = (await call('meera', 'get', `/api/students/${studentId('Aarav Singh')}/report-card`)).body;
    expect(rc.subjects).toHaveLength(2);
    expect(rc.overall).toEqual({ obtained: 132, total: 150, percent: 88, grade: 'A' });
  });
});

describe('ACCEPTANCE 4: guardian sees only the linked student', () => {
  test('guardian lists only their own children', async () => {
    const names = (await call('meera', 'get', '/api/students')).body.data.map((s) => s.name).sort();
    expect(names).toEqual(['Aarav Singh', 'Diya Singh']);
  });
  test('own child: allowed. Another guardian\'s child: 403 on every private endpoint', async () => {
    const own = studentId('Aarav Singh');
    const other = studentId('Kabir Patel');
    for (const p of ['', '/report-card', '/attendance']) {
      expect((await call('meera', 'get', `/api/students/${own}${p}`)).status).toBe(200);
      expect((await call('meera', 'get', `/api/students/${other}${p}`)).status).toBe(403);
    }
    const otherInvoice = db.prepare('SELECT id FROM invoices WHERE student_id = ?').get(other).id;
    expect((await call('meera', 'get', `/api/invoices/${otherInvoice}`)).status).toBe(403);
    expect((await call('meera', 'post', `/api/invoices/${otherInvoice}/payments`, { amount: 100, idempotency_key: 'steal-attempt-1' })).status).toBe(403);
    const invoices = (await call('meera', 'get', '/api/invoices')).body.data;
    expect(invoices.every((i) => ['Aarav Singh', 'Diya Singh'].includes(i.student_name))).toBe(true);
    expect((await call('meera', 'get', `/api/invoices?student_id=${other}`)).body.data).toHaveLength(0);
  });
  test('unknown student gives 404', async () => {
    expect((await call('admin', 'get', '/api/students/9999')).status).toBe(404);
  });
});

describe('ACCEPTANCE 5: fee totals reconcile with the ledger', () => {
  const kabirInvoice = () => db.prepare('SELECT id FROM invoices WHERE student_id = ?').get(studentId('Kabir Patel')).id;
  const pay = (who, id, amount, key) => call(who, 'post', `/api/invoices/${id}/payments`, { amount, idempotency_key: key });

  test('partial payments update paid/outstanding/status', async () => {
    const id = kabirInvoice();
    let res = await pay('arjun', id, 5000, 'pay-key-00001');
    expect(res.status).toBe(201);
    expect(res.body.invoice).toMatchObject({ amount: 20000, paid: 5000, outstanding: 15000, status: 'PARTIAL' });
    res = await pay('admin', id, 15000, 'pay-key-00002');
    expect(res.body.invoice).toMatchObject({ paid: 20000, outstanding: 0, status: 'PAID' });
  });
  test('overpayment is rejected and nothing is written', async () => {
    const id = kabirInvoice();
    const res = await pay('arjun', id, 20001, 'pay-key-00003');
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) n FROM payments WHERE invoice_id = ?').get(id).n).toBe(0);
  });
  test('a retried request with the same idempotency key does not double charge', async () => {
    const id = kabirInvoice();
    const first = await pay('arjun', id, 4000, 'pay-key-00004');
    const retry = await pay('arjun', id, 4000, 'pay-key-00004');
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(db.prepare('SELECT SUM(amount) s FROM payments WHERE invoice_id = ?').get(id).s).toBe(4000);
    // same key but a different amount is a client bug => conflict
    expect((await pay('arjun', id, 9999, 'pay-key-00004')).status).toBe(409);
  });
  test('cannot pay an already-paid invoice (invalid state transition)', async () => {
    const paid = db.prepare('SELECT id FROM invoices WHERE student_id = ?').get(studentId('Diya Singh')).id;
    const res = await pay('meera', paid, 1, 'pay-key-00005');
    expect(res.status).toBe(409);
  });
  test('two payments that together exceed the balance: the second is rejected', async () => {
    const id = kabirInvoice();
    expect((await pay('arjun', id, 15000, 'pay-key-00006')).status).toBe(201);
    expect((await pay('arjun', id, 15000, 'pay-key-00007')).status).toBe(400);
  });
  test('dashboard totals reconcile with the ledger: billed - paid = outstanding', async () => {
    await pay('arjun', kabirInvoice(), 7000, 'pay-key-00008');
    const { fees } = (await call('admin', 'get', '/api/dashboard')).body;
    const ledgerPaid = db.prepare('SELECT SUM(amount) s FROM payments').get().s;
    const billed = db.prepare('SELECT SUM(amount) s FROM invoices').get().s;
    expect(fees.paid).toBe(ledgerPaid);
    expect(fees.billed).toBe(billed);
    expect(fees.outstanding).toBe(billed - ledgerPaid);
    expect(fees.reconciled).toBe(true);
    const report = (await call('admin', 'get', '/api/reports/fees')).body;
    expect(report.data.reduce((a, r) => a + r.outstanding, 0)).toBe(fees.outstanding);
  });
  test('invoice status filter and invoice creation validation', async () => {
    const unpaid = (await call('admin', 'get', '/api/invoices?status=UNPAID')).body;
    expect(unpaid.data.every((i) => i.status === 'UNPAID')).toBe(true);
    expect(unpaid.total).toBe(2);
    expect((await call('admin', 'post', '/api/invoices', { student_id: 1, title: 'X', amount: -5, due_date: '2026-12-01' })).status).toBe(400);
    expect((await call('admin', 'post', '/api/invoices', { student_id: 999, title: 'X', amount: 5, due_date: '2026-12-01' })).status).toBe(404);
  });
});

describe('student portal and timetable', () => {
  test('student login is limited to its linked profile and private records', async () => {
    const own = studentId('Aarav Singh');
    const other = studentId('Kabir Patel');
    const students = (await call('aarav', 'get', '/api/students')).body.data;
    expect(students.map((s) => s.id)).toEqual([own]);
    expect((await call('aarav', 'get', `/api/students/${own}`)).status).toBe(200);
    expect((await call('aarav', 'get', `/api/students/${other}`)).status).toBe(403);
    expect((await call('aarav', 'get', `/api/students/${own}/attendance`)).status).toBe(200);
    expect((await call('aarav', 'get', `/api/students/${other}/report-card`)).status).toBe(403);
    const ownInvoice = db.prepare('SELECT id FROM invoices WHERE student_id=?').get(own).id;
    const otherInvoice = db.prepare('SELECT id FROM invoices WHERE student_id=?').get(studentId('Kabir Patel')).id;
    expect((await call('aarav', 'get', `/api/invoices/${ownInvoice}`)).status).toBe(200);
    expect((await call('aarav', 'get', `/api/invoices/${otherInvoice}`)).status).toBe(403);
    expect((await call('aarav', 'post', `/api/invoices/${ownInvoice}/payments`, { amount: 10, idempotency_key: 'student-pay-001' })).status).toBe(403);
  });

  test('timetable visibility follows student, guardian, and teacher access', async () => {
    const fiveA = sectionId('Class 5 - A');
    const fiveB = sectionId('Class 5 - B');
    const studentEntries = (await call('aarav', 'get', `/api/timetable?section_id=${fiveA}`)).body.data;
    expect(studentEntries).toHaveLength(30);
    expect((await call('aarav', 'get', `/api/timetable?section_id=${fiveB}`)).status).toBe(403);
    const guardianSections = new Set((await call('meera', 'get', '/api/timetable')).body.data.map((e) => e.section_name));
    expect(guardianSections).toEqual(new Set(['A', 'B']));
    const teacherSections = new Set((await call('asha', 'get', '/api/timetable')).body.data.map((e) => e.section_name));
    expect(teacherSections).toEqual(new Set(['A']));
    expect((await call('meera', 'post', '/api/timetable', {})).status).toBe(403);
  });

  test('admin timetable changes validate assignments and reject teacher conflicts', async () => {
    const fiveB = sectionId('Class 5 - B');
    const raviMath = db.prepare('SELECT id FROM assignments WHERE section_id=? AND subject_id=(SELECT id FROM subjects WHERE name=?)')
      .get(fiveB, 'Mathematics').id;
    const conflict = await call('admin', 'post', '/api/timetable', {
      section_id: fiveB, assignment_id: raviMath, weekday: 'MONDAY', period: 4, start_time: '10:45', end_time: '11:30'
    });
    expect(conflict.status).toBe(409);
    const wrongSection = await call('admin', 'post', '/api/timetable', {
      section_id: fiveB, assignment_id: db.prepare('SELECT id FROM assignments WHERE section_id=?').get(sectionId('Class 5 - A')).id,
      weekday: 'MONDAY', period: 4, start_time: '10:45', end_time: '11:30'
    });
    expect(wrongSection.status).toBe(400);
    expect((await call('admin', 'post', '/api/timetable', {
      section_id: fiveB, assignment_id: raviMath, weekday: 'SATURDAY', period: 4, start_time: '10:45', end_time: '11:30'
    })).status).toBe(400);
  });
});

describe('academic administration', () => {
  test('admin can create/search students; duplicates and in-use deletes are conflicts', async () => {
    const guardian = db.prepare("SELECT id FROM users WHERE email='meera.guardian@school.test'").get().id;
    const body = { name: 'Zoya Khan', admission_no: 'ADM100', section_id: sectionId('Class 5 - A'), guardian_id: guardian };
    expect((await call('admin', 'post', '/api/students', body)).status).toBe(201);
    expect((await call('admin', 'post', '/api/students', body)).status).toBe(409); // duplicate admission_no
    const created = db.prepare("SELECT id FROM students WHERE admission_no='ADM100'").get();
    const updated = await call('admin', 'put', `/api/students/${created.id}`, { ...body, name: 'Zoya Ali' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Zoya Ali');
    const found = (await call('admin', 'get', '/api/students?q=zoya')).body;
    expect(found.total).toBe(1);
    expect((await call('admin', 'delete', `/api/sections/${sectionId('Class 5 - A')}`)).status).toBe(409); // still in use
    const page = (await call('admin', 'get', '/api/students?limit=2&page=2')).body;
    expect(page.data).toHaveLength(2);
    expect(page.total).toBe(6);
  });
  test('admin can update/delete teacher and guardian accounts with safe constraints', async () => {
    const create = await call('admin', 'post', '/api/users', {
      name: 'New Teacher', email: 'new.teacher@school.test', role: 'TEACHER', password: 'Teacher@123'
    });
    expect(create.status).toBe(201);
    const id = create.body.id;
    const update = await call('admin', 'put', `/api/users/${id}`, {
      name: 'Updated Teacher', email: 'updated.teacher@school.test', password: ''
    });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ name: 'Updated Teacher', email: 'updated.teacher@school.test', role: 'TEACHER' });
    expect((await call('admin', 'delete', `/api/users/${id}`)).status).toBe(204);
    expect((await call('admin', 'get', `/api/users?role=TEACHER&q=updated.teacher`)).body.total).toBe(0);

    const guardian = db.prepare("SELECT id FROM users WHERE email='meera.guardian@school.test'").get();
    expect((await call('admin', 'delete', `/api/users/${guardian.id}`)).status).toBe(409);
    expect((await call('asha', 'put', `/api/users/${guardian.id}`, { name: 'No', email: 'no@school.test' })).status).toBe(403);
    expect((await call('admin', 'put', `/api/users/${guardian.id}`, {
      name: 'Invalid Password', email: 'meera2@school.test', password: 'short'
    })).status).toBe(400);
  });
  test('admin can create a student login without exposing credentials', async () => {
    const guardian = db.prepare("SELECT id FROM users WHERE email='meera.guardian@school.test'").get().id;
    const created = await call('admin', 'post', '/api/students', {
      name: 'Student Login Test', admission_no: 'STU900', section_id: sectionId('Class 5 - A'), guardian_id: guardian,
      student_login_email: 'student.login@school.test', student_login_password: 'Student@123'
    });
    expect(created.status).toBe(201);
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'student.login@school.test', password: 'Student@123' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user).toMatchObject({ id: created.body.id, role: 'STUDENT' });
    expect(loginRes.body.user).not.toHaveProperty('password_hash');
    expect((await request(app).post('/api/auth/login').send({ email: 'student.login@school.test', password: 'wrong-password' })).status).toBe(401);
  });
  test('student guardian must really be a guardian', async () => {
    const teacher = db.prepare("SELECT id FROM users WHERE role='TEACHER'").get().id;
    const res = await call('admin', 'post', '/api/students', { name: 'A', admission_no: 'X1', section_id: 1, guardian_id: teacher });
    expect(res.status).toBe(400);
  });
});
