'use strict';
// Single-file UI. The server enforces every permission; this only decides what to show.
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Number(n).toLocaleString('en-IN');
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'k-' + Date.now() + '-' + Math.random().toString(16).slice(2));

const state = { token: sessionStorage.getItem('token'), user: JSON.parse(sessionStorage.getItem('user') || 'null') };
const main = $('#main');

// ---------- plumbing ----------
function flash(msg, type = 'ok') {
  $('#status').innerHTML = `<div class="${type}">${esc(msg)}</div>`;
  if (type === 'ok') setTimeout(() => { $('#status').innerHTML = ''; }, 4000);
}
function errText(e) {
  const d = e.details ? ' (' + Object.entries(e.details).map(([k, v]) => `${k}: ${v}`).join(', ') + ')' : '';
  return e.message + d;
}
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) logout('Session expired. Please log in again.');
    const e = new Error(data.error?.message || 'Request failed'); e.details = data.error?.details; throw e;
  }
  return data;
}
// Run an async action; show errors in the status bar instead of crashing the page.
const run = async (fn) => { try { await fn(); } catch (e) { flash(errText(e), 'err'); } };
function form(root, selector, handler) {
  $(selector, root).addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target, btn = $('button[type=submit]', f);
    btn.disabled = true;
    run(() => handler(Object.fromEntries(new FormData(f)), f)).finally(() => { btn.disabled = false; });
  });
}
const loading = (root) => { root.innerHTML = '<p class="loading">Loading…</p>'; };
const options = (list, val, label, sel) => list.map((o) => `<option value="${esc(o[val])}"${String(o[val]) === String(sel) ? ' selected' : ''}>${esc(typeof label === 'function' ? label(o) : o[label])}</option>`).join('');
function table(caption, cols, rows, emptyMsg = 'Nothing here yet.') {
  if (!rows.length) return `<p class="empty">${esc(emptyMsg)}</p>`;
  return `<div class="table-wrap"><table><caption>${esc(caption)}</caption><thead><tr>${cols.map((c) => `<th scope="col" class="${c.cls || ''}">${esc(c.h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.cls || ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const WEEKDAYS = [['MONDAY', 'Monday'], ['TUESDAY', 'Tuesday'], ['WEDNESDAY', 'Wednesday'], ['THURSDAY', 'Thursday'], ['FRIDAY', 'Friday']];
function timetableGrid(entries, editable = false) {
  if (!entries.length) return '<p class="empty">No timetable entries published yet.</p>';
  const slots = new Map(entries.map((entry) => [`${entry.weekday}-${entry.period}`, entry]));
  const content = (entry) => {
    if (!entry) return '<span class="free-period">—</span>';
    return `<div class="timetable-slot"><strong>${esc(entry.subject_name)}</strong><span>${esc(entry.start_time)}–${esc(entry.end_time)}</span><small>${esc(entry.teacher_name)}</small>
      ${editable ? `<div class="slot-actions"><button class="secondary small" data-edit-slot="${entry.id}">Edit</button><button class="danger small" data-delete-slot="${entry.id}">Delete</button></div>` : ''}</div>`;
  };
  return `<div class="table-wrap timetable-wrap"><table class="timetable"><caption>Weekly timetable</caption><thead><tr><th scope="col">Period</th>${WEEKDAYS.map(([, day]) => `<th scope="col">${day}</th>`).join('')}</tr></thead>
    <tbody>${Array.from({ length: 6 }, (_, index) => `<tr><th scope="row">Period ${index + 1}</th>${WEEKDAYS.map(([day]) => `<td>${content(slots.get(`${day}-${index + 1}`))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const pager = (p) => `<div class="pager"><button class="secondary small" data-page="${p.page - 1}" ${p.page <= 1 ? 'disabled' : ''}>Previous</button>
  <span>Page ${p.page} of ${Math.max(1, Math.ceil(p.total / p.limit))} · ${p.total} total</span>
  <button class="secondary small" data-page="${p.page + 1}" ${p.page * p.limit >= p.total ? 'disabled' : ''}>Next</button></div>`;
const pill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// ---------- login / shell ----------
function logout(msg) {
  sessionStorage.clear(); state.token = null; state.user = null;
  start(); if (msg) flash(msg, 'err');
}
$('#logout').onclick = () => logout();

const DEMO = [['Admin', 'admin@school.test', 'Admin@123'], ['Teacher (Class 5-A only)', 'asha.teacher@school.test', 'Teacher@123'],
  ['Teacher (5-A and 5-B)', 'ravi.teacher@school.test', 'Teacher@123'], ['Guardian Meera', 'meera.guardian@school.test', 'Guardian@123'],
  ['Guardian Arjun', 'arjun.guardian@school.test', 'Guardian@123'], ['Student Aarav', 'aarav.student@school.test', 'Student@123']];

function viewLogin() {
  $('#top').hidden = true; $('#tabs').hidden = true;
  main.innerHTML = `<section class="card login"><h1>Sign in</h1>
    <form id="f"><div class="row"><div><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="username"></div></div>
    <div class="row"><div><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password"></div></div>
    <button type="submit">Log in</button></form>
    <p class="hint">Demo accounts (synthetic data only):</p>
    <div class="row">${DEMO.map((d, i) => `<button type="button" class="secondary small" data-demo="${i}">${esc(d[0])}</button>`).join('')}</div></section>`;
  main.onclick = (e) => { const b = e.target.closest('[data-demo]'); if (b) { $('#email').value = DEMO[b.dataset.demo][1]; $('#password').value = DEMO[b.dataset.demo][2]; } };
  form(main, '#f', async (v) => {
    const r = await api('POST', '/auth/login', v);
    state.token = r.token; state.user = r.user;
    sessionStorage.setItem('token', r.token); sessionStorage.setItem('user', JSON.stringify(r.user));
    start();
  });
}

const TABS = {
  ADMIN: [['Dashboard', viewDashboard], ['Students', viewStudents], ['People', viewPeople], ['Structure', viewStructure], ['Timetable', viewTimetable], ['Attendance', viewAttendance], ['Exams', viewExams], ['Fees', viewFees], ['Audit log', viewAudit]],
  TEACHER: [['Attendance', viewAttendance], ['Exams & marks', viewExams], ['Timetable', viewTeacherTimetable]],
  GUARDIAN: [['My children', viewChildren]],
  STUDENT: [['My portal', viewChildren]]
};
function start() {
  if (!state.token) return viewLogin();
  $('#top').hidden = false; $('#tabs').hidden = false;
  $('#who').textContent = `${state.user.name} (${state.user.role.toLowerCase()})`;
  const tabs = TABS[state.user.role];
  $('#tabs').innerHTML = tabs.map((t, i) => `<button data-tab="${i}">${esc(t[0])}</button>`).join('');
  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) openTab(+b.dataset.tab); };
  openTab(0);
}
function openTab(i) {
  const [label, view] = TABS[state.user.role][i];
  document.querySelectorAll('#tabs button').forEach((b, j) => (j === i ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  main.onclick = null; $('#status').innerHTML = '';
  main.innerHTML = `<h1>${esc(label)}</h1><div id="view"></div>`;
  const root = $('#view'); loading(root);
  run(() => view(root));
}

// ---------- admin: dashboard ----------
async function viewDashboard(root) {
  const [d, fr, ac] = await Promise.all([api('GET', '/dashboard'), api('GET', '/reports/fees?limit=10'), api('GET', '/reports/academic')]);
  const t = (label, v) => `<div class="tile"><span class="muted">${esc(label)}</span><b>${esc(v)}</b></div>`;
  root.innerHTML = `<div class="tiles">${t('Students', d.counts.students)}${t('Teachers', d.counts.teachers)}${t('Guardians', d.counts.guardians)}${t('Sections', d.counts.sections)}
    ${t('Present today', d.attendanceToday.PRESENT)}${t('Absent today', d.attendanceToday.ABSENT)}${t('Late today', d.attendanceToday.LATE)}</div>
    <section class="card"><h2>Fees ledger</h2><div class="tiles">${t('Billed', money(d.fees.billed))}${t('Paid', money(d.fees.paid))}${t('Outstanding', money(d.fees.outstanding))}
    ${t('Reconciled', d.fees.reconciled ? 'Yes ✔' : 'NO ✖')}</div>
    ${table('Outstanding by student (top 10)', [{ h: 'Student', f: (r) => esc(r.name) }, { h: 'Billed', cls: 'num', f: (r) => money(r.billed) }, { h: 'Paid', cls: 'num', f: (r) => money(r.paid) }, { h: 'Outstanding', cls: 'num', f: (r) => money(r.outstanding) }], fr.data, 'No invoices yet.')}</section>
    <section class="card"><h2>Academic report</h2>${table('Average score per exam', [{ h: 'Exam', f: (r) => esc(r.name) }, { h: 'Section', f: (r) => esc(r.section_label) }, { h: 'Subject', f: (r) => esc(r.subject_name) }, { h: 'Results entered', cls: 'num', f: (r) => r.entered }, { h: 'Average %', cls: 'num', f: (r) => r.average_percent ?? '—' }], ac.data, 'No exams yet.')}</section>`;
}

// ---------- admin: students ----------
async function viewStudents(root) {
  const [secs, guardians] = await Promise.all([api('GET', '/sections'), api('GET', '/users?role=GUARDIAN&limit=100')]);
  const f = { q: '', section_id: '', page: 1, limit: 8 };
  let editingStudent = null;
  root.innerHTML = `<section class="card"><h2>Add student</h2><form id="add"><div class="row">
    <div><label for="n">Name</label><input id="n" name="name" required></div><div><label for="a">Admission no.</label><input id="a" name="admission_no" required></div>
    <div><label for="s">Section</label><select id="s" name="section_id">${options(secs.data, 'id', 'label')}</select></div>
    <div><label for="g">Guardian</label><select id="g" name="guardian_id">${options(guardians.data, 'id', 'name')}</select></div>
    <div><label for="studentEmail">Student login email (optional)</label><input id="studentEmail" name="student_login_email" type="email" autocomplete="off"></div>
    <div><label for="studentPassword">Initial / new password</label><input id="studentPassword" name="student_login_password" type="password" minlength="8" autocomplete="new-password"></div>
    <button type="submit">Add</button><button type="button" class="secondary" id="cancelStudentEdit" hidden>Cancel edit</button></div></form></section>
    <section class="card"><form id="flt" class="row"><div><label for="q">Search name / admission no.</label><input id="q" name="q" type="search"></div>
    <div><label for="fs">Section</label><select id="fs" name="section_id"><option value="">All</option>${options(secs.data, 'id', 'label')}</select></div><button type="submit" class="secondary">Filter</button></form><div id="list"></div></section>`;
  const list = $('#list', root);
  const load = () => run(async () => {
    list.innerHTML = '<p class="loading">Loading…</p>';
    const r = await api('GET', '/students?' + qs(f));
    list.innerHTML = table('Students', [{ h: 'Name', f: (s) => esc(s.name) }, { h: 'Admission', f: (s) => esc(s.admission_no) }, { h: 'Section', f: (s) => esc(s.section_label) }, { h: 'Guardian', f: (s) => esc(s.guardian_name) },
      { h: '', f: (s) => `<button class="secondary small" data-edit-student="${s.id}">Edit</button> <button class="danger small" data-del="${s.id}" aria-label="Delete ${esc(s.name)}">Delete</button>` }], r.data, 'No students match.') + pager(r);
  });
  form(root, '#add', async (v, el) => {
    const body = {
      name: v.name, admission_no: v.admission_no, section_id: +v.section_id, guardian_id: +v.guardian_id,
      student_login_email: v.student_login_email, student_login_password: v.student_login_password
    };
    if (!editingStudent && body.student_login_email && !body.student_login_password) throw new Error('An initial password is required for a student login');
    await api(editingStudent ? 'PUT' : 'POST', editingStudent ? `/students/${editingStudent.id}` : '/students', body);
    flash(editingStudent ? 'Student updated' : 'Student added'); el.reset(); editingStudent = null;
    $('#add button[type=submit]', root).textContent = 'Add'; $('#cancelStudentEdit', root).hidden = true;
    f.page = 1; load();
  });
  form(root, '#flt', async (v) => { f.q = v.q; f.section_id = v.section_id; f.page = 1; load(); });
  root.onclick = (e) => {
    const p = e.target.closest('[data-page]'); if (p) { f.page = +p.dataset.page; load(); }
    const edit = e.target.closest('[data-edit-student]');
    if (edit) run(async () => {
      const s = await api('GET', '/students/' + edit.dataset.editStudent);
      editingStudent = s; $('#n', root).value = s.name; $('#a', root).value = s.admission_no;
      $('#s', root).value = s.section_id; $('#g', root).value = s.guardian_id;
      $('#studentEmail', root).value = s.student_login_email || ''; $('#studentPassword', root).value = '';
      $('#add button[type=submit]', root).textContent = 'Save changes'; $('#cancelStudentEdit', root).hidden = false;
      $('#add', root).scrollIntoView({ behavior: 'smooth' });
    });
    const d = e.target.closest('[data-del]');
    if (d && confirm('Delete this student?')) run(async () => { await api('DELETE', '/students/' + d.dataset.del); flash('Student deleted'); load(); });
  };
  $('#cancelStudentEdit', root).onclick = () => {
    editingStudent = null; $('#add', root).reset(); $('#add button[type=submit]', root).textContent = 'Add';
    $('#cancelStudentEdit', root).hidden = true;
  };
  load();
}

// ---------- admin: teachers & guardians ----------
async function viewPeople(root) {
  const f = { role: 'TEACHER', q: '', page: 1, limit: 8 };
  let editingUser = null;
  root.innerHTML = `<section class="card"><h2>Add teacher or guardian</h2><form id="add"><div class="row">
    <div><label for="n">Name</label><input id="n" name="name" required></div><div><label for="e">Email</label><input id="e" name="email" type="email" required></div>
    <div><label for="p">Password (min 8; leave blank when editing)</label><input id="p" name="password" type="password" minlength="8" autocomplete="new-password"></div>
    <div><label for="r">Role</label><select id="r" name="role"><option>TEACHER</option><option>GUARDIAN</option></select></div>
    <button type="submit">Add</button><button type="button" class="secondary" id="cancelUserEdit" hidden>Cancel edit</button></div></form></section>
    <section class="card"><form id="flt" class="row"><div><label for="fr">Show</label><select id="fr" name="role"><option>TEACHER</option><option>GUARDIAN</option></select></div>
    <div><label for="q">Search</label><input id="q" name="q" type="search"></div><button type="submit" class="secondary">Filter</button></form><div id="list"></div></section>`;
  const list = $('#list', root);
  const load = () => run(async () => {
    list.innerHTML = '<p class="loading">Loading…</p>';
    const r = await api('GET', '/users?' + qs(f));
    list.innerHTML = table(f.role === 'TEACHER' ? 'Teachers' : 'Guardians', [{ h: 'Name', f: (u) => esc(u.name) }, { h: 'Email', f: (u) => esc(u.email) },
      { h: '', f: (u) => `<button class="secondary small" data-edit-user="${u.id}" data-user-role="${u.role}" data-user-name="${esc(u.name)}" data-user-email="${esc(u.email)}">Edit</button> <button class="danger small" data-del-user="${u.id}" aria-label="Delete ${esc(u.name)}">Delete</button>` }], r.data, 'No users match.') + pager(r);
  });
  form(root, '#add', async (v, el) => {
    if (editingUser) {
      await api('PUT', `/users/${editingUser.id}`, { name: v.name, email: v.email, password: v.password });
      flash('User updated'); editingUser = null;
    } else {
      if (!v.password || v.password.length < 8) throw new Error('Password must be at least 8 characters');
      await api('POST', '/users', { name: v.name, email: v.email, password: v.password, role: v.role });
      flash('User created');
    }
    el.reset(); $('#r', root).disabled = false; $('#add button[type=submit]', root).textContent = 'Add';
    $('#cancelUserEdit', root).hidden = true; load();
  });
  form(root, '#flt', async (v) => { f.role = v.role; f.q = v.q; f.page = 1; load(); });
  root.onclick = (e) => {
    const p = e.target.closest('[data-page]'); if (p) { f.page = +p.dataset.page; load(); }
    const edit = e.target.closest('[data-edit-user]');
    if (edit) {
      editingUser = { id: Number(edit.dataset.editUser) };
      $('#n', root).value = edit.dataset.userName; $('#e', root).value = edit.dataset.userEmail; $('#p', root).value = '';
      $('#r', root).value = edit.dataset.userRole; $('#r', root).disabled = true;
      $('#add button[type=submit]', root).textContent = 'Save changes'; $('#cancelUserEdit', root).hidden = false;
      $('#add', root).scrollIntoView({ behavior: 'smooth' });
    }
    const del = e.target.closest('[data-del-user]');
    if (del && confirm('Delete this account? Accounts linked to students or teaching assignments cannot be deleted.')) {
      run(async () => { await api('DELETE', '/users/' + del.dataset.delUser); flash('User deleted'); load(); });
    }
  };
  $('#cancelUserEdit', root).onclick = () => {
    editingUser = null; $('#add', root).reset(); $('#r', root).disabled = false;
    $('#add button[type=submit]', root).textContent = 'Add'; $('#cancelUserEdit', root).hidden = true;
  };
  load();
}

// ---------- admin: classes, sections, subjects, assignments ----------
async function viewStructure(root) {
  const draw = async () => {
    const [classes, sections, subjects, assigns, teachers] = await Promise.all([api('GET', '/classes'), api('GET', '/sections'), api('GET', '/subjects'), api('GET', '/assignments'), api('GET', '/users?role=TEACHER&limit=100')]);
    const del = (path, id) => `<button class="danger small" data-del="${path}/${id}">Delete</button>`;
    root.innerHTML = `<div class="row"><section class="card" style="flex:1 1 300px"><h2>Classes</h2><form id="fc" class="row"><div><label for="cn">New class</label><input id="cn" name="name" required></div><button type="submit">Add</button></form>
      ${table('Classes', [{ h: 'Name', f: (c) => esc(c.name) }, { h: '', f: (c) => del('classes', c.id) }], classes.data)}</section>
      <section class="card" style="flex:1 1 300px"><h2>Subjects</h2><form id="fs" class="row"><div><label for="sn">New subject</label><input id="sn" name="name" required></div><button type="submit">Add</button></form>
      ${table('Subjects', [{ h: 'Name', f: (c) => esc(c.name) }, { h: '', f: (c) => del('subjects', c.id) }], subjects.data)}</section></div>
      <section class="card"><h2>Sections</h2><form id="fsec" class="row"><div><label for="sc">Class</label><select id="sc" name="class_id">${options(classes.data, 'id', 'name')}</select></div>
      <div><label for="sname">Section name</label><input id="sname" name="name" required placeholder="A"></div><button type="submit">Add</button></form>
      ${table('Sections', [{ h: 'Section', f: (s) => esc(s.label) }, { h: '', f: (s) => del('sections', s.id) }], sections.data)}</section>
      <section class="card"><h2>Teacher assignments</h2><form id="fa" class="row"><div><label for="at">Teacher</label><select id="at" name="teacher_id">${options(teachers.data, 'id', 'name')}</select></div>
      <div><label for="as">Section</label><select id="as" name="section_id">${options(sections.data, 'id', 'label')}</select></div>
      <div><label for="aj">Subject</label><select id="aj" name="subject_id">${options(subjects.data, 'id', 'name')}</select></div><button type="submit">Assign</button></form>
      ${table('Assignments', [{ h: 'Teacher', f: (a) => esc(a.teacher_name) }, { h: 'Section', f: (a) => esc(a.section_label) }, { h: 'Subject', f: (a) => esc(a.subject_name) }, { h: '', f: (a) => del('assignments', a.id) }], assigns.data)}</section>`;
    const add = (sel, path, conv = (v) => v) => form(root, sel, async (v) => { await api('POST', path, conv(v)); flash('Saved'); draw(); });
    add('#fc', '/classes'); add('#fs', '/subjects');
    add('#fsec', '/sections', (v) => ({ class_id: +v.class_id, name: v.name }));
    add('#fa', '/assignments', (v) => ({ teacher_id: +v.teacher_id, section_id: +v.section_id, subject_id: +v.subject_id }));
  };
  root.onclick = (e) => { const d = e.target.closest('[data-del]'); if (d && confirm('Delete this item?')) run(async () => { await api('DELETE', '/' + d.dataset.del); flash('Deleted'); draw(); }); };
  await draw();
}

// ---------- timetable ----------
async function viewTimetable(root) {
  const [sections, assignments] = await Promise.all([
    api('GET', '/sections'),
    api('GET', '/assignments')
  ]);
  if (!sections.data.length) { root.innerHTML = '<p class="empty">Create a section before building its timetable.</p>'; return; }
  let editingSlot = null;
  root.innerHTML = `<section class="card"><h2>Manage timetable</h2><form id="timetableForm"><div class="row">
    <div><label for="scheduleSection">Section</label><select id="scheduleSection" name="section_id">${options(sections.data, 'id', 'label')}</select></div>
    <div><label for="scheduleDay">Day</label><select id="scheduleDay" name="weekday">${WEEKDAYS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>
    <div><label for="schedulePeriod">Period</label><select id="schedulePeriod" name="period">${Array.from({ length: 6 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></div>
    <div><label for="scheduleAssignment">Subject and teacher</label><select id="scheduleAssignment" name="assignment_id" required></select></div>
    <div><label for="scheduleStart">Starts</label><input id="scheduleStart" name="start_time" type="time" value="08:00" required></div>
    <div><label for="scheduleEnd">Ends</label><input id="scheduleEnd" name="end_time" type="time" value="08:45" required></div>
    <button type="submit">Add period</button><button type="button" class="secondary" id="cancelSlotEdit" hidden>Cancel edit</button>
    </div></form><p class="hint">A section or teacher cannot have overlapping timetable times.</p></section>
    <section class="card"><div id="weeklySchedule"></div></section>`;
  const section = $('#scheduleSection', root);
  const assignment = $('#scheduleAssignment', root);
  const schedule = $('#weeklySchedule', root);
  let entries = [];
  const setAssignments = (sectionId, selectedId) => {
    const matching = assignments.data.filter((a) => String(a.section_id) === String(sectionId));
    assignment.innerHTML = options(matching, 'id', (a) => `${a.subject_name} — ${a.teacher_name}`, selectedId);
  };
  const load = () => run(async () => {
    schedule.innerHTML = '<p class="loading">Loading timetable…</p>';
    entries = (await api('GET', `/timetable?section_id=${section.value}`)).data;
    schedule.innerHTML = timetableGrid(entries, true);
  });
  setAssignments(section.value);
  section.onchange = () => { setAssignments(section.value); load(); };
  form(root, '#timetableForm', async (v, el) => {
    const body = { ...v, section_id: +v.section_id, assignment_id: +v.assignment_id, period: +v.period };
    await api(editingSlot ? 'PUT' : 'POST', editingSlot ? `/timetable/${editingSlot.id}` : '/timetable', body);
    flash(editingSlot ? 'Timetable period updated' : 'Timetable period added');
    editingSlot = null; el.reset(); $('#scheduleStart', root).value = '08:00'; $('#scheduleEnd', root).value = '08:45';
    $('#timetableForm button[type=submit]', root).textContent = 'Add period'; $('#cancelSlotEdit', root).hidden = true;
    setAssignments(section.value); load();
  });
  root.onclick = (event) => {
    const edit = event.target.closest('[data-edit-slot]');
    if (edit) {
      const entry = entries.find((item) => item.id === Number(edit.dataset.editSlot));
      if (!entry) return;
      editingSlot = entry;
      section.value = String(entry.section_id); setAssignments(section.value, entry.assignment_id);
      $('#scheduleDay', root).value = entry.weekday; $('#schedulePeriod', root).value = String(entry.period);
      $('#scheduleStart', root).value = entry.start_time; $('#scheduleEnd', root).value = entry.end_time;
      $('#timetableForm button[type=submit]', root).textContent = 'Save period'; $('#cancelSlotEdit', root).hidden = false;
      $('#timetableForm', root).scrollIntoView({ behavior: 'smooth' });
    }
    const del = event.target.closest('[data-delete-slot]');
    if (del && confirm('Delete this timetable period?')) {
      run(async () => { await api('DELETE', '/timetable/' + del.dataset.deleteSlot); flash('Timetable period deleted'); load(); });
    }
  };
  $('#cancelSlotEdit', root).onclick = () => {
    editingSlot = null; $('#timetableForm', root).reset();
    $('#scheduleStart', root).value = '08:00'; $('#scheduleEnd', root).value = '08:45';
    $('#timetableForm button[type=submit]', root).textContent = 'Add period'; $('#cancelSlotEdit', root).hidden = true;
    setAssignments(section.value);
  };
  load();
}

async function viewTeacherTimetable(root) {
  const sections = (await api('GET', '/sections')).data;
  if (!sections.length) { root.innerHTML = '<p class="empty">No assigned sections yet.</p>'; return; }
  root.innerHTML = `<section class="card"><div class="row"><div><label for="teacherScheduleSection">Assigned section</label>
    <select id="teacherScheduleSection">${options(sections, 'id', 'label')}</select></div></div></section><section class="card"><div id="weeklySchedule"></div></section>`;
  const section = $('#teacherScheduleSection', root);
  const schedule = $('#weeklySchedule', root);
  const load = () => run(async () => {
    schedule.innerHTML = '<p class="loading">Loading timetable…</p>';
    const entries = (await api('GET', `/timetable?section_id=${section.value}`)).data;
    schedule.innerHTML = timetableGrid(entries);
  });
  section.onchange = load;
  load();
}

// ---------- attendance (admin + teacher) ----------
async function viewAttendance(root) {
  const secs = (await api('GET', '/sections')).data;
  if (!secs.length) { root.innerHTML = '<p class="empty">You are not assigned to any class yet.</p>'; return; }
  root.innerHTML = `<section class="card"><form id="pick" class="row"><div><label for="sec">Section</label><select id="sec" name="section_id">${options(secs, 'id', 'label')}</select></div>
    <div><label for="dt">Date</label><input id="dt" name="date" type="date" value="${today()}" required></div>
    <div><label for="ss">Session</label><select id="ss" name="session"><option>MORNING</option><option>AFTERNOON</option></select></div><button type="submit">Load class</button></form>
    <div id="sheet"></div></section><section class="card"><h2>Class summary</h2><div id="sum"></div></section>`;
  const summary = (sec) => run(async () => {
    const r = await api('GET', '/attendance/summary?section_id=' + sec);
    $('#sum', root).innerHTML = table('Attendance summary (all dates)', [{ h: 'Student', f: (s) => esc(s.name) }, { h: 'Present', cls: 'num', f: (s) => s.present }, { h: 'Late', cls: 'num', f: (s) => s.late }, { h: 'Absent', cls: 'num', f: (s) => s.absent }, { h: 'Attendance %', cls: 'num', f: (s) => s.percent ?? '—' }], r.data, 'No students in this section.');
  });
  form(root, '#pick', async (v) => {
    const sheet = $('#sheet', root); sheet.innerHTML = '<p class="loading">Loading…</p>';
    const [studs, existing] = await Promise.all([api('GET', `/students?section_id=${v.section_id}&limit=100`), api('GET', `/attendance?${qs(v)}`)]);
    const prev = Object.fromEntries(existing.data.map((x) => [x.student_id, x.status]));
    if (!studs.data.length) { sheet.innerHTML = '<p class="empty">No students in this section.</p>'; return; }
    sheet.innerHTML = `<form id="mark"><div class="table-wrap"><table><caption>Mark attendance — ${esc(v.date)}, ${esc(v.session.toLowerCase())}${existing.data.length ? ' (already recorded; saving will update)' : ''}</caption>
      <thead><tr><th scope="col">Student</th><th scope="col">Status</th></tr></thead><tbody>${studs.data.map((s) => `<tr><td><label for="st${s.id}" style="margin:0;color:inherit">${esc(s.name)}</label></td>
      <td><select id="st${s.id}" data-sid="${s.id}">${['PRESENT', 'ABSENT', 'LATE'].map((x) => `<option${(prev[s.id] || 'PRESENT') === x ? ' selected' : ''}>${x}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>
      <button type="submit">Save attendance</button></form>`;
    form(sheet, '#mark', async () => {
      const records = [...sheet.querySelectorAll('select[data-sid]')].map((s) => ({ student_id: +s.dataset.sid, status: s.value }));
      await api('POST', '/attendance', { section_id: +v.section_id, date: v.date, session: v.session, records });
      flash('Attendance saved'); summary(v.section_id);
    });
    summary(v.section_id);
  });
  $('#pick', root).requestSubmit();
}

// ---------- exams & marks (admin + teacher) ----------
async function viewExams(root) {
  const admin = state.user.role === 'ADMIN';
  const f = { page: 1, limit: 6 };
  let create = '';
  let secs, subs;
  if (admin) {
    [secs, subs] = (await Promise.all([api('GET', '/sections'), api('GET', '/subjects')])).map((r) => r.data);
    create = `<section class="card"><h2>Create exam</h2><form id="add"><div class="row"><div><label for="en">Name</label><input id="en" name="name" required placeholder="Midterm"></div>
      <div><label for="es">Section</label><select id="es" name="section_id">${options(secs, 'id', 'label')}</select></div><div><label for="ej">Subject</label><select id="ej" name="subject_id">${options(subs, 'id', 'name')}</select></div>
      <div><label for="et">Total marks</label><input id="et" name="total_marks" type="number" min="1" step="1" required value="100"></div><div><label for="ed">Date</label><input id="ed" name="exam_date" type="date" value="${today()}" required></div>
      <button type="submit">Create</button></div></form></section>`;
  }
  root.innerHTML = `${create}<section class="card"><div id="list"></div></section><section class="card" id="marks" hidden></section>
    ${admin ? '<section class="card"><h2>Grading rules</h2><p class="hint">One rule per line: <code>minimum% grade</code>. A score gets the grade with the highest minimum it reaches. One line must start at 0.</p><form id="gr"><label for="rules">Rules</label><textarea id="rules" rows="6"></textarea><div class="row" style="margin-top:8px"><button type="submit">Save rules</button></div></form></section>' : ''}`;
  const list = $('#list', root);
  const load = () => run(async () => {
    const r = await api('GET', '/exams?' + qs(f));
    list.innerHTML = table('Exams', [{ h: 'Exam', f: (e) => esc(e.name) }, { h: 'Section', f: (e) => esc(e.section_label) }, { h: 'Subject', f: (e) => esc(e.subject_name) }, { h: 'Total', cls: 'num', f: (e) => e.total_marks }, { h: 'Date', f: (e) => esc(e.exam_date) },
      { h: '', f: (e) => `<button class="small" data-exam="${e.id}">Enter / view marks</button>` }], r.data, 'No exams available.') + pager(r);
  });
  if (admin) {
    form(root, '#add', async (v, el) => { await api('POST', '/exams', { name: v.name, section_id: +v.section_id, subject_id: +v.subject_id, total_marks: +v.total_marks, exam_date: v.exam_date }); flash('Exam created'); el.reset(); load(); });
    const loadRules = () => run(async () => { $('#rules', root).value = (await api('GET', '/grading-rules')).data.map((x) => `${x.min_percent} ${x.grade}`).join('\n'); });
    form(root, '#gr', async (v) => {
      const rules = v.rules.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [m, ...g] = l.split(/\s+/); return { min_percent: Number(m), grade: g.join(' ') }; });
      await api('PUT', '/grading-rules', { rules }); flash('Grading rules saved'); loadRules();
    });
    loadRules();
  }
  root.onclick = (e) => {
    const p = e.target.closest('[data-page]'); if (p) { f.page = +p.dataset.page; load(); }
    const x = e.target.closest('[data-exam]'); if (x) run(() => marksSheet($('#marks', root), x.dataset.exam));
  };
  load();
}
async function marksSheet(host, examId) {
  host.hidden = false; host.innerHTML = '<p class="loading">Loading…</p>';
  const r = await api('GET', `/exams/${examId}/results`);
  host.innerHTML = `<h2>${esc(r.exam.name)} — ${esc(r.exam.subject_name)}, ${esc(r.exam.section_label)} (out of ${r.exam.total_marks})</h2>
    <form id="mk"><div class="table-wrap"><table><caption>Marks sheet</caption><thead><tr><th scope="col">Student</th><th scope="col">Marks</th><th scope="col" class="num">%</th><th scope="col">Grade</th></tr></thead><tbody>
    ${r.data.map((s) => `<tr><td><label for="m${s.student_id}" style="margin:0;color:inherit">${esc(s.name)}</label></td><td><input id="m${s.student_id}" data-sid="${s.student_id}" type="number" min="0" max="${r.exam.total_marks}" step="0.5" value="${s.marks ?? ''}" style="width:110px"></td>
    <td class="num">${s.percent ?? '—'}</td><td>${esc(s.grade ?? '—')}</td></tr>`).join('')}</tbody></table></div>
    <div class="row" style="margin-top:8px"><button type="submit">Save marks</button></div></form>`;
  form(host, '#mk', async () => {
    const results = [...host.querySelectorAll('input[data-sid]')].filter((i) => i.value !== '').map((i) => ({ student_id: +i.dataset.sid, marks: Number(i.value) }));
    if (!results.length) throw new Error('Enter at least one mark');
    await api('PUT', `/exams/${examId}/results`, { results }); flash('Marks saved'); marksSheet(host, examId);
  });
  host.scrollIntoView({ behavior: 'smooth' });
}

// ---------- fees ----------
// Shared invoice panel: ledger + simulated payment form (admin or the student's guardian).
async function invoicePanel(host, id, onChange) {
  host.hidden = false; host.innerHTML = '<p class="loading">Loading…</p>';
  const inv = await api('GET', '/invoices/' + id);
  host.innerHTML = `<h2>Invoice #${inv.id}: ${esc(inv.title)} — ${esc(inv.student_name)}</h2><p>Total ${money(inv.amount)} · Paid ${money(inv.paid)} · <strong>Outstanding ${money(inv.outstanding)}</strong> ${pill(inv.status)}</p>
    ${table('Ledger', [{ h: 'Payment', f: (p) => '#' + p.id }, { h: 'Date', f: (p) => esc(p.paid_at) }, { h: 'Method', f: (p) => esc(p.method) }, { h: 'Amount', cls: 'num', f: (p) => money(p.amount) }], inv.ledger, 'No payments yet.')}
    ${inv.outstanding > 0 ? `<form id="pay" class="row" style="margin-top:10px"><div><label for="amt">Pay amount (simulated, whole rupees)</label><input id="amt" name="amount" type="number" min="1" max="${inv.outstanding}" step="1" value="${inv.outstanding}" required></div><button type="submit">Pay (simulated)</button></form>` : '<p class="hint">Fully paid.</p>'}`;
  const key = uuid(); // same key if the request is retried => the server never charges twice
  if (inv.outstanding > 0) form(host, '#pay', async (v) => {
    const r = await api('POST', `/invoices/${id}/payments`, { amount: +v.amount, idempotency_key: key });
    flash(r.replayed ? 'This payment was already recorded' : 'Payment recorded'); onChange(); invoicePanel(host, id, onChange);
  });
}
function invoiceTable(rows, withStudent = true, allowPay = true) {
  return table('Invoices', [...(withStudent ? [{ h: 'Student', f: (i) => esc(i.student_name) }] : []), { h: 'Title', f: (i) => esc(i.title) }, { h: 'Due', f: (i) => esc(i.due_date) }, { h: 'Amount', cls: 'num', f: (i) => money(i.amount) },
    { h: 'Paid', cls: 'num', f: (i) => money(i.paid) }, { h: 'Outstanding', cls: 'num', f: (i) => money(i.outstanding) }, { h: 'Status', f: (i) => pill(i.status) },
    ...(allowPay ? [{ h: '', f: (i) => `<button class="small" data-inv="${i.id}">${i.outstanding > 0 ? 'Ledger / pay' : 'Ledger'}</button>` }] : [])], rows, 'No invoices.');
}
async function viewFees(root) {
  const studs = (await api('GET', '/students?limit=100')).data;
  const f = { status: '', page: 1, limit: 6 };
  root.innerHTML = `<section class="card"><h2>Create invoice</h2><form id="add"><div class="row"><div><label for="is">Student</label><select id="is" name="student_id">${options(studs, 'id', (s) => `${s.name} (${s.admission_no})`)}</select></div>
    <div><label for="it">Title</label><input id="it" name="title" required placeholder="Term 2 Tuition"></div><div><label for="ia">Amount (₹)</label><input id="ia" name="amount" type="number" min="1" step="1" required></div>
    <div><label for="id">Due date</label><input id="id" name="due_date" type="date" required></div><button type="submit">Create</button></div></form></section>
    <section class="card"><form id="flt" class="row"><div><label for="st">Status</label><select id="st" name="status"><option value="">All</option><option>UNPAID</option><option>PARTIAL</option><option>PAID</option></select></div><button type="submit" class="secondary">Filter</button></form><div id="list"></div></section>
    <section class="card" id="panel" hidden></section>`;
  const list = $('#list', root);
  const load = () => run(async () => { const r = await api('GET', '/invoices?' + qs(f)); list.innerHTML = invoiceTable(r.data) + pager(r); });
  form(root, '#add', async (v, el) => { await api('POST', '/invoices', { student_id: +v.student_id, title: v.title, amount: +v.amount, due_date: v.due_date }); flash('Invoice created'); el.reset(); load(); });
  form(root, '#flt', async (v) => { f.status = v.status; f.page = 1; load(); });
  root.onclick = (e) => {
    const p = e.target.closest('[data-page]'); if (p) { f.page = +p.dataset.page; load(); }
    const i = e.target.closest('[data-inv]'); if (i) run(() => invoicePanel($('#panel', root), i.dataset.inv, load));
  };
  load();
}

// ---------- admin: audit trail ----------
async function viewAudit(root) {
  const f = { page: 1, limit: 15 };
  const load = () => run(async () => {
    const r = await api('GET', '/audit-logs?' + qs(f));
    root.innerHTML = `<section class="card">${table('Audit trail (newest first)', [{ h: 'When (UTC)', f: (l) => esc(l.created_at) }, { h: 'Who', f: (l) => esc(l.actor ?? 'system') }, { h: 'Action', f: (l) => esc(l.action) }, { h: 'Entity', f: (l) => esc(l.entity + (l.entity_id ? ' #' + l.entity_id : '')) }, { h: 'Details', f: (l) => `<code>${esc(l.details ?? '')}</code>` }], r.data, 'No activity yet.')}${pager(r)}</section>`;
  });
  root.onclick = (e) => { const p = e.target.closest('[data-page]'); if (p) { f.page = +p.dataset.page; load(); } };
  await load();
}

// ---------- guardian ----------
async function viewChildren(root) {
  const isStudent = state.user.role === 'STUDENT';
  const kids = (await api('GET', '/students?limit=100')).data;
  if (!kids.length) { root.innerHTML = `<p class="empty">${isStudent ? 'Student profile is not linked to this account.' : 'No students are linked to your account.'}</p>`; return; }
  root.innerHTML = `${isStudent ? '' : `<section class="card"><div class="row"><div><label for="kid">Child</label><select id="kid">${options(kids, 'id', (k) => `${k.name} — ${k.section_label}`)}</select></div></div></section>`}<div id="detail"></div>`;
  const detail = $('#detail', root);
  const show = (id) => run(async () => {
    detail.innerHTML = '<p class="loading">Loading…</p>';
    const [profile, att, rc, inv, schedule] = await Promise.all([
      api('GET', `/students/${id}`), api('GET', `/students/${id}/attendance`), api('GET', `/students/${id}/report-card`),
      api('GET', `/invoices?student_id=${id}&limit=50`), api('GET', `/timetable?section_id=${kids.find((kid) => kid.id === Number(id)).section_id}`)
    ]);
    const s = att.summary;
    detail.innerHTML = `${isStudent ? `<section class="card student-profile"><div><span class="muted">STUDENT PROFILE</span><h2>${esc(profile.name)}</h2><p>${esc(profile.class_name)} — Section ${esc(profile.section_name)} · Admission ${esc(profile.admission_no)}</p></div></section>` : ''}
      <section class="card"><h2>Attendance</h2><p>${s.total ? `Present ${s.present} · Late ${s.late} · Absent ${s.absent} · <strong>${s.percent}%</strong> attended` : 'No attendance recorded yet.'}</p>
      ${table('Recent attendance', [{ h: 'Date', f: (r) => esc(r.date) }, { h: 'Session', f: (r) => esc(r.session) }, { h: 'Status', f: (r) => pill(r.status) }], att.records.slice(0, 10), 'No records.')}</section>
      <section class="card"><h2>Report card</h2>${table('Results', [{ h: 'Exam', f: (r) => esc(r.exam) }, { h: 'Subject', f: (r) => esc(r.subject) }, { h: 'Marks', cls: 'num', f: (r) => `${r.marks} / ${r.total_marks}` }, { h: '%', cls: 'num', f: (r) => r.percent }, { h: 'Grade', f: (r) => esc(r.grade) }], rc.subjects, 'No results published yet.')}
      ${rc.subjects.length ? `<p><strong>Overall: ${rc.overall.obtained} / ${rc.overall.total} (${rc.overall.percent}%) — Grade ${esc(rc.overall.grade)}</strong></p>` : ''}</section>
      <section class="card"><h2>Timetable</h2>${timetableGrid(schedule.data)}</section>
      <section class="card"><h2>Fees</h2>${invoiceTable(inv.data, false, !isStudent)}</section>${isStudent ? '' : '<section class="card" id="panel" hidden></section>'}`;
    detail.onclick = (e) => {
      const i = e.target.closest('[data-inv]');
      if (!isStudent && i) run(() => invoicePanel($('#panel', detail), i.dataset.inv, () => show(id)));
    };
  });
  if (!isStudent) $('#kid', root).onchange = (e) => show(e.target.value);
  show(isStudent ? state.user.student_id : kids[0].id);
}

start();
