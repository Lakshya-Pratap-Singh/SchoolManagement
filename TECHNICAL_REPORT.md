# Technical Report: School Management System

## 1. Goal and approach
Build the smallest system that still proves every requirement in the brief: academic administration, attendance, exams and grading,
fees, role-based access, reports and an audit trail. Priority was correctness and being able to explain every line, not feature count.

**Stack:** Node.js + Express (API), SQLite via Node's built-in `node:sqlite` (database), plain HTML/CSS/JS (UI), Jest + Supertest (tests).

**Why this stack:** one `npm install`, no database server, no build tooling, and reviewers can run it in a minute.
Using the module built into Node means no native add-on to compile, so installs work the same on Windows, macOS and Linux. SQLite gives real constraints, indexes, foreign keys and transactions, which are the things the brief asks me to demonstrate.

## 2. Architecture
A modular monolith in three layers:
1. **UI** (`public/`): renders what the user's role may do. It is a convenience only.
2. **HTTP + business rules** (`src/routes`, `src/access.js`): validation, authorization, grading and fee logic.
3. **Persistence** (`src/schema.sql`, `src/db.js`): constraints and indexes that protect data even if code has a bug.

## 3. Data model
13 tables (see the ER diagram in the README). Choices worth explaining:
- **Users hold all roles** (`ADMIN | TEACHER | GUARDIAN`); a student points to one guardian user. This keeps login and permissions in one place.
- **Assignments** link teacher + section + subject, with `UNIQUE(section_id, subject_id)` (one teacher per subject per section).
  A teacher's "assigned classes" are derived from this table.
- **Derived, not stored:** a grade is computed from the current `grading_rules` each time it is read, and invoice paid/outstanding/status are computed from
  `payments`. Nothing can drift out of sync, and changing a rule instantly changes every grade.
- **Constraints as a backstop:** `UNIQUE(student_id,date,session)`, `UNIQUE(exam_id,student_id)`, `UNIQUE(idempotency_key)`, `CHECK` on enums and amounts, foreign keys on.
- **Indexes** on every foreign key used for lookups (student→section/guardian, results→student, invoices→student, payments→invoice) and `audit_logs(created_at)`.

## 4. Security and authorization
- Passwords hashed with bcrypt; login returns a signed JWT (8h). Every request re-loads the user, so a deleted user loses access immediately.
- Unknown email and wrong password give the same message and similar timing.
- **Two layers of server checks on every route:**
  1. *Role gate* (`requireRole`): e.g. only ADMIN creates invoices.
  2. *Row-level rule* (`access.js`): a teacher must be assigned to the section (and subject for marks); a guardian must be the student's guardian. Failure is `403`.
- Input is validated server-side (types, ranges, enums, dates); all SQL uses bound parameters; UI output is HTML-escaped.
- Only synthetic data. `.env` is git-ignored and only `.env.example` is committed.

## 5. Concurrency, duplicates and invalid states
| Risk | Protection |
|------|-----------|
| Duplicate attendance | Unique constraint + `INSERT ... ON CONFLICT DO UPDATE`; resubmission safely updates |
| Double payment (double click, retry) | Required `idempotency_key`; same key + same payload returns the original payment (200), a different payload is `409` |
| Overpayment | Outstanding is re-computed inside the same `BEGIN IMMEDIATE` transaction as the insert, so two payments cannot both pass the check; excess gives `400` |
| Paying a settled invoice | `409` |
| Marks outside 0..total, student from another section | `400` |
| Deleting something still in use | Foreign keys → `409` |
| Grading rules with gaps | Rule set must contain 0%, so every score gets a grade |

## 6. Testing
29 automated tests (Jest + Supertest) with a fresh in-memory database per test. They cover the five acceptance criteria with both
success and failure paths, plus grade boundaries, idempotent retries, reconciliation (`billed − paid = outstanding` computed
independently from the ledger), validation, pagination/search and conflict handling. A jsdom smoke run of the UI exercised all three roles' screens and a guardian payment.

## 7. Trade-offs and what I would do next
| Decision | Trade-off | Next step |
|----------|-----------|-----------|
| SQLite (`node:sqlite`) | Simple, zero native deps, but single-writer and still flagged experimental in Node | PostgreSQL + versioned migrations |
| Token in `sessionStorage` | Simple, XSS-exposed | HttpOnly cookie + CSRF protection |
| Whole-rupee integers | No rounding bugs, no paise | Store minor units |
| Vanilla JS UI | No build step, more manual DOM code | A component framework if the UI grows |
| Teacher access by section | Any assigned teacher can mark that section's attendance | Per-subject/period attendance |
| No rate limiting | Brute-force possible | `express-rate-limit`, account lockout |
