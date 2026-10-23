# Testing Strategy

Status: **proposal.** No tests exist yet. Tool names are recommendations (decision D-13); the test categories and expectations are what matter. Nothing may be reported as passing unless it was actually run and the result seen.

## 1. Principles
- Every feature ships with tests in the same PR (see Definition of Done in `CLAUDE.md`).
- Tests that exercise constraints, transactions and concurrency run against a **real database**, not a mock or in-memory substitute. Same engine and version as production.
- Each acceptance criterion (AC-/AT- ids in `requirements.md`) maps to at least one automated test; the test name includes the id.
- CI blocks merging on failure. Flaky tests are fixed or removed, not retried silently.

## 2. Test levels

| Level | Scope | Tools (recommended) | Runs |
|---|---|---|---|
| Unit | Pure logic: state machine, calendar range rules, risk scoring, QR signing, money maths, idempotency-key hashing | Vitest/Jest | Every commit |
| API integration | HTTP → service → real DB, with the queue stubbed or real | Supertest + test DB | Every PR |
| Authorization | Matrix of route × role × scope | Supertest | Every PR |
| Concurrency | Parallel requests against booking, capacity, equipment, approval, check-in | Test harness using `Promise.all` against a real DB | Every PR (small N), nightly (large N) |
| Worker / job | Handlers, retries, backoff, dead-letter, idempotency, outbox | Worker test harness with fake SMTP (Mailpit) and fault injection | Every PR |
| Contract | Responses match OpenAPI | OpenAPI validator | Every PR |
| Frontend component | Forms, role-based UI, error states | Testing Library | Every PR |
| End-to-end | Main user journeys in a browser against the Compose stack | Playwright | PR to `main` / nightly |
| Security | Dependency audit, secret scan, static analysis, manual checklist | `npm audit`, secret scanner, linters | Every PR / before release |
| Load | Booking and registration under load; report batch | k6 or autocannon | Phase 4, before release |

## 3. Test data and environments
- Factories for users (each role), departments, halls, equipment, events in each state, calendar entries.
- Each test (or file) runs in an isolated schema/transaction or resets tables; the test DB is created by the same migrations as production.
- A fake clock helper for expiry (tokens, invitation codes, QR) and midnight edge cases.
- Fake SMTP (Mailpit) and a fake object store for jobs.

## 4. Authorization test matrix (mandatory per route)
For each endpoint, tests cover:
1. Unauthenticated → 401
2. Authenticated, wrong role → 403
3. Correct role, wrong scope (someone else's event/department) → 403 or 404 by policy
4. Correct role and scope → success
5. Deactivated user → rejected

Special cases: self-approval forbidden (AC-6.2); approver out of order (AC-6.1); non-admin calendar edits (AT-20.7); report download by unrelated users (AT-19.6).

## 5. Concurrency tests (mandatory)

| Test | Setup | Expectation |
|---|---|---|
| Booking overlap (AC-4.1) | 50 parallel requests, same hall and slot | exactly 1 × 201, 49 × 409; one active row |
| Direct-SQL overlap (AC-4.3) | Insert overlapping row bypassing services | DB rejects it |
| Adjacent slots (AC-4.2) | 10–12 and 12–14 | both accepted |
| Capacity (AC-3.1) | capacity 10, 50 parallel registrations | exactly 10 succeed |
| Team size (AC-3.4) | parallel joins at the limit | never exceeds max |
| Equipment (AC-5.1) | stock 5, parallel 3 + 3 overlapping | exactly one succeeds |
| Approval step (AC-6.3) | two concurrent decisions on one step | one wins; one decision row |
| Check-in (AC-7.2) | two simultaneous scans of one QR | one attendance row |
| Guard + booking (AT-20.10) | many parallel bookings on a blocked date | all rejected |
| Idempotency (AC-3.5) | same key, parallel requests | one resource, same response |

Concurrency tests run with enough repetitions to be meaningful (e.g. loop 20 times in nightly) because races are probabilistic.

## 6. Worker and job tests
- Successful run; failure then success (retry with backoff measured with a fake clock).
- Maximum attempts exhausted → failed state, failure metric incremented, admin visible (AC-10.1).
- Duplicate delivery → single side effect (AC-10.2, AT-19.3, AC-8.1).
- Rollback → no job (AC-10.3, AT-19.5). Simulate a crash between commit and enqueue to prove the outbox republishes.
- Worker killed mid-job → job is retried and does not duplicate output.
- Payload validation: malformed jobs fail permanently without infinite retries.

## 7. Feature-specific test plans

### Feature 20 — Academic calendar guard (tests AT-20.1 to AT-20.10)
Table-driven unit tests for range logic (before, after, adjacent, partial overlap, contained, spanning, multi-entry, scoped/unscoped, inactive), plus API tests for each AT above, plus the parallel test AT-20.10 and the conflict-report test AT-20.8. Calendar CRUD authorization and audit tests (AT-20.7, AT-20.9).

### Feature 19 — Automatic post-event report (tests AT-19.1 to AT-19.9)
- Data-assembly unit tests: attendance counts and percentages from fixtures; absent photos/feedback; special characters.
- Job tests for retry, idempotency, rollback and versioning.
- PDF checks: the file is a valid PDF, extract its text and assert key values (title, 10 registered, 8 attended, 80%, speaker names, "no photographs provided"), page count within a sane range; a manual visual check recorded at release.
- API tests: close returns promptly (AT-19.9), download authorization (AT-19.6), regeneration (AT-19.8).

### Feature 7 — QR and gate pass
Signature tampering, expiry, cross-event, cancelled registration, volunteer authorization; PDF content check.

### Features 3, 4, 5, 6
Covered by the concurrency and authorization sections above; add state-transition tests for every allowed and disallowed move.

## 8. End-to-end journeys (Playwright)
1. **Lifecycle:** organizer creates event → faculty/HOD/admin approve → hall booked → student registers → volunteer checks in → feedback → certificate → event closed → report downloadable.
2. **Calendar guard:** admin adds exam-period block and fest warning → organizer sees the block and the warning.
3. **Team registration:** leader creates team and code; member joins; capacity edge.
Optional (if time): failure and recovery of the mail server.

## 9. CI pipeline (GitHub Actions; recommended stages)
1. Install, lint, type-check (if TypeScript).
2. Unit tests.
3. Start DB (and queue backend, if any) as service containers; run migrations; integration, authorization, concurrency (small N) and worker tests.
4. OpenAPI validation and contract tests.
5. Security: dependency audit and secret scan.
6. Build Docker images.
7. E2E on the Compose stack (on PRs to `main`).
Coverage targets (recommendation, adjust if the team disagrees): ≥ 80% line coverage on services and ≥ 90% branch coverage on the state machine, calendar guard and booking service. Coverage is a guide; the AC mapping is the requirement.

## 10. Release gate
Before delivery: all tests green in CI on the release commit; load-test results saved; security checklist done; one backup restore verified; E2E lifecycle journey passes on the deployed demo; known issues listed in the final report.

## 11. Reporting rule
`feature-status.md` may mark a feature **Tested** only when its AC-/AT- tests exist in the repository and have been run successfully, with the CI run or command output as evidence.
