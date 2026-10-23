# Feature Status

Last verified against the repository: 2026-10-23 (shared-foundation milestone).

## Status rules

Allowed values: **Not started · In progress · Implemented · Tested · Blocked**.

- **Implemented** requires merged code in the repository.
- **Tested** requires automated tests mapped to the AC-/AT- ids in `requirements.md`, executed successfully (cite the CI run or command output).
- **Blocked** requires a named blocker (decision id or dependency).
- Update this file in the same PR as the change, citing evidence.
- "In progress" is used for a feature group whose foundation exists but whose requirements are not all met. The notes say exactly what is and is not done.

## Evidence at the time of writing

Commands actually run on the development machine (macOS, Node 24, PostgreSQL 16 via Homebrew on port 5433; **Docker is not installed there**):

| Check                                                                | Result                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm test -w @events/api` (real PostgreSQL test database)            | 177 tests in 8 files passed                                                  |
| `npm test -w @events/web`                                            | 13 tests in 2 files passed                                                   |
| `npm run lint`, `npm run typecheck`, `npm run build`                 | passed (no errors)                                                           |
| `prettier --check` on code (docs excluded)                           | passed                                                                       |
| `npm run migrate` against a fresh database                           | applied `001_identity`, `002_jobs`                                           |
| `npm run dev` + HTTP calls via the Vite proxy                        | health, login, `/me`, user creation, refresh rotation, 401 without token OK  |
| Compiled API (`dist`) with production-only dependencies              | started, migrations CLI ran, readiness check returned `database: up`         |
| `create-admin` (success, duplicate email, missing variables)         | behaved as designed                                                          |
| Worker process with SMTP unreachable                                 | job retried with backoff, error recorded                                     |
| Mutation check (disable `requireRole`/active check/family revocation) | 42 and 1 tests failed respectively; restored; all pass again                 |

**Not run (no evidence):** `docker build`, `docker compose up`, the GitHub Actions workflow (never pushed, no remote exists), delivery of a real email through an SMTP server (the SMTP transport is untested; the job and template flow is tested with an in-memory mailer), and any browser-level (Playwright) test. The frontend was verified through component tests and HTTP calls to the dev proxy, not by driving a browser.

## Status table

| #   | Feature group                                         | Source | Release              | Status      | Evidence / notes                                                                                                                                                                                                                              | Blockers / depends on                           |
| --- | ----------------------------------------------------- | ------ | -------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | Authentication and user management                    | P      | R1                   | In progress | Login, refresh rotation with reuse detection, logout, change password, lockout, rate limit, admin user CRUD, roles, deactivation, last-admin protection: implemented and tested (AC-1.1–1.5). **Missing:** password reset (FR-1.4), onboarding beyond admin-created accounts | U-1; password reset needs email delivery in use |
| 2   | Event creation and management                         | P      | R1                   | Not started | No code                                                                                                                                                                                                                                       | Feature 1 (done); U-5                           |
| 3   | Individual and team registration, invitation codes    | P      | R1                   | Not started | No code                                                                                                                                                                                                                                       | Feature 2; U-9                                  |
| 4   | Hall booking, availability, conflicts, concurrency    | P      | R1                   | Not started | No code. PostgreSQL decision (D-01) unblocked the overlap constraint                                                                                                                                                                          | Features 2, 20; U-10, U-11                      |
| 5   | Equipment and resource management                     | P      | R1                   | Not started | No code                                                                                                                                                                                                                                       | Feature 2                                       |
| 6   | Multi-level approvals                                 | P      | R1                   | Not started | No code                                                                                                                                                                                                                                       | Features 2; U-4, U-5                            |
| 7   | QR check-in, attendance, PDF gate passes              | P      | R1                   | Not started | No code. Job queue and file storage building blocks exist                                                                                                                                                                                     | Feature 3; D-10; U-8                            |
| 8   | Certificates and feedback                             | P      | R1                   | Not started | No code                                                                                                                                                                                                                                       | Features 7, 10; U-6, U-12                       |
| 9   | Budget tracking, analytics, reports                   | P      | R1-lite              | Not started | No code                                                                                                                                                                                                                                       | Feature 2                                       |
| 10  | Email notifications and background jobs               | P      | R1                   | In progress | Job queue (retry, backoff, failed state, idempotent keys, crash recovery, no double processing), worker process, notification templates and `email.send` handler: implemented and tested with an in-memory mailer. **Missing:** real SMTP delivery not verified; only one notification type (`account.created`); no admin screen for failed jobs | D-03 formal approval; D-09                      |
| 11  | Audit trails and administrative management            | P      | R1                   | In progress | Append-only `audit_log` (DB trigger blocks UPDATE/DELETE) and `recordAudit` used by auth, user and department actions: implemented and tested (AC-11.1, 11.3 partially). **Missing:** audit search endpoint/UI, halls and equipment admin       | Features 4, 5                                   |
| 12  | Risk/health scoring, conflict prediction, allocation  | P      | R1-lite (rule-based) | Not started | No code; ML is future scope                                                                                                                                                                                                                   | Features 4, 5, 20                               |
| 13  | Security, concurrency, reliability                    | P      | R1                   | In progress | Backend RBAC matrix tested over every route, strict input validation, config fail-fast, secrets via environment, security headers, CORS allow-list, CSRF origin check, rate limiting, request ids, redacted logs. Feature-specific rules continue per feature | Cross-cutting                                   |
| 14  | Frontend, REST APIs, database integration             | P      | R1                   | In progress | React app (login, protected routes, role-aware navigation, admin user management) talking to the API; migrations in place. **Missing:** OpenAPI spec, contract tests, event screens                                                          | Feature screens                                 |
| 15  | Git, Docker, CI/CD                                    | P      | R1                   | In progress | Git repo, `.gitignore`, workspaces, Dockerfiles, `docker-compose.yml`, `.github/workflows/ci.yml` written. **Not executed:** Docker builds, Compose, CI (no Docker locally, no remote). No commits yet                                      | Docker install; GitHub remote                   |
| 16  | Monitoring and observability                          | P      | R1-lite              | In progress | Liveness and readiness endpoints, structured JSON logs with request ids, job success/failure logs. **Missing:** `/metrics`, Prometheus, Grafana                                                                                                 | D-06                                            |
| 17  | Future scalability (LB, microservices, K8s, cloud, DR) | P     | Future (design note) | Not started | Approach outlined in `architecture.md` §11                                                                                                                                                                                                    | Not in R1 build scope                           |
| 18  | Testing, documentation, deployment, delivery          | P      | R1                   | In progress | Test setup, README with setup steps, planning docs. **Missing:** deployment, E2E tests, API docs                                                                                                                                             | D-07                                            |
| 19  | Automatic post-event report (PDF)                     | N      | R1                   | Not started | Requirements and AT-19.1–19.9 written. Foundations it will use exist: job queue, file storage (PDF type check, safe download)                                                                                                                | Features 2, 7, 8; D-10; U-7                     |
| 20  | Academic calendar guard                               | N      | R1                   | Not started | Requirements and AT-20.1–20.10 written. Audit and admin roles available                                                                                                                                                                      | Feature 4 integration; U-3                      |

Source: P = presentation-confirmed, N = newly approved addition.

## Summary

- Implemented fully: none. Tested fully: none. Several feature groups have an implemented and tested foundation (1, 10, 11, 13, 14) with the gaps listed above.
- In progress: 1, 10, 11, 13, 14, 15, 16, 18. Not started: 2–9, 12, 17, 19, 20. Blocked: none.
