# College Event Operations Platform

Event OPERATIONS platform (not just registration): event creation, multi-level approval,
hall booking, equipment, registration, attendance, certificates, reporting, monitoring.
4-person B.Tech CSE team, 12-week project. Detailed scope: `docs/requirements.md`.

## Repository state
Shared foundation implemented (see `docs/feature-status.md` for evidence): npm-workspaces monorepo
(`apps/api`, `apps/web`), config/secrets handling, PostgreSQL migrations, auth with refresh rotation,
server-side RBAC, audit log, DB-backed job queue + worker, notification and file-storage building
blocks, Docker/Compose/CI definitions, and Event Management & Approvals (events, Faculty → HOD → Admin
approvals, academic calendar guard; contract in `docs/event-contract.md`). Registration,
attendance, certificates and reports are not built yet. Hall booking and resource management are built
(`docs/booking-design.md`). Admin screens for the audit-log search and failed background jobs exist (`/api/admin/*`).
Inspect the tree before assuming anything exists. Update this section as it changes.

## Decision status
Always check this before building on a technology.

| Item | Status |
|---|---|
| React (frontend), Node.js + Express REST API | Confirmed |
| JWT auth + role-based access control | Confirmed |
| Git, GitHub, Docker, Docker Compose, GitHub Actions | Confirmed |
| Post-event PDF report (feature 19), academic calendar guard (feature 20) | Approved additions |
| React + TypeScript, Node/Express + TypeScript, PostgreSQL with versioned migrations, npm workspaces (`apps/api`, `apps/web`) | Approved 2026-10-23 |
| Redis | Not used. Needed only if a later decision approves it |
| Queue implementation | Provisional: PostgreSQL-backed `jobs` table (D-03 still needs formal approval) |
| Prometheus/Grafana | Planned; deployment approach **OPEN** |
| Cloud provider (AWS vs Azure) | **OPEN** |
| Kubernetes, microservices, predictive ML, advanced disaster recovery | **Future scope** — do not introduce without explicit approval |

Do not treat OPEN items as decided. If work needs one, stop, state the options and trade-offs
briefly, and ask. Record the outcome in `docs/decisions.md` (single decision log).

## Project documents
`docs/requirements.md` (scope, acceptance criteria) · `docs/architecture.md` · `docs/decisions.md` ·
`docs/implementation-roadmap.md` · `docs/testing-strategy.md` · `docs/feature-status.md`
(update it in the same PR as any status change; "Tested" needs evidence).

## Feature groups (summary; see docs/requirements.md)
1 Auth/users · 2 Events · 3 Individual/team registration + invitation codes · 4 Hall booking,
availability, conflicts, concurrency · 5 Equipment/resources · 6 Approvals Organizer→Faculty→HOD→Admin ·
7 QR check-in, attendance, PDF gate passes · 8 Certificates, feedback · 9 Budget, analytics, reports ·
10 Email + background jobs · 11 Audit trail, admin · 12 Risk/health scoring, conflict prediction,
resource allocation · 13 Security/concurrency/reliability · 14 Frontend/REST/DB integration ·
15 Git/Docker/CI-CD · 16 Monitoring · 17 Scalability (future) · 18 Testing/docs/delivery ·
19 Auto post-event PDF report on event close · 20 Academic calendar guard (blocks restricted
dates, warns on configured conflicts).
First release excludes feature 17 beyond documentation; feature 12 is rule-based (weighted
checks), not ML.

## Architecture principles
- Modular monolith: one Express API plus a separate worker process sharing one codebase. No microservices.
- One module per domain (auth, events, approvals, bookings, equipment, registrations, attendance,
  certificates, reports, audit, calendar). Each owns routes → controller → service → repository
  and its validation schemas.
- Modules interact via service functions, never by reading another module's tables directly.
- Controllers are thin; business rules live in services; SQL lives in repositories.
- API is stateless; config via environment variables (12-factor); containers must be runnable
  with `docker compose up`.
- REST contract is documented (OpenAPI) so frontend and backend can proceed in parallel.

## Security requirements
- JWT: short-lived access token; refresh tokens rotated, stored hashed, revocable. Never put
  secrets or sensitive data in a JWT payload.
- RBAC is enforced on the BACKEND for every route. Frontend hiding is cosmetic only.
- Authorization = role check AND ownership/scope check (e.g. organizer owns the event, HOD's
  department). Add tests for denied access.
- The approval state machine is enforced server-side: correct order, no skipping, no self-approval.
- Validate every external input (body, query, params, uploads) with a schema; reject unknown fields.
- Parameterized queries only. Escape/sanitize user content rendered into PDFs and emails.
- Secrets only from environment variables / secret store. Never commit `.env`, keys or real
  credentials; keep `.env.example` current with placeholders. No secrets or PII in logs.
- Rate-limit login, registration and invitation-code endpoints. Invitation codes: random,
  expiring, single-use as configured.
- QR payloads are signed and verified server-side; check-in is single-use, enforced in the database.
- Audit trail: security- and state-changing actions (login, role change, approvals, bookings,
  cancellations, check-ins, admin edits) write append-only audit records with actor, action,
  target, time, and before/after where useful.

## Data-integrity requirements
- Multi-step business operations run in one DB transaction.
- Enforce invariants in the database (unique, foreign key, check constraints), not only in code.
- Booking: two active bookings for the same hall must never overlap. The database must be the
  final guard (constraint or equivalent); application pre-checks are UX hints only. Conflicts
  return 409. Test with parallel requests.
