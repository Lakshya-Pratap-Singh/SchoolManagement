-- Repeatable schema: safe to run many times (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('ADMIN','TEACHER','GUARDIAN')),
  phone         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sections (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  name     TEXT NOT NULL,
  UNIQUE (class_id, name)
);

CREATE TABLE IF NOT EXISTS subjects (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

-- Which teacher teaches which subject in which section.
CREATE TABLE IF NOT EXISTS assignments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  section_id INTEGER NOT NULL REFERENCES sections(id),
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  UNIQUE (section_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_assign_teacher ON assignments(teacher_id);

CREATE TABLE IF NOT EXISTS students (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  admission_no TEXT NOT NULL UNIQUE,
  section_id   INTEGER NOT NULL REFERENCES sections(id),
  guardian_id  INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_students_section  ON students(section_id);
CREATE INDEX IF NOT EXISTS idx_students_guardian ON students(guardian_id);

CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  date       TEXT NOT NULL,               -- YYYY-MM-DD
  session    TEXT NOT NULL CHECK (session IN ('MORNING','AFTERNOON')),
  status     TEXT NOT NULL CHECK (status IN ('PRESENT','ABSENT','LATE')),
  marked_by  INTEGER NOT NULL REFERENCES users(id),
  UNIQUE (student_id, date, session)      -- blocks duplicates at DB level
);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);

CREATE TABLE IF NOT EXISTS exams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  section_id  INTEGER NOT NULL REFERENCES sections(id),
  subject_id  INTEGER NOT NULL REFERENCES subjects(id),
  total_marks INTEGER NOT NULL CHECK (total_marks > 0),
  exam_date   TEXT NOT NULL,
  UNIQUE (name, section_id, subject_id)
);

CREATE TABLE IF NOT EXISTS results (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id    INTEGER NOT NULL REFERENCES exams(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  marks      REAL NOT NULL CHECK (marks >= 0),
  entered_by INTEGER NOT NULL REFERENCES users(id),
  UNIQUE (exam_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_results_student ON results(student_id);

-- Configurable grading: a student gets the grade with the highest min_percent they reach.
CREATE TABLE IF NOT EXISTS grading_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  min_percent REAL NOT NULL UNIQUE CHECK (min_percent >= 0 AND min_percent <= 100),
  grade       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  title      TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount > 0),   -- whole rupees
  due_date   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_student ON invoices(student_id);

-- The fee ledger: paid amount is ALWAYS the sum of these rows.
CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id      INTEGER NOT NULL REFERENCES invoices(id),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL DEFAULT 'SIMULATED',
  idempotency_key TEXT NOT NULL UNIQUE,
  paid_by         INTEGER NOT NULL REFERENCES users(id),
  paid_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
