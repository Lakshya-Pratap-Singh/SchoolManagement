# School Management System (simple MVP)

A small, complete school management app: **Node.js + Express + SQLite (built into Node) + plain HTML/JS**.
No external services, no paid hosting, no build step, nothing native to compile. One command to install, one to run.

Admin, teacher and guardian roles each get their own view; every permission is enforced **on the server**.

## Quick start

Requires **Node.js 22.13 or newer** (check with `node -v`). SQLite comes built into Node, so there is no database to install.

```bash
npm install
npm start            # http://localhost:3000   (first run auto-loads demo data)
npm test             # 30 automated tests
```

- App: http://localhost:3000
- API docs (Swagger UI): http://localhost:3000/api-docs  (raw spec: `openapi.yaml`)
- Reset the database to the demo data at any time: `npm run seed`

## Demo credentials (synthetic data only)

| Role | Email | Password | What to try |
|------|-------|----------|-------------|
| Admin | admin@school.test | Admin@123 | Everything: people, classes, exams, fees, dashboard, audit log |
| Teacher | asha.teacher@school.test | Teacher@123 | Assigned to **Class 5 - A** only (Maths, Science) |
| Teacher | ravi.teacher@school.test | Teacher@123 | Class 5 - A (English) and Class 5 - B (Maths) |
| Guardian | meera.guardian@school.test | Guardian@123 | Children: Aarav (5-A), Diya (5-B) |
| Guardian | arjun.guardian@school.test | Guardian@123 | Children: Kabir, Rohan (5-A), Anaya (6-A) |

The login page also has one-click buttons that fill these in.

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

## Architecture

```
public/            Browser UI (index.html, app.js, style.css) - talks to the API only
src/app.js         Express app: login, auth gate, error handler, API docs
src/routes/*.js    HTTP layer: validate input, check role, call the database  (admin, attendance, exams, fees, reports)
src/access.js      Row-level rules (teacher-section, guardian-child), grading, fee balance helpers
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
    CLASSES ||--o{ SECTIONS : has
    SECTIONS ||--o{ STUDENTS : "enrolled in"
    SECTIONS ||--o{ ASSIGNMENTS : ""
    SUBJECTS ||--o{ ASSIGNMENTS : ""
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
| No duplicate attendance | `UNIQUE(student_id,date,session)` + upsert in `src/routes/attendance.js` |
| Grade is computed on read from the current grading rules, never stored | `gradeFor` in `src/access.js` |
| Paid/outstanding/status are derived from the payments ledger, never stored | `invoiceWithBalance`, SQL in `src/routes/fees.js` |
| Payments: transaction (`BEGIN IMMEDIATE`), idempotency key, overpayment and paid-invoice guards | `src/routes/fees.js` |
| Validation + one error shape `{ "error": { "message", "details" } }` | `src/util.js`, `src/app.js` |
| Audit trail for material actions (attendance, marks, invoices, payments, grading rules, create/delete) | `audit()` in `src/util.js`, `GET /api/audit-logs` |
| Search, filter, pagination | students, users, invoices, exams, audit log |

## Tests

`npm test` runs 30 tests with Jest + Supertest against a fresh in-memory database per test:
the five acceptance tests (each with positive **and** negative cases: 403s, 400s, 409s), grading boundary unit tests,
idempotent-retry and overpayment cases, login/validation behaviour, and student CRUD conflicts.

## Known limitations (honest list)

- Payments are **simulated** only; there is no payment gateway. Amounts are whole rupees (no paise).
- No email/SMS notifications, no file uploads, one academic year only, no real-time updates.
- Login token is kept in `sessionStorage` (simple; an HttpOnly cookie would be safer against XSS). No rate limiting, no HTTPS - put it behind a reverse proxy for real use.
- SQLite is a single-file database: ideal for a demo/MVP, not for many concurrent writers. Migrations are the idempotent `schema.sql`, not versioned migration files.
- It uses Node's built-in `node:sqlite` module, which Node still labels experimental (the warning is hidden by the npm scripts). The trade-off is zero native dependencies; swapping to `better-sqlite3` or PostgreSQL only touches `src/db.js` and the `db.transaction` calls.
- No self-service password reset or admin-created admins; administrators can reset teacher/guardian passwords while editing those accounts. Students and accounts can be edited; teachers/guardians can only be deleted if no records depend on them. Classes, sections, subjects, and assignments have create/delete but no edit flow.
- Attendance statuses are Present / Absent / Late (no "Excused").
- A UI smoke test was run against a live server in a simulated browser; there are no automated browser tests.

## AI and attribution

Fill this honestly for the submission form (which AI tools you used, and for what). Libraries: express, bcryptjs,
jsonwebtoken (runtime; SQLite is Node's built-in `node:sqlite`); jest, supertest (tests); Swagger UI is loaded from a CDN only on `/api-docs`.
#   S c h o o l M a n a g e m e n t  
 