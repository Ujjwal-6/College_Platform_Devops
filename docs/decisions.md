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

### D-10 PDF library — **Approved: `pdfkit`** (2026-10-27, product owner). Light, no browser, runs in the worker. Puppeteer/HTML-to-PDF stays an option only if the report template (U-7) proves too complex; it adds a headless browser to the worker image.

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
| U-3 | Calendar defaults and override | **Revised 2026-10-23 (hall booking feature): the calendar is advisory everywhere.** It suggests ("this overlaps an exam period / a fest") on events and hall bookings, shows entries to approvers, and **never refuses anything**. Severity still distinguishes `block` ("restricted", shown more strongly) from `warn` ("notice"). Earlier rule (hard block at event submission) is withdrawn | feature 20, events, bookings |
| U-4 | Is the chain always Faculty → HOD → Admin, or does it vary? | **Resolved 2026-10-23: always all three levels, strictly in order** | feature 6 |
| U-5 | After rejection, can the organizer edit and resubmit? Edits after approval? | **Resolved 2026-10-23:** rejection at any level returns the event to draft (no stored `rejected` state) with the comment shown; resubmission starts a new round at Faculty. Material edits after approval need an explicit `revise` (back to draft); small corrections apply in place | features 2, 6 |
| U-6 | Certificate eligibility: attendance only, or attendance + feedback? Winner/participant types? | Checked-in attendees get a participation certificate | feature 8 |
| U-7 | Report template, content fields, photo limits, reopening rule | Simple internal layout; JPEG/PNG ≤ 5 MB each, ≤ 20 photos; no reopening, regeneration is a separate versioned action | feature 19 |
| U-8 | Who may check people in at the gate (volunteers as a role, or organizer only)? | Organizer plus volunteers they assign | feature 7 |
| U-9 | Invitation codes: single-use or reusable until the team is full? | Reusable until the team is full or the code expires | feature 3 |
| U-10 | Hall capacity smaller than expected attendance | **Resolved 2026-10-23:** a warning the organizer must acknowledge ("Book anyway"); never a hard block. Same for missing facilities | feature 4 |
| U-11 | Buffer time between bookings | **Resolved:** none (0 minutes). Bookings may be back to back | feature 4 |
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

## 8. Event Management & Approvals: decisions made (2026-10-23)

| ID | Decision | Status |
|---|---|---|
| U-16 | One person cannot decide two levels of the same submission round (service check + database unique constraint) | Approved (default accepted) |
| U-17 | The Faculty approver is any active faculty member of the event's department, other than the organizer | Approved (default accepted) |
| U-18 | Non-admin creators create events only for their own department; admins choose the department; an organizer without a department must have one assigned first (409 `NO_DEPARTMENT`) | Approved (default accepted) |
| Q-creators | Event creators: student heads (the `organizer` role), faculty, HODs and admins. Plain students cannot | Approved |
| Q-states | States: `draft`, `pending_approval` (+ `approval_level`), `approved`, `published`, `closed`, `cancelled`. Publishing is a separate step after approval; closing is explicit and only after the end time | Approved |
| Q-deadlock | If a level has no eligible person other than the organizer, or the same few people would have to decide two levels, submission is refused (409 `NO_APPROVER_AVAILABLE`); admins do not stand in for lower levels | Approved (default accepted) |
| Q-regfields | The event carries registration configuration for Member 3 now (capacity, individual/team, team sizes, deadline) | Approved |
| D-16 | Migration number ranges per owner: Member 1 `010–019` (used `010–012`), Member 2 `020–029`, Member 3 `030–039` | Approved |
| C-1 | The event contract is written: `docs/event-contract.md` | Done |

Edited-in-place note: migration `011_event_approvals.sql` was corrected before it was ever committed or shared (a CHECK constraint let a rejection with a `NULL` comment through); only local databases had applied it and they were rebuilt. Migrations that are committed must never be edited this way.

## 9. Hall Booking & Resource Management: decisions made (2026-10-23)

