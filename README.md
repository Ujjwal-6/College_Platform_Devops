# College Event Operations Platform

Centralised platform for the college event lifecycle: events, approvals, hall booking, equipment, registration, attendance, certificates, reporting and monitoring. See `docs/` for requirements, architecture, decisions, roadmap and status; `CLAUDE.md` holds the engineering rules.

**Current state:** the shared foundation and the business features are built: events and approvals, hall booking and equipment, registration, attendance, certificates and feedback, post-event reports, budgets and analytics, password reset, automatic closing and metrics. `docs/feature-status.md` says exactly what was tested and what was not. Team guides: `docs/team-git-guide.md` (applying and pushing the deliveries) and `docs/manual-test-guide.md` (testing by hand with every kind of user).

## Stack

React + TypeScript (Vite) · Node.js + Express + TypeScript · PostgreSQL 16 with versioned SQL migrations · npm workspaces (`apps/api`, `apps/web`) · Docker Compose · GitHub Actions.

## Prerequisites

- Node.js 22 or newer (`.nvmrc`) and npm 10 or newer
- PostgreSQL 16 for local development, either through **Docker** (recommended) or installed natively (see "Without Docker")

## First-time setup

```bash
npm install
npm run setup:env          # creates .env with generated secrets (never overwrites an existing .env)
docker compose up -d db mailpit
npm run migrate            # applies apps/api/migrations to the database
```

Create the first administrator. Choose your own password (12+ characters); there are no default credentials:

```bash
ADMIN_EMAIL=you@college.edu ADMIN_NAME="Your Name" ADMIN_PASSWORD='choose-a-long-passphrase' npm run create-admin
```

Start everything (API on :4000, job worker, web on :5173):

```bash
npm run dev
```

Open http://localhost:5173 and sign in. Outgoing email is caught by Mailpit at http://localhost:8025.

If port 5432 is already used on your machine, run `POSTGRES_PORT=5433 npm run setup:env` instead of the plain command.

### Without Docker

Install PostgreSQL 16 and create two databases, `events_dev` and `events_test`, owned by a role of your choice. Put the connection strings in `.env` (`DATABASE_URL`, `TEST_DATABASE_URL`) and skip the `docker compose` line. Email sending needs an SMTP server on `SMTP_HOST:SMTP_PORT`; without one, email jobs retry and are eventually marked failed, which does not affect anything else.

## Everyday commands

