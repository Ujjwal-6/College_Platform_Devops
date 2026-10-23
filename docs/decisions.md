# Decisions

Single place for what is approved, what is recommended, and what is still open. Update this file (do not silently change technology) whenever a decision is made. When a decision is approved, record the date, who approved, and change its status.

Status values: **Approved** · **Approved addition** · **Recommended (needs approval)** · **OPEN** · **Future scope**

## 1. Already approved

| ID | Decision | Source |
|---|---|---|
| A-1 | Frontend: React.js | Presentation |
| A-2 | Backend: Node.js + Express.js REST APIs | Presentation |
| A-3 | Authentication: JWT with role-based access control | Presentation |
| A-4 | Version control: Git + GitHub | Presentation |
| A-5 | Docker and Docker Compose | Presentation |
| A-6 | CI: GitHub Actions | Presentation |
| A-7 | Feature 19: automatic post-event PDF report | Newly approved addition |
| A-8 | Feature 20: academic calendar guard | Newly approved addition |
| A-9 | Kubernetes, microservices, predictive ML, advanced DR are **not** in the first release | Approved scope statement |
| A-10 | Prometheus and Grafana are planned (deployment approach is open, see D-06) | Presentation |
| A-11 | Repository initialised with Git; `CLAUDE.md` and `docs/` created | Done and approved in session |

## 2. Technology decisions needing approval

### D-01 Database: PostgreSQL vs MySQL — **Approved: PostgreSQL** (2026-10-23)

| | PostgreSQL | MySQL |
|---|---|---|
| Booking overlap | Native exclusion constraint on time ranges: the DB rejects overlaps even if app code is wrong | No equivalent; needs locking + app logic (e.g. lock the hall row, or slot-table with unique keys); easier to get wrong |
| Concurrency tools | `SELECT … FOR UPDATE SKIP LOCKED`, partial indexes, rich constraints, JSONB | `FOR UPDATE` and `SKIP LOCKED` (8.0+), generated columns; fewer constraint types |
| Team familiarity | Likely lower (`mysql` client is already installed on the dev machine) | Likely higher |
| Hosting | Managed on both AWS (RDS) and Azure | Same |

*Recommendation:* PostgreSQL. *If MySQL is chosen:* booking safety must use a documented alternative (e.g. fixed-granularity slot rows with a unique key, or row-lock on the hall) and the concurrency tests (AC-4.1, AC-4.3) must still pass. *Blocks:* schema, migrations, repositories, CI service container. Decide in Week 1.

### D-02 Redis — **Not used**; revisit only if a later decision needs it (shared rate limiting, caching)

Redis is not required for correctness. Booking safety comes from the database. Redis may be used for the queue (D-03), rate limiting and caching. If a DB-backed queue is chosen, Redis can be omitted from R1 (one less service to operate).

### D-03 Queue implementation — **Approved: retain the PostgreSQL-backed job queue** (2026-10-23). Redis, BullMQ and pg-boss are not to be introduced

Implemented as a PostgreSQL-backed `jobs` table (`FOR UPDATE SKIP LOCKED`, exponential backoff with jitter, failed state, unique `job_key` for idempotency, stale-lock recovery) in `apps/api/src/platform/jobs`. It was chosen because PostgreSQL is approved, it needs no extra service, and enqueueing shares the business transaction (no lost or phantom jobs). Handlers are registered by type, so replacing it with pg-boss or BullMQ later only touches `queue.ts` and `worker.ts`. Original options:

| Option | Pros | Cons |
|---|---|---|
| BullMQ + Redis | Mature, retries/backoff/delayed/repeatable jobs, dashboards (Bull Board) | Extra service; the outbox is still needed for transactional enqueue |
| pg-boss (Postgres-backed) | No extra service; enqueue can share the business transaction; fits PostgreSQL | Lower throughput (irrelevant at college scale); requires PostgreSQL |
| Custom DB table + polling | No dependencies | Reinventing retries/backoff; more bugs |