- Capacity, seats and equipment quantity use atomic conditional updates or row locks; no
  read-then-write races.
- Retry only idempotent operations, with bounded attempts (e.g. serialization failures).
- Mutating endpoints that clients may retry (registration, booking) support an idempotency key.
- Timestamps stored in UTC with a single documented display time zone.
- Schema changes only through reviewed, versioned migrations. Never edit an applied migration.

## Background jobs
- Email, PDF generation, certificates and the post-event report run asynchronously in the
  worker, never in the request path.
- Jobs are idempotent: deterministic job IDs plus unique DB constraints so a retry cannot send
  duplicate emails or create duplicate certificates/reports.
- Retry policy: bounded attempts, exponential backoff, then dead-letter/failed state. Exact
  values are set when the queue is chosen and documented.
- Failures are observable: structured logs with job ID and correlation ID, failure metrics,
  and an admin-visible failed-job status.
- Enqueue after the business transaction commits, or use an outbox, so work is never lost
  or queued for rolled-back data.

## Commands
Run from the repository root (details and first-time setup: `README.md`).
- `npm run setup:env` create `.env` with generated secrets; `docker compose up -d db mailpit` start Postgres + Mailpit
- `npm run migrate` / `npm run migrate -- down [n]` apply / revert migrations
- `npm run create-admin` first admin from `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` (no defaults)
- `npm run dev` API (:4000) + worker + web (:5173)
- `npm test` all tests; one file: `npm test -w @events/api -- test/auth.test.ts`
- `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`
- API tests need `TEST_DATABASE_URL` (database name must contain "test"); they truncate tables.
- Docker is not installed on the original dev machine, so the Compose/Dockerfiles/CI have not been run there.

## Coding conventions
- Follow existing patterns in the module you are editing; match naming, structure and comment style.
- TypeScript strict mode; ESM (`.js` extensions in API imports). ESLint + Prettier must pass
  (`docs/`, `CLAUDE.md` and `*.sql` are excluded from Prettier).
- Module layout: `src/modules/<name>/{routes,service,repository}.ts`. Routes parse input with
  `parse(strictZodSchema, ...)`; services own rules and transactions (`withTx`); repositories own SQL.
- Errors: throw `errors.*` / `AppError`; never return ad-hoc error bodies. Do not log secrets or put them in audit metadata.
- New background work: register a handler in `src/worker.ts`; enqueue with a stable `key` inside the business transaction.
- Shared registries every feature extends (keep additions small to avoid merge conflicts): `AUDIT_ACTIONS` (`modules/audit/audit.ts`), notification `templates` (`modules/notifications/templates.ts`), route registration (`src/app.ts`), `resetDb` table list (`test/helpers.ts`), web routes (`apps/web/src/App.tsx`).
- Hall bookings are protected by a PostgreSQL exclusion constraint; never replace it with an application-only check. Work that holds a transaction must use that transaction's connection, never `ctx.pool` (it can starve the pool). Wrap transactions that may deadlock in `retryTx`.
- The academic calendar is advisory: it informs, it never refuses.
- Other features talk to events through `modules/events/index.ts` (types, `isEligibleForRegistration`, `registerEventHook`, `checkRange`), never by querying the events tables.
- Migrations: new files only, never edit a committed one. Number ranges per owner (see `docs/decisions.md` D-16); the runner rejects a file that sorts before an applied one.
- Meaningful error types mapped to consistent HTTP responses; no leaking stack traces to clients.
- No dead code, speculative abstractions or TODOs without an issue reference.

## Testing expectations (every feature)
- Unit tests for service logic; integration tests for API routes against a real database.
- Authorization tests: allowed role succeeds, wrong role/scope gets 403, unauthenticated gets 401.
- Validation tests for bad input. Tests for each error path that has defined behaviour.
- Concurrency tests for booking, capacity and equipment. Idempotency/retry tests for jobs.
- Never report tests, builds or deployments as passing unless you ran them and saw the result.

## Git workflow
- Work on feature branches, never commit directly to `main`. Small, focused commits with
  imperative messages; one concern per PR.
- Every PR: description, linked requirement/feature number, tests, and passing CI before merge;
  at least one teammate review.
- Do not rewrite shared history or force-push shared branches.
- Do not commit generated files, `node_modules`, build output or secrets.
- Commit or push only when the user asks.

## Definition of done (feature)
1. Behaviour matches `docs/requirements.md` acceptance criteria.
2. Backend authorization and input validation in place.
3. DB constraints and migrations reviewed; transactions where needed.
4. Audit records for state-changing actions.
5. Tests written and actually run; CI green.
6. Errors, logs and (if relevant) metrics observable.
7. API documented; user-facing docs/README updated.
8. Reviewed by a teammate and merged via PR.

## Working rules for Claude
- Inspect existing code before editing. Read a file fully before changing it; never overwrite
  without reading.
- Make the smallest change that solves the task. No unrelated refactoring, renaming or
  reformatting.
- Do not invent requirements. Label assumptions; ask only when a decision genuinely blocks work.
- Do not add dependencies, infrastructure, microservices or Kubernetes without approval.
- Plan first for multi-module or schema changes, and wait for approval.
- Keep this file accurate: when a decision is made or commands are created, update it.
