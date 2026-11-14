# School Management System (simple MVP)

A small, complete school management app: **Node.js + Express + SQLite (built into Node) + plain HTML/JS**.
No external services, no paid hosting, no build step, nothing native to compile. One command to install, one to run.

Admin, teacher, guardian, and student roles each get their own view; every permission is enforced **on the server**.

## Quick start

Requires **Node.js 22.13 or newer** (check with `node -v`). SQLite comes built into Node, so there is no database to install.

```bash
npm install
npm start            # http://localhost:3000   (first run auto-loads demo data)
npm test             # 34 automated tests
```

- App: http://localhost:3000
- API docs (Swagger UI): http://localhost:3000/api-docs  (raw spec: `openapi.yaml`)
- Reset the database to the demo data at any time: `npm run seed`

If upgrading a previously seeded local database, the new tables are added automatically. To load the new student demo accounts and sample timetable, run `npm run seed` (this resets all local data); otherwise, admins can provision student logins from **Students** and build schedules from **Timetable**.

## Vercel demo deployment

Vercel can detect this Express app from `src/server.js`. For a demo deployment:

1. Push the project to a Git provider and import the repository in Vercel.
2. Add a `JWT_SECRET` environment variable in the Vercel project settings, with a random value of at least 32 characters. The app will refuse to start on Vercel without it.
3. Deploy with the Express framework preset and a Node.js version that supports `node:sqlite` (Node 22.13+).

On Vercel, the app places SQLite at `/tmp/school-management-demo.db` and seeds demo data when a new instance starts. **This database is temporary and instance-local:** changes can disappear after an instance is recycled and may not be shared across instances. Use only synthetic demo data; do not enter real student or payment data. Persistent use requires migrating to a hosted database.

## Demo credentials (synthetic data only)

| Role | Email | Password | What to try |
|------|-------|----------|-------------|
| Admin | admin@school.test | Admin@123 | Everything: people, classes, timetable, exams, fees, dashboard, audit log |
| Teacher | asha.teacher@school.test | Teacher@123 | Assigned to **Class 5 - A** only (Maths, Science) |
| Teacher | ravi.teacher@school.test | Teacher@123 | Class 5 - A (English) and Class 5 - B (Maths) |
| Teacher | nisha.teacher@school.test | Teacher@123 | Assigned to **Class 6 - A** (Maths, English, Science) |
| Guardian | meera.guardian@school.test | Guardian@123 | Children: Aarav (5-A), Diya (5-B) |
| Guardian | arjun.guardian@school.test | Guardian@123 | Children: Kabir, Rohan (5-A), Anaya (6-A) |
| Student | aarav.student@school.test | Student@123 | Aarav's own attendance, report card, fees, and Class 5-A timetable |

The login page also has one-click buttons that fill these in. Admins can create student login credentials while adding or editing a student; student passwords are stored separately from guardian and staff accounts.

## Environment variables

All optional for local use. Copy `.env.example` to `.env` to change them (`.env` is git-ignored).

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | dev-only value | Secret used to sign login tokens. **Set a long random value outside local demos.** |
| `DB_FILE` | `./data/school.db` | SQLite file (`:memory:` is used by tests) |

## Walkthrough that covers the acceptance tests

1. **Teacher sees only assigned classes.** Log in as Asha → Attendance. Only *Class 5 - A* is listed. Mark and save.
   (API check: `POST /api/attendance` for Class 5 - B as Asha returns **403**.)
2. **Duplicate attendance.** Save the same class/date/session twice → the second save *updates*; one row per student/date/session
   (also enforced by a database `UNIQUE` constraint).
3. **Exam results and grades.** Admin → Exams → create an exam, then *Enter / view marks*. Grades come from the configurable grading rules
   (edit them in the same tab and watch the grades change). Guardians see the resulting report card.
4. **Guardian isolation.** Log in as Meera → My children lists only Aarav and Diya. Requesting Kabir's record via the API returns **403**.
5. **Fee reconciliation.** Meera → Aarav → *Ledger / pay* → pay ₹1000 (simulated). Admin → Dashboard shows
   Billed − Paid = Outstanding and **Reconciled: Yes**. Overpaying is rejected; double-clicking/retrying never double-charges.
6. **Student portal and timetable.** Log in as Aarav → *My portal* to see his own records and weekly timetable. Admin → *Timetable* to add, edit, or remove a period; students, guardians, and teachers see only their permitted schedule.

## Architecture

```
public/            Browser UI (index.html, app.js, style.css) - talks to the API only
src/app.js         Express app: login, auth gate, error handler, API docs
src/routes/*.js    HTTP layer: validate input, check role, call the database (admin, attendance, exams, fees, reports, timetable)
src/access.js      Row-level rules (teacher-section, guardian-child, student-self), grading, fee balance helpers
src/auth.js        JWT + bcrypt + requireRole middleware
src/util.js        Validation, pagination, audit logging, error classes
src/schema.sql     Database schema (tables, constraints, indexes) - run on every start, safe to repeat
src/seed.js        Synthetic demo data (npm run seed resets to it)
tests/             Jest + Supertest API tests (in-memory SQLite)
```

The UI, the business rules and persistence are separate layers inside one deployable app (a modular monolith).

### ER diagram