*Recommendation:* pg-boss if D-01 = PostgreSQL (simplest, transactional); BullMQ + Redis otherwise or if the team wants the industry-standard demo. Retry defaults (max 5 attempts, exponential backoff starting at 30 s with jitter) are proposed regardless of choice.

### D-04 Language: TypeScript vs JavaScript — **Approved: TypeScript** (2026-10-23)
Pros: shared types across API/web/worker, catches contract mismatches among four developers. Cons: learning curve and build setup. If JavaScript is chosen: JSDoc types or at least schema validation shared in `packages/shared`.

### D-05 ORM / query layer — **Implemented, needs confirmation**: plain SQL migrations (`node-pg-migrate`) + `pg` with thin repositories
Options: Prisma (fast to start, but exclusion constraints and some locking need raw SQL), Knex or `node-postgres` with SQL migrations (transparent, more boilerplate), Drizzle/Kysely (type-safe SQL). *Recommendation:* SQL migrations (node-pg-migrate or Knex) with a thin typed query layer so constraint-heavy parts are explicit. Depends on D-01/D-04.

### D-06 Monitoring deployment — **OPEN**
Prometheus + Grafana are planned (A-10). Open: run them in the same Compose stack on the demo VM (recommended for R1), or use managed offerings (CloudWatch/Managed Grafana, Azure Monitor). The `/metrics` endpoints and dashboards are the same either way.

### D-07 Cloud provider: AWS vs Azure — **OPEN**
Decide by available student credits and team familiarity. R1 is cloud-agnostic (containers + environment config). A tested deployment target is needed by Week 11. *Default if undecided by end of Week 6:* single VM (EC2 or Azure VM) running Compose.

### D-08 File storage — **OPEN**, recommend local Docker volume for dev and S3-compatible storage (MinIO locally) behind a storage interface.

### D-09 Email provider — **OPEN**, recommend Mailpit in development and SMTP via a provider chosen with D-07 (SES/Azure Communication Services/Brevo etc.).

### D-10 PDF library — **OPEN**, recommend `pdfkit` (light, no browser). Puppeteer/HTML-to-PDF only if the report template (U-7) proves too complex; it adds a headless browser to the worker image.

### D-11 Frontend stack details — **OPEN**, recommend Vite + React Router + TanStack Query + a component library chosen by the frontend owner.

### D-12 Repo layout / package manager — **Approved: npm workspaces with `apps/api` and `apps/web`** (2026-10-23). The worker is a second entry point inside `apps/api` (`src/worker.ts`); `packages/shared` is deferred until a second consumer needs it.

### D-13 Testing tools — **Implemented**: Vitest, Supertest, Testing Library. Playwright (E2E) is deferred to a later milestone (see `testing-strategy.md`).

### D-14 Modular monolith + separate worker — **Recommended (needs approval)**; consistent with A-9.

### D-15 Auth details — **Approved in principle (JWT, refresh-token rotation, server-side RBAC)**; details as implemented: 15-minute access JWT held in memory, opaque rotating refresh token stored as a SHA-256 hash in an httpOnly `SameSite=Strict` cookie, reuse detection with a 5-second grace window, argon2id (OWASP minimum parameters), roles re-read from the database on every request.

## 3. Policy decisions needing approval (they affect data models and tests)

