# Implementation Roadmap (12 weeks)

Status: **proposal for approval.** No application code exists yet. Technology-dependent steps assume the recommended defaults in `decisions.md`; if the team picks differently, only the marked items change.

Team areas (proposed; names assigned under U-15):
- **Dev A** — identity, events, approvals, audit
- **Dev B** — halls/bookings, calendar guard, equipment, risk score
- **Dev C** — registrations, attendance/QR, queue/worker, notifications, certificates, report PDF
- **Dev D** — frontend, Docker/CI, observability, OpenAPI, test infrastructure, budget/analytics UI

## Dependency overview

```
Decisions D-01..D-05 ─> Foundations ─> Auth/Events (A) ─┬─> Approvals (A)
                                                         ├─> Calendar → Bookings → Equipment (B)
                                                         └─> Registrations (C) ─> Attendance/QR (C)
Queue/worker (C) ─> Notifications ─> Gate pass, Certificates, Report (C)
Attendance + Feedback ─> Report ─> Analytics/Risk
Frontend (D) follows OpenAPI contracts; CI/Docker (D) from Week 1
```
Critical path: **decisions → auth → events → approvals → calendar + bookings → registrations → attendance → queue → certificates/report.**

## Phase plan

### Phase 0 — Foundations and decisions (Week 1)
- Approve D-01 to D-05, D-12 and the U-items that affect schemas (U-3, U-4, U-5).
- Create the monorepo scaffold, linting/formatting, `.gitignore`, `.env.example`, Docker Compose (DB, queue backend if any, Mailpit), CI skeleton (lint + test).
- Freeze shared interfaces I-1 to I-12 (see `architecture.md`) as short written contracts or stub code with tests.
- Database conventions, migration tool, `withTx`, test DB setup, factories.
- **Deliverables:** `docker compose up` works; CI runs on a PR; ADR entries; stub interfaces.
- **Exit criteria:** every developer can run the stack and tests; shared interfaces reviewed by all four.

### Phase 1 — Identity and events (Weeks 2–3)
- A: auth, refresh rotation, RBAC middleware, users/departments, audit module, event CRUD + state machine.
- B: halls and equipment catalogues (admin CRUD), calendar entries CRUD (feature 20 data model and admin API), no booking yet.
- C: queue/worker skeleton, retry policy, email job with Mailpit, outbox.
- D: frontend shell, login, role-aware routing, API client, OpenAPI skeleton, test fixtures.
- **Milestone M1 (end of Week 3):** a user can log in; an organizer can create a draft event; the worker sends a test email; the calendar admin can add entries.
- **Exit criteria:** AC-1.x, AC-2.x pass; authorization test pattern established; calendar CRUD tested (AT-20.7, AT-20.9).

### Phase 2 — Approvals, calendar guard, bookings (Weeks 4–5)
- A: approval chain and history, notifications triggered by decisions.
- B: `calendar.checkRange`, booking with DB overlap guarantee, availability, equipment reservations, integration of guard inside the booking transaction.
- C: registrations and teams (can begin once events exist), seat counter, invitation codes.
- D: event and approval screens, booking screen with availability and warnings.
- **Milestone M2 (end of Week 5):** an event can be submitted, approved through four levels, and its hall booked with calendar blocks/warnings working.
- **Exit criteria:** AC-4.x, AC-5.x, AC-6.x, AT-20.1 to AT-20.10 pass, including the 50-parallel booking test.

### Phase 3 — Registration, attendance, outputs (Weeks 6–8)
- C: QR generation/verification, check-in, gate pass job; certificates and feedback; **report job and PDF (feature 19)**, file storage interface.
- A: event close action + outbox trigger, audit coverage review, admin audit search.
- B: budget lines, analytics queries, equipment return flag.
- D: registration and check-in UI (phone camera), certificate/feedback screens, report download; Prometheus/Grafana skeleton.
- **Milestone M3 (end of Week 8):** end-to-end lifecycle works in the demo environment: create → approve → book → register → check in → certificate → closed event → report PDF.
- **Exit criteria:** AC-3.x, AC-7.x, AC-8.x, AT-19.1 to AT-19.9, AC-10.x pass.

### Phase 4 — Insight, observability, hardening (Weeks 9–10)
- B: rule-based risk score and allocation suggestions (feature 12).
- D: metrics, dashboards, alert; E2E tests (Playwright) for the main journeys.
- A/C: security review (authorization matrix audit, rate limits, upload checks, dependency/secret scanning), performance/load test for booking and registration, job failure/restart tests.
- **Milestone M4 (end of Week 10):** feature-complete for R1; no known high-severity security issues; dashboards live.
- **Exit criteria:** AC-9.x, AC-12.x, AC-13.x, AC-16.x pass; load test results recorded.

### Phase 5 — Deployment, documentation, delivery (Weeks 11–12)
- Deploy to the chosen target (single VM by default), TLS, backups with one tested restore (AC-17.2), scalability/DR write-up (feature 17, documentation only).
- README, API docs, user guide, final report, demo script rehearsal.
- Week 12 is mostly a **buffer** for defect fixing and rehearsal; no new features.
- **Milestone M5 (end of Week 12):** delivered system, documentation and demo.
- **Exit criteria:** AC-15.x, AC-18.x pass; every feature in `feature-status.md` is at its target status.

## Milestone summary

| Milestone | Week | Demonstrable outcome |
|---|---|---|
| M0 | 1 | Stack, CI and contracts ready; decisions recorded |
| M1 | 3 | Login, draft events, worker email, calendar admin |
| M2 | 5 | Approval chain + guarded, conflict-free booking |
| M3 | 8 | Full lifecycle incl. gate pass, certificate, report PDF |
| M4 | 10 | R1 feature-complete, hardened, observable |
| M5 | 12 | Deployed, documented, demo-ready |

## Scope control

**First release (must):** features 1–8, 10, 11, 13, 14, 15, 18, 19, 20.
**First release (reduced):** 9 (basic budget + simple analytics), 12 (rule-based), 16 (metrics + one dashboard).
**Not built:** 17 (design/DR note and one tested restore only).

**Cut list if the schedule slips** (in this order): waitlist; CSV analytics exports beyond one; allocation suggestions in feature 12; equipment return tracking; Playwright coverage beyond the 3 main journeys; second Grafana dashboard. Features 4, 6, 19 and 20 are not cut.

## Risks to the schedule

| Risk | Likelihood | Mitigation |
|---|---|---|
| Decisions D-01..D-05 slip past Week 1 | Medium | Defaults in `decisions.md` take effect at end of Week 1 unless the team objects |
| Interface mismatch between developers | High | Freeze I-1..I-12 in Phase 0; frontend works against the OpenAPI contract and mocks |
| PDF design churn (feature 19) | Medium | Fix template with U-7 by Week 5; ship a simple layout first |
| Underestimated frontend effort | High | Dev D starts Week 1; keep UI plain; reuse a component library |
| Concurrency bugs found late | Medium | Concurrency tests written at the same time as the feature, not at the end |
| Team availability (exams, holidays) | Medium | Check the college calendar in Week 1; adjust buffer |
| Environment issues (Docker is not installed on the current dev machine) | Medium | Install Docker in Week 1; CI uses service containers |

## Working agreements
- Branch per feature, PR with tests and a link to the requirement id; one reviewer minimum.
- Definition of done in `CLAUDE.md` applies to each PR.
- Update `feature-status.md` in the same PR that changes a feature's state, with evidence (test names, PR numbers).
- Weekly 30-minute integration check against the milestone for that week.