| ID | Decision | Status |
|---|---|---|
| H-1 | **Separate booking approval:** Faculty of the event's department, then the HOD of that department or any admin (either one). Same safeguards as event approvals: the requester and the event's organizer cannot approve; one person cannot decide both steps; stale/duplicate/concurrent decisions are refused. Booking approval and event approval are independent | Approved (option A1) |
| H-2 | **Calendar is advisory** (see U-3). Event submission no longer refuses restricted dates; this changed Member 1's behaviour, tests and docs | Approved (option B) |
| H-3 | Capacity and facility mismatches, calendar overlaps and "does not cover the event time" are **warnings the organizer acknowledges**; a taken slot or an inactive hall is a hard refusal | Approved ("it is up to the organizer") |
| H-4 | Bookings and their approval happen **before the event starts**; allowed for events in draft, submitted, approved or published; not for cancelled or closed events | Approved ("done before the event time") |
| H-5 | **Resources** can be reserved only for events that are fully approved (`approved` or `published`) and have not started; reserved immediately, no further approval. Released automatically when the event is cancelled or sent back to draft | Approved ("registered and completed that is approved") |
| H-6 | Everyone signed in can see what is booked when; other people's draft event titles show as "Reserved" | Approved |
| H-7 | Retries: **natural idempotency**: an identical repeated request returns the existing booking/reservation. No generic `Idempotency-Key` header was built | Delegated to the engineer ("do what you like") |
| H-8 | Concurrency: hall bookings use a PostgreSQL **exclusion constraint** (`btree_gist`); resources use a **row lock plus peak-usage check**; deadlock victims are retried. See `docs/booking-design.md` | Engineer's decision, documented |
| H-9 | Migration numbers used by Member 2: `020_halls_resources`, `021_hall_bookings`, `022_resource_reservations` (range `020–029`, as agreed in D-16) | Done |
| H-10 | Hall administration is admin-only; no new role. No hall closure windows (the calendar is advisory, so an inactive hall is the only hard block) | Engineer's decision, documented |

## 10. Registration: decisions and assumptions (2026-10-27)

The product owner asked for registration to be built end to end with the questions asked afterwards, then answered them the same day (answers recorded in the Status column). Rows still marked **Assumed** were chosen by the engineer and were not discussed. Details and reasons: `docs/registration-design.md` section 2.

