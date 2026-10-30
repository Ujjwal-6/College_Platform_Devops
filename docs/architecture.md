# Architecture

Status of this document: **proposal for team approval** except where marked **Approved**. Technology items marked **OPEN** are not decided; see `decisions.md`.
Source tags as in `requirements.md`: [P] presentation-confirmed, [N] newly approved, [R] recommendation, [F] future scope.

## 1. Style

**Modular monolith with a separate worker process.** [R, consistent with the approved assessment; microservices and Kubernetes are [F]]

- One codebase, two runtime entry points: `api` (Express) and `worker` (queue consumer).
- Modules are separated by folder and by service interface, so a future split is possible without being built now.
- The API is stateless; all state is in the database, the object store and the queue backend.

## 2. Context diagram

```
Browser (React SPA) ──HTTPS──> Reverse proxy (Nginx or Caddy; OPEN)
                                   ├── serves static SPA
                                   └── /api ──> Express API (stateless, N instances possible)
                                                  ├── Database (OPEN: PostgreSQL recommended)
                                                  ├── Queue backend (OPEN: Redis+BullMQ or DB-backed)
                                                  └── File storage (local volume → S3-compatible; OPEN)
Worker (same codebase) <── queue ── jobs: email, gate pass, certificate, post-event report
        ├── SMTP (Mailpit in dev; provider OPEN)
        └── DB + file storage
Prometheus ──scrapes──> API /metrics, Worker /metrics ──> Grafana (deployment OPEN)
```

## 3. Repository layout (proposed, [R]; not yet created)

```
apps/
  api/        Express app: routes, middleware, modules
  worker/     queue consumers (imports module services)
  web/        React SPA
packages/
  shared/     shared types, error codes, validation schemas, constants
infra/        docker-compose, Dockerfiles, Prometheus/Grafana config
docs/
```
**As built (2026-10-23):** npm workspaces with `apps/api` and `apps/web` only (D-12 approved). The worker is a second entry point of `apps/api` (`src/worker.ts`, `npm run dev:worker`), not a separate package, and `packages/shared` is deferred. `infra/` currently holds only the Postgres bootstrap script; Compose and the Dockerfiles live at the repository root and in each app. TypeScript is approved (D-04).

## 4. Backend modules and boundaries

| Module | Owns (tables/concepts) | Exposes to others | Depends on |
|---|---|---|---|
| `auth` | users, credentials, refresh tokens, roles | `requireAuth`, `requireRole`, `currentUser` | audit |
| `users` | profiles, departments | user lookup | auth |
| `events` | events, speakers, event state machine | `getEvent`, `transition` | auth, audit |
| `approvals` | approval requests/steps | `submitForApproval`, decisions | events, users, notifications |
| `calendar` (feature 20) | academic calendar entries | `checkRange(range, scope) → {blocks, warnings}` | audit |
| `bookings` | halls, bookings | `reserveHall`, `release`, availability | events, calendar |
| `equipment` | items, reservations | `reserve`, `release` | events |
| `registrations` | registrations, teams, invitation codes | `register`, `joinTeam` | events, auth |
| `attendance` | QR tokens, attendance | `checkIn`, QR verify | registrations |
| `certificates` | certificates | `issueForEvent` (via job) | attendance, notifications |
| `feedback` | feedback responses | summary for reports | attendance |
| `budget` | budget lines | totals | events |
| `budgets` (feature 9) | budget items | totals for analytics, `canSeeBudget` | events |
| `analytics` (feature 9) | none (read-only aggregates; documented exception to the table rule, BA-9) | summaries, event analytics, CSV | events, registrations, attendance, feedback, certificates, bookings, budgets |
| `reports` (feature 19) | report records, versions, photos | `requestReport`, download | events, attendance, feedback, files |
| `analytics` | read-only queries | dashboards/exports | most modules (read only) |
| `risk` | rule definitions, scores | `score(event)`, suggestions | bookings, equipment, calendar, registrations |
| `notifications` | email templates, outbox | `enqueue(email)` | queue |
| `audit` | audit log | `record(entry)` | none |
| `platform` | config, logging, metrics, DB, queue, errors | cross-cutting utilities | none |

Rules:
1. A module reads/writes only its own tables. Other modules are reached through the exposed service function. `analytics` is the single exception (read-only views).
2. Layers inside a module: `routes → controller → service → repository`. Controllers only parse and respond; services hold rules and transactions; repositories hold SQL.
3. Cross-module calls pass a transaction handle when they must commit atomically (e.g. approval → booking confirmation).
4. `calendar` and `audit` must have no dependency on higher-level modules, to avoid cycles.

## 5. Shared interfaces to freeze before work is divided

These are the contracts that, if left vague, cause four people to block each other. They should be agreed and written down in Week 1.