| ID | Question | Default used if unanswered | Affects |
|---|---|---|---|
| U-1 | How do users join? | **Approved (2026-10-23): accounts are admin-created only in the initial release. No public self-registration.** | feature 1 |
| U-2 | Can approvers delegate or have substitutes? | Not in R1 | feature 6 |
| U-3 | Calendar defaults: which entry types block vs. warn? Can an admin override a block? | Exam periods and holidays = block, major fests = warn, no override | feature 20, bookings |
| U-4 | Is the chain always Faculty → HOD → Admin, or does it vary by event type/budget? | Always all levels | feature 6 |
| U-5 | After rejection, can the organizer edit and resubmit? Are edits after approval allowed? | Rejection → draft with comments; edits after approval send the event back to the start of the chain | features 2, 6 |
| U-6 | Certificate eligibility: attendance only, or attendance + feedback? Winner/participant types? | Checked-in attendees get a participation certificate | feature 8 |
| U-7 | Report template, content fields, photo limits, reopening rule | Simple internal layout; JPEG/PNG ≤ 5 MB each, ≤ 20 photos; no reopening, regeneration is a separate versioned action | feature 19 |
| U-8 | Who may check people in at the gate (volunteers as a role, or organizer only)? | Organizer plus volunteers they assign | feature 7 |
| U-9 | Invitation codes: single-use or reusable until the team is full? | Reusable until the team is full or the code expires | feature 3 |
| U-10 | Hall capacity smaller than expected attendance: warn or block? | Warn | feature 4 |
| U-11 | Buffer time between bookings | 0 minutes | feature 4 |
| U-12 | Feedback fields and anonymity | 1–5 rating, optional comment, tied to user but hidden from organizers | feature 8 |
| U-13 | Expected scale (users, concurrent events, attendees per event) | Hundreds of concurrent users, ≤ 2,000 attendees per event | load testing, sizing |
| U-14 | Data retention and privacy (how long to keep student data, audit logs, reports) | Keep for the academic year plus one; no deletion feature in R1 | all |
| U-15 | Team ownership of each area (names to Dev A–D) | See `implementation-roadmap.md` proposal | planning |

## 4. Future scope (not in R1)

Kubernetes · microservices · predictive/ML risk scoring · multi-region DR · auto-scaling · native mobile app · SMS/push notifications · offline QR scanning · SSO beyond U-1 · multi-campus tenancy. Each needs explicit approval before entering a release.

## 5. Decision log (fill in as decisions are made)

| Date | ID | Decision | Approved by |
|---|---|---|---|
| 2026-10-23 | D-01 | PostgreSQL with versioned migrations | Team (instruction to implement foundation) |
| 2026-10-23 | D-04 | TypeScript for backend and frontend | Team |
| 2026-10-23 | D-12 | npm workspaces, `apps/api` + `apps/web` | Team |
| 2026-10-23 | D-15 | JWT + refresh-token rotation + server-side RBAC | Team |
| 2026-10-23 | D-03 | Retain the PostgreSQL-backed job queue; no Redis, BullMQ or pg-boss | Team |
| 2026-10-23 | U-1 | Admin-created accounts only in the initial release; no public self-registration | Team |

## 6. Pending verification

| Item | Status |
|---|---|
| Docker image builds, `docker compose` stack | Written, **not executed**. Docker is deliberately not installed for now; infrastructure scope is frozen |
| GitHub Actions workflow (`.github/workflows/ci.yml`) | Written, **not executed**. No remote exists; nothing has been pushed |
| Real SMTP delivery | Not verified (job and template flow tested with an in-memory mailer) |

## 7. Open items found in the event-feature readiness check (2026-10-23)

| ID | Question | Recommended default | Needed before |
|---|---|---|---|
| D-16 | Migration numbering with four people adding migrations. `node-pg-migrate` rejects a new migration that sorts before one already applied (verified: "Not run migration 010 is preceding already run migration 020") | Reserve ranges per feature owner (e.g. 010–019 events/approvals, 020–029 calendar/bookings/equipment, 030–039 registration/attendance/jobs, 040–049 other), merge to `main` in numeric order, and rebuild local DBs when a lower number lands. Alternative: pass `checkOrder: false` in `platform/migrate.ts` (less safe) | First feature migration |
| U-16 | May one user approve two levels of the same event (a user holding both `faculty` and `hod`)? | No: one person may act at only one level per event; enforced in the approvals service | Approvals |
| U-17 | Who is the Faculty approver: any faculty of the event's department, or a faculty coordinator named by the organizer? | Any active faculty of the event's department (current user model supports this without change) | Approvals |
| U-18 | Which department does an event belong to when the organizer has none (students/organizers may have `departmentId = null`)? | The organizer chooses a department when creating the event; the API validates it exists | Event creation |
| C-1 | Event/booking shared contract (I-3, I-7, I-8) is not yet written as code | Member 1 publishes the `events` table columns, state names and the `transition` hook points first; see `docs/implementation-roadmap.md` | Booking integration |