| Command                                           | What it does                                             |
| ------------------------------------------------- | -------------------------------------------------------- |
| `npm run dev`                                     | API + worker + web with reload                           |
| `npm test`                                        | All tests (API tests need the test database)             |
| `npm run lint` / `npm run format:check`           | ESLint / Prettier                                        |
| `npm run typecheck`                               | TypeScript checks for both apps                          |
| `npm run build`                                   | Production builds (`apps/api/dist`, `apps/web/dist`)     |
| `npm run migrate` / `npm run migrate -- down [n]` | Apply / revert migrations                                |
| `npm run create-admin`                            | Create the first admin from `ADMIN_*` variables          |
| `docker compose --profile app up --build`         | Whole stack in containers (web on http://localhost:8080) |

Run one API test file: `npm test -w @events/api -- test/auth.test.ts`.

## Configuration and secrets

All configuration is read from environment variables and validated at startup (`apps/api/src/config.ts`); the API refuses to start with a missing or weak `JWT_SECRET`. `.env.example` lists every variable with safe placeholders. `.env` is gitignored: never commit it. Tests use `TEST_DATABASE_URL` and refuse to run against any database whose name does not contain `test`.

## Monitoring, automatic closing and password reset

- `/metrics` (API) and `WORKER_METRICS_PORT` (worker) serve Prometheus metrics only when `METRICS_TOKEN` is set; send it as `Authorization: Bearer <token>`. `docker compose --profile app --profile monitoring up` adds Prometheus (http://localhost:9090) and Grafana (http://localhost:3000, dashboard "College Events"). `npm run setup:env` writes the token for Prometheus to `infra/monitoring/metrics-token`; with an older `.env`, add `METRICS_TOKEN` yourself and put the same value in that file. See `docs/monitoring.md`.
- Finished events close themselves `EVENT_AUTO_CLOSE_HOURS` (default 24) hours after they ended; the worker must be running. The organizer can close an ended event by hand sooner.
- "Forgot your password?" on the sign-in page emails a link (valid `PASSWORD_RESET_TTL_MINUTES`, default 60, works once). In development the email appears in Mailpit.

## Layout

```
apps/api/        Express API, job worker, migrations, tests
  src/modules/     auth, users, departments, audit, notifications, health,
                   events, approvals, calendar (event lifecycle + advisory academic calendar),
                   halls, bookings, resources (hall booking, equipment reservations)
  src/platform/    db/transactions, errors, validation, logging, jobs, mailer, storage
  migrations/      versioned SQL migrations (node-pg-migrate)
apps/web/        React app (login, users, events, approvals, calendar, halls, bookings, resources)
infra/postgres/  database bootstrap for Docker
docs/            requirements, architecture, decisions, roadmap, testing, status
```

## Building blocks for feature developers

| Need                                 | Use                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Protect a route                      | `requireAuth(ctx)` then `requireRole(...)`; department scope via `assertDepartmentScope`                                              |
| Validate input                       | `parse(zodStrictSchema, req.body)` (unknown fields are rejected)                                                                      |
| Return errors                        | throw `errors.*` / `AppError`; one JSON error format with `code` and `requestId`                                                      |
| Multi-step change                    | `withTx(pool, async (tx) => { ... })`; pass `tx` to every repository call                                                             |
| Audit a change                       | `recordAudit(tx, { actorId, action, targetType, targetId, ... })` in the same transaction                                             |
| Run work in the background           | `enqueue(tx, { type, payload, key })` and `worker.register(type, handler)` in `src/worker.ts`                                         |
| Send an email                        | add a template in `modules/notifications/templates.ts`, call `notify(tx, {...})`                                                      |
| Store a PDF or image                 | `ctx.storage.put({ data, allowed, maxBytes })`, serve with `sendStoredFile`                                                           |
| React to event changes               | `registerEventHook(async (tx, { event, action }) => ...)` from `modules/events/index.ts` (runs in the action's transaction, may veto) |
| Check academic dates                 | `checkRange(db, ctx.config.APP_TIMEZONE, { startAt, endAt, departmentId })` → `{ blocks, warnings }`                                  |
| Book a hall / reserve equipment      | `POST /api/bookings`, `POST /api/resource-reservations`; the no-overlap rule is a database constraint (`docs/booking-design.md`)      |
| Retry a transaction after a deadlock | `retryTx(() => withTx(...))` from `platform/db.js` (only for work that is safe to repeat)                                             |
| Is an event open for registration?   | `isEligibleForRegistration(event)`; the full event contract is in `docs/event-contract.md`                                            |

## Security notes

- Access token: 15-minute JWT held in memory only. Refresh token: opaque, stored hashed, delivered as an httpOnly `SameSite=Strict` cookie, rotated on every use; replaying an old token revokes the session.
- Roles are read from the database on every request, so role changes and deactivation apply immediately.
- Login: generic errors, per-IP rate limit, per-account lockout. The rate limiter is in memory (single instance) until a shared store is approved.
- Set `COOKIE_SECURE=true` (the default when `NODE_ENV=production`) and serve over HTTPS in any real deployment.
- In production, connect the API with a database role that is not the table owner and cannot truncate or alter `audit_log`.

## Known limitations

See `docs/feature-status.md`. In short: no self-registration, the screens have been tested with mocked-API component tests but not in a real browser, Prometheus/Grafana have never been started, and the Docker/CI definitions have not been executed in every environment (see the status document for what was actually run).