| ID | Assumption | Status |
|---|---|---|
| R-1 | Any signed-in active user of any role (including the event's organizer) may register for a published event | **Unclear answer, still open:** the product owner replied "register for what, if for an event then only organizer", which may have meant creating events rather than registering as an attendee. Built as written until clarified |
| R-2 | Registration is open while the event is published and before its deadline (default: start time) | Assumed (follows `isEligibleForRegistration`) |
| R-3 | Capacity counts people; every team member, leader included, takes a seat | Assumed (matches the event contract) |
| R-4 | Team flow: a leader creates a named team and takes a seat; others join by code; one registration per person per event | Assumed (FR-3.2, FR-3.4) |
| R-5 | Invitation codes: 80-bit random, shown once, stored hashed, reusable until the team is full, expired or turned off; the leader may renew or turn off | **Confirmed:** reusable (U-9). The 7-day lifetime (R-6) was not discussed |
| R-6 | Code lifetime: 7 days or until registration closes | Assumed |
| R-7 | Only the registrant cancels, until the event starts; registering again afterwards is allowed. The leader cannot remove a member and the organizer cannot cancel someone's registration | **Confirmed** ("no, cannot") |
| R-8 | Leader leaves: leadership passes to the longest-standing member; an empty team is dissolved | Assumed |
| R-9 | A team below the minimum size is flagged, never removed or blocked | **Confirmed** ("just flag it") |
| R-10 | Organizer, department faculty/HOD and admins see registrant names and emails; others see counts only | **Confirmed** |
| R-11 | Event cancelled: registrations cancelled, teams dissolved, people emailed. Unpublish and revise are refused while anyone is registered | **Confirmed** |
| R-12 | `Idempotency-Key` header on register, create team and join; kept 24 hours; failures not stored | Assumed (AC-3.5, G5) |
| R-13 | Rate limits per person: 60 registration writes and 20 code attempts per 15 minutes | Assumed (AC-13.3) |
| R-14 | ~~No waitlist~~ | **Replaced:** the product owner wants a waitlist (W-1 to W-6 below) |
| R-15 | One confirmation email per registration and one notice on event cancellation; no reminders, no email to the leader when someone joins | **Confirmed** ("no need"). The promotion email (W-4) is added by the waitlist |
| D-17 | Migrations `030_registrations`, `031_idempotency` (range `030–039`, D-16). A generic `Idempotency-Key` helper now exists in `platform/idempotency.ts` for any retryable endpoint (hall bookings still use natural idempotency, H-7) | Done |

### Waitlist (requested 2026-10-27; the details are assumptions)

| ID | Decision | Status |
|---|---|---|
| W-1 | **Individual events only.** A full team event stays full (a team cannot be split across a queue); the screen offers no waitlist there | Assumed |
| W-2 | A person **chooses** to queue (`waitlist: true`, "Join the waitlist" button) when the event is full; they are never queued silently. If a seat is free, asking for the waitlist simply registers them | Assumed |
| W-3 | **First come, first served**, by the real moment of joining. A waiting person has no seat and does not count against capacity; they may leave the queue; coming back puts them at the back | Assumed |
| W-4 | When a registered person cancels, the **first person waiting is registered automatically** in the same step and emailed ("A seat opened up"). Nobody can jump the queue: a freed seat is never visible as free while someone waits | Assumed |
| W-5 | Nobody is promoted once registration has closed (deadline passed); the seat then stays empty | Assumed |
| W-6 | When the event is cancelled, waiting people are cancelled and emailed like registered ones. Staff see the waiting list with places; everyone sees only how many are waiting | Assumed |
| D-18 | Migration `032_waitlist` (new status `waitlisted`, `waitlisted_at`, a check that waiting rows have no team) | Done |

## 11. Attendance (QR check-in and gate passes): decisions and assumptions (2026-10-27)

| ID | Decision | Status |
|---|---|---|
| D-10 | PDF library: `pdfkit` | **Approved** by the product owner |
| D-19 | QR codes: `qrcode` draws them (server, for the screen and the PDF), `jsqr` reads them from the camera in the browser (works on every phone) | **Approved** by the product owner |
| D-20 | Migration `033_attendance` (attendance, event volunteers, gate passes), inside Member 3's range | Done |
| A-1 | Scanning: the organizer, admins and volunteers the organizer assigns per event (by account email); faculty/HOD see counts only (U-8 default) | Assumed |
| A-2 | Manual check-in: organizer and admins only, reason required and logged | Assumed (FR-7.4) |
| A-3 | Check-in window: two hours before the start until the event ends, for published events | Assumed |
| A-4 | Each confirmed registration (each team member too) has its own signed single-use QR pass, valid until the event ends | Assumed (FR-7.1) |
| A-5 | One check-in per person, no undo; a checked-in person can no longer cancel their registration | Assumed |
| A-6 | Gate-pass PDF made by the worker; the person gets an email with a link (not an attachment) and downloads it signed in; venue = confirmed hall booking, else "To be announced" | Assumed (FR-7.3) |
| A-7 | The PDF uses standard fonts: names in non-Latin scripts are not drawn correctly | Known limit, needs a decision |
| A-8 | No offline scanning, no exit/re-entry tracking, no walk-ins without a registration | Assumed (offline is out of R1 scope) |
| A-9 | "Attended" means "was checked in"; what earns a certificate is decided in feature 8 (U-6) | Assumed |
| A-10 | QR signing key: `QR_SIGNING_SECRET` if set, otherwise derived from `JWT_SECRET` | Engineer's decision |