| # | Interface | Needed by | Owner (proposed) |
|---|---|---|---|
| I-1 | Auth middleware API: `requireAuth`, `requireRole(...)`, `requireScope(...)`, `req.user` shape (id, roles, departmentId) | every module | Dev A |
| I-2 | Error format and error code catalogue (HTTP status → `{code, message, details}`) | every module + frontend | Dev A |
| I-3 | Event state machine: states, allowed transitions, hook points | approvals, bookings, reports, registrations | Dev A |
| I-4 | DB conventions: naming, id type, `created_at/updated_at`, UTC, migration tool, transaction helper `withTx(fn)` | every module | Dev B |
| I-5 | Audit API: `audit.record({actor, action, target, before, after, tx})` | every module | Dev A |
| I-6 | Queue API: `enqueue(jobType, payload, {jobId, tx})`, job handler signature, retry policy constants | notifications, attendance, certificates, reports | Dev C |
| I-7 | Calendar guard API: `checkRange` result shape `{blocks[], warnings[]}` | bookings, risk | Dev B |
| I-8 | Booking/equipment service API (`reserve`, `release`) | events, approvals, risk | Dev B |
| I-9 | OpenAPI spec skeleton and endpoint naming convention | frontend, all backend | Dev D (with all) |
| I-10 | Notification/template API: `notify(type, recipient, data)` | approvals, registrations, reports | Dev C |
| I-11 | File storage API: `putFile`, `getFile`, size/type limits | reports, certificates, gate passes | Dev C |
| I-12 | Test fixtures/factories and test DB setup | all | Dev D |

Proposed developer areas (can be reassigned; see roadmap):
- **Dev A:** auth, users, events, approvals, audit.
- **Dev B:** halls/bookings, calendar guard, equipment, risk score.
- **Dev C:** registrations, attendance/QR, queue/worker, notifications, certificates, report PDF.
- **Dev D:** frontend, Docker/CI, observability, OpenAPI, budget/analytics UI, test infrastructure.

## 6. Key request flows

### 6.1 Booking a hall (concurrency-critical) — as built
1. `POST /api/bookings`; auth, then the service checks the caller is the event's organizer or an admin and that the event is bookable and has not started.
2. Validate input (strict schema, times in the future, `end > start`).
3. Start a transaction; lock the hall row `FOR SHARE` (so it cannot be deactivated mid-booking); a retry of an identical request returns the existing booking.
4. Early "already booked?" query (a hint for a clear message only), then warnings: capacity, facilities, `calendar.checkRange` (advisory), event-time coverage. Warnings need `acknowledgeWarnings: true`; otherwise 409 and nothing is written.
5. Check that approvers exist (faculty, and an HOD or admin, none of them the requester or organizer).
6. Insert the booking as `pending`. **The exclusion constraint is the guarantee:** an overlapping active booking of the same hall fails with `23P01`, mapped to 409 `HALL_UNAVAILABLE`.
7. Insert history and audit rows, queue approval emails (same transaction), commit. A deadlock victim (`40P01`) is re-run up to 5 times.
8. Respond 201 with the booking, or 200 with the existing one for an identical retry.

The availability endpoint is for UX only and is never trusted. Full design: `docs/booking-design.md`.

### 6.2 Registration with capacity
1. `POST /api/events/:id/registrations` with idempotency key.
2. Transaction: atomic conditional increment of the seat counter (`UPDATE … WHERE seats_taken < capacity`); zero rows affected → 409 "full".
3. Insert registration (unique `(event_id, user_id)`), generate QR token, audit, enqueue confirmation email and gate-pass job via the outbox/after-commit hook.

### 6.3 Approval step
1. `POST /api/approvals/:id/decision`; check role = current step, scope, not the organizer.
2. Transaction: lock the approval row; verify the step is still pending; record decision; advance step or finalize; on final approval confirm the booking and move the event to `approved`.
3. Audit + enqueue notification.

### 6.4 QR check-in
1. Scanner posts QR payload; server verifies signature, expiry and event match.
2. Insert attendance with unique `(registration_id)`; duplicate → return "already checked in".
3. Audit; update the live count.

### 6.5 Event close → report (feature 19)
1. `POST /api/events/:id/close` → transaction: validate transition, set `closed`, insert report-request record (outbox row) + audit.
2. After commit, the outbox publisher enqueues `report.generate` with job id `report:{eventId}:{closeVersion}`.
3. Worker: load event, speakers, attendance counts, feedback summary, photo list; render PDF; store file; insert `report_version`; notify.
4. Failures retry with backoff, then move to failed with metric + admin alert; admin/organizer can trigger a manual retry.

### 6.6 Calendar guard change (feature 20)
Admin CRUD on entries → audited. Adding a `block` over existing bookings runs a conflict scan job and produces a report; it never deletes bookings.

## 7. Background workers