```mermaid
erDiagram
    USERS ||--o{ STUDENTS : "guardian of"
    USERS ||--o{ ASSIGNMENTS : "teacher teaches"
    STUDENTS ||--o| STUDENT_ACCOUNTS : "student login"
    CLASSES ||--o{ SECTIONS : has
    SECTIONS ||--o{ STUDENTS : "enrolled in"
    SECTIONS ||--o{ ASSIGNMENTS : ""
    SECTIONS ||--o{ TIMETABLE_ENTRIES : ""
    SUBJECTS ||--o{ ASSIGNMENTS : ""
    ASSIGNMENTS ||--o{ TIMETABLE_ENTRIES : "scheduled as"
    STUDENTS ||--o{ ATTENDANCE : has
    SECTIONS ||--o{ EXAMS : ""
    SUBJECTS ||--o{ EXAMS : ""
    EXAMS ||--o{ RESULTS : has
    STUDENTS ||--o{ RESULTS : scored
    STUDENTS ||--o{ INVOICES : "billed to"
    INVOICES ||--o{ PAYMENTS : "paid by (ledger)"
    USERS ||--o{ AUDIT_LOGS : performed

    USERS { int id PK; text email UK; text role "ADMIN|TEACHER|GUARDIAN" }
    CLASSES { int id PK; text name UK }
    SECTIONS { int id PK; int class_id FK; text name "UNIQUE(class_id,name)" }
    SUBJECTS { int id PK; text name UK }
    ASSIGNMENTS { int id PK; int teacher_id FK; int section_id FK; int subject_id FK "UNIQUE(section_id,subject_id)" }
    STUDENTS { int id PK; text admission_no UK; int section_id FK; int guardian_id FK }
    STUDENT_ACCOUNTS { int student_id PK,FK; text email UK; text password_hash }
    TIMETABLE_ENTRIES { int id PK; int section_id FK; int assignment_id FK; text weekday; int period "1..6"; text start_time; text end_time }
    ATTENDANCE { int id PK; int student_id FK; text date; text session; text status "UNIQUE(student_id,date,session)" }
    EXAMS { int id PK; int section_id FK; int subject_id FK; int total_marks }
    RESULTS { int id PK; int exam_id FK; int student_id FK; real marks "UNIQUE(exam_id,student_id)" }
    GRADING_RULES { int id PK; real min_percent UK; text grade }
    INVOICES { int id PK; int student_id FK; int amount; text due_date }
    PAYMENTS { int id PK; int invoice_id FK; int amount; text idempotency_key UK }
    AUDIT_LOGS { int id PK; int actor_id FK; text action; text entity; int entity_id }
```

## Key design rules (and where to find them)

| Rule | Where |
|------|-------|
| Server-side role gate (`requireRole`) and row-level checks (teacher↔section, guardian↔child) | `src/auth.js`, `src/access.js`, every route |
| Student accounts are separate from staff/guardian users and can read only their own linked record | `student_accounts`, `src/auth.js`, `src/access.js` |
| Timetable management is admin-only; reads are scoped to assigned teachers, linked guardians, or the logged-in student | `src/routes/timetable.js` |
| No duplicate attendance | `UNIQUE(student_id,date,session)` + upsert in `src/routes/attendance.js` |
| Grade is computed on read from the current grading rules, never stored | `gradeFor` in `src/access.js` |
| Paid/outstanding/status are derived from the payments ledger, never stored | `invoiceWithBalance`, SQL in `src/routes/fees.js` |
| Payments: transaction (`BEGIN IMMEDIATE`), idempotency key, overpayment and paid-invoice guards | `src/routes/fees.js` |
| Validation + one error shape `{ "error": { "message", "details" } }` | `src/util.js`, `src/app.js` |
| Audit trail for material actions (attendance, marks, invoices, payments, grading rules, create/delete) | `audit()` in `src/util.js`, `GET /api/audit-logs` |
| Search, filter, pagination | students, users, invoices, exams, audit log |

## Tests

`npm test` runs 34 tests with Jest + Supertest against a fresh in-memory database per test:
the five acceptance tests, student privacy and timetable authorization, timetable conflict validation, grading boundaries,
idempotent retries, fee reconciliation, login validation, and CRUD conflicts.

## Known limitations (honest list)

- Payments are **simulated** only; there is no payment gateway. Amounts are whole rupees (no paise).
- No email/SMS notifications, no file uploads, one academic year only, no real-time updates.
- The default timetable is Monday-Friday with six periods per day; admins manage individual entries and times.
- Login token is kept in `sessionStorage` (simple; an HttpOnly cookie would be safer against XSS). No rate limiting, no HTTPS - put it behind a reverse proxy for real use.
- SQLite is a single-file database: ideal for a demo/MVP, not for many concurrent writers. Migrations are the idempotent `schema.sql`, not versioned migration files.
- It uses Node's built-in `node:sqlite` module, which Node still labels experimental (the warning is hidden by the npm scripts). The trade-off is zero native dependencies; swapping to `better-sqlite3` or PostgreSQL only touches `src/db.js` and the `db.transaction` calls.
- No self-service password reset or admin-created admins; administrators can reset teacher/guardian passwords while editing those accounts. Student login credentials are set when enrolling or editing a student. Teachers/guardians can only be deleted if no records depend on them. Classes, sections, subjects, and assignments have create/delete but no edit flow.
- Attendance statuses are Present / Absent / Late (no "Excused").
- A UI smoke test was run against a live server in a simulated browser; there are no automated browser tests.

## AI and attribution

Fill this honestly for the submission form (which AI tools you used, and for what). Libraries: express, bcryptjs,
jsonwebtoken (runtime; SQLite is Node's built-in `node:sqlite`); jest, supertest (tests); Swagger UI is loaded from a CDN only on `/api-docs`.
#   S c h o o l M a n a g e m e n t  
 