- Same codebase, separate process (`worker`), horizontally scalable.
- Job types: `email.send`, `gatepass.generate`, `certificate.generate`, `report.generate`, `calendar.conflict-scan`, `reminders.scheduled` (scheduled).
- Policy (values finalized with queue choice, D-03): max attempts (default 5), exponential backoff (default 30 s base, factor 2, jitter), failed-job retention, concurrency per job type.
- **Idempotency:** deterministic job ids plus unique business constraints (e.g. `certificate(event_id, user_id)`).
- **Outbox:** jobs that must follow a database change are written to an `outbox` table in the same transaction; a publisher enqueues them after commit. If a DB-backed queue is chosen, the queue table itself serves as the outbox.
- **Observability:** each job logs `jobId`, `type`, `attempt`, `correlationId`; metrics for started/succeeded/failed/retried and queue depth.

## 8. Data model highlights (names are indicative; full schema comes after the DB decision)

- `bookings`: hall id, time range, status, event id; DB-level non-overlap for active statuses.
- `registrations`: unique `(event_id, user_id)`; `events.seats_taken` with a check `seats_taken <= capacity`.
- `attendance`: unique `(registration_id)`.
- `certificates`: unique `(event_id, user_id)`.
- `report_versions`: `(event_id, version)` unique, file path, status.
- `calendar_entries`: type, date range, severity (`block`/`warn`), scope, active flag.
- `audit_log`: append-only; application DB role has INSERT/SELECT only.
- `idempotency_keys`: key, user, request hash, response, expiry.
- `outbox`: payload, job id (unique), status.

## 9. Security architecture (summary; rules in `CLAUDE.md`)

Short-lived access JWT in memory, refresh token in an httpOnly secure cookie (rotated, hashed at rest). Central authorization middleware plus per-resource scope checks in services. Input validation at the edge. Rate limiting on auth/registration/invitation endpoints. CORS allow-list, security headers (Helmet), CSRF protection for the cookie-based refresh endpoint. Secrets from environment/secret store only. Uploads: type/size limits, stored outside the web root, images re-encoded.

## 10. Deployment model

| Environment | Model | Status |
|---|---|---|
| Local development | Docker Compose: DB, queue backend (if any), Mailpit, API, worker, web, (optionally) Prometheus + Grafana | **Approved direction** (Docker, Compose [P]); service list depends on D-01..D-03 |
| CI | GitHub Actions: lint, test with a real DB service container, build images | **Approved direction** [P] |
| Demo/production | Single VM running Docker Compose behind a reverse proxy with TLS | [R] default |
| Cloud provider | AWS or Azure | **OPEN (D-07)** |
| Orchestration | Kubernetes, multiple services, auto-scaling | **[F]** not in R1 |

Backups: scheduled DB dump plus file-storage backup, with one tested restore before delivery [R]. Configuration through environment variables; one image per component; migrations run as a separate step before the API starts.

## 11. Scalability path (documentation only for R1, feature 17 [F])

1. Run multiple API/worker replicas behind a load balancer (the API is already stateless).
2. Move the database and queue to managed services; add a read replica for analytics.
3. Move files to object storage with a CDN.
4. Only if a measured bottleneck proves it: extract the worker or a single module into a service.
5. Kubernetes only when the team has multiple services and operational need.

## 12. Architecture risks

| Risk | Mitigation |
|---|---|
| Booking logic spread across modules | Single `bookings` service with the DB constraint as final guard |
| Lost or duplicated jobs | Outbox + idempotent handlers + unique constraints |
| Cross-module coupling | Service interfaces only; lint rule for import boundaries [R] |
| Four developers blocked by shared contracts | Freeze I-1..I-12 in Week 1 |
| PDF rendering memory/time | Simple pdfkit-based layout first; render in the worker only |
| Time zone errors | UTC storage, one display zone, tests around midnight and DST-free zone |

## 13. Event contract (as built)

The events, approvals and calendar modules are implemented. Their shared contract for the booking and registration features (identifiers, time zones, lifecycle, hooks, calendar guard, migration ranges) is in `docs/event-contract.md`. Module notes: `modules/events` owns events/speakers/history and the lifecycle; `modules/approvals` owns decisions and the approver rules and depends on events; `modules/calendar` owns academic calendar entries and the `checkRange` guard. Other modules use `modules/events/index.ts` as the public interface.

## 14. Hall booking and resources (as built)

`modules/halls` owns halls; `modules/resources` owns resources and reservations; `modules/bookings` owns hall bookings, their two-step approval and the event hooks. They reach events only through `modules/events/index.ts` and the calendar through `checkRange`. Design, concurrency strategy and limits: `docs/booking-design.md`.

## Lifecycle hooks in every process

Anything that changes an event's state (the API, and the worker when it closes finished events) calls `registerEventHooks(ctx)` (`src/hooks.ts`) at start-up. A process without it would change events without queueing the report or releasing bookings; `test/hooks-wiring.test.ts` checks that both entry points call it and that every module registering an event hook is listed.
