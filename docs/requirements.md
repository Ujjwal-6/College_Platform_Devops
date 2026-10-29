# Requirements: College Event Operations Platform

## How to read this document

Every requirement carries a source tag. Do not treat anything without **[P]** or **[N]** as mandatory until approved.

| Tag | Meaning |
|---|---|
| **[P]** | Confirmed in the project presentation (feature groups 1–18 and the technology direction) |
| **[N]** | Newly approved addition (feature groups 19 and 20) |
| **[R]** | Recommendation by the engineering assistant; needs team approval |
| **[F]** | Future scope; design/documentation only, not built in the first release |
| **ASM-n** | Explicit assumption (listed at the end); change it if wrong |

Release labels: **R1** = first release, **R1-lite** = first release with reduced scope, **Future** = not built.
Open policy gaps are marked **Unresolved (U-n)** and tracked in `docs/decisions.md`. They must not be guessed during coding.

Related documents: `architecture.md`, `decisions.md`, `implementation-roadmap.md`, `testing-strategy.md`, `feature-status.md`.

## Roles (ASM-1)

`student`, `organizer` (a student or staff member who creates events), `faculty` (first-level approver), `hod` (department approver), `admin`. A user may hold more than one role. Authorization is always role **and** scope (own events, own department).

## Global rules (apply to every feature)

- G1 **[P]** RBAC is enforced in the backend on every route; the frontend only hides UI.
- G2 **[P]** State-changing actions write an audit record (see feature 11).
- G3 **[R]** All timestamps are stored in UTC and displayed in one configured college time zone (default `Asia/Kolkata`, ASM-2).
- G4 **[R]** Every list endpoint is paginated; every error uses one JSON error format with a stable `code`.
- G5 **[R]** Retryable mutations (registration, booking) accept an `Idempotency-Key` header.

---

## 1. Authentication and user management — R1 [P]

**Functional requirements**
- FR-1.1 Login with email + password; short-lived access JWT plus rotating, revocable refresh token. [P: JWT] [R: rotation details]
- FR-1.2 User creation/onboarding. **Unresolved U-1** (self-registration with admin approval vs. college email/SSO).
- FR-1.3 Admin manages users: create, deactivate, assign roles and department.
- FR-1.4 Password reset by emailed single-use expiring link. [R]
- FR-1.5 Logout revokes the refresh token. [R]

**Workflow:** login → access token (≈15 min) + refresh cookie → refresh rotates the token → reuse of an old refresh token revokes the whole token family.

**Edge cases:** deactivated user holds a valid access token (rejected on next refresh, and sensitive routes re-check status); role changed mid-session (takes effect at next token refresh at the latest); brute-force login attempts (rate limit + lockout/backoff); email case-sensitivity (store lower-cased, unique).

**Acceptance criteria**
- AC-1.1 Unauthenticated request to a protected route → 401. Authenticated user with the wrong role → 403.
- AC-1.2 A refresh token used twice causes the second use to fail and the token family to be revoked.
- AC-1.3 Passwords are never stored or logged in plain text.
- AC-1.4 More than the configured failed logins per window → 429.
- AC-1.5 Deactivated user cannot refresh a session.

## 2. Event creation and management — R1 [P]

> **As built (2026-10-23):** states are `draft`, `pending_approval`, `approved`, `published`, `closed`, `cancelled` (no stored `rejected`; a rejected event returns to `draft`). Full contract: `docs/event-contract.md`.

**Functional requirements**
- FR-2.1 Organizer creates a draft event: title, description, category, schedule, expected attendance, department, budget estimate, speakers, individual/team mode, team-size limits, capacity.
- FR-2.2 Event states: `draft → pending_approval → approved → live → closed`, plus `rejected` and `cancelled`. Transitions are validated server-side in one state machine. [R: exact state names]
- FR-2.3 Only the owner (or admin) may edit a draft; edits after approval re-trigger approval or are restricted. **Unresolved U-5.**
- FR-2.4 Cancellation releases hall bookings and equipment reservations and notifies registrants.
- FR-2.5 Event closure is an explicit action (by organizer/admin) or an automatic transition after the end time. The close transition triggers feature 19. [N]

**Edge cases:** end before start; event in the past; editing while approval is in progress; cancelling an event that has registrants; closing an event twice (idempotent).

**Acceptance criteria**
- AC-2.1 Invalid transitions (e.g. `draft → closed`) are rejected with 409/422 and leave the state unchanged.
- AC-2.2 A non-owner organizer receives 403 when editing another organizer's event.
- AC-2.3 Cancelling an event releases its booking and equipment in the same transaction.

## 3. Individual and team registration with invitation codes — R1 [P]

**Functional requirements**
- FR-3.1 Individual registration while the event is open and capacity remains.
- FR-3.2 Team registration: a leader creates a team and receives an invitation code; members join using the code. Team size limits are enforced.
- FR-3.3 Invitation codes are random (≥ 64 bits of entropy), expiring, and revocable; single-use vs. multi-use per team is **Unresolved U-9**. [R: random, expiring]
- FR-3.4 A user may register once per event (unique constraint).
- FR-3.5 Cancelling a registration frees capacity.
- FR-3.6 Optional waitlist. [R, off by default, R1 only if time allows]

**Edge cases:** concurrent last-seat registration; same user joining two teams for one event; team falls below the minimum size before close of registration; registration after the deadline; leader leaves the team.

**Acceptance criteria**
- AC-3.1 With capacity 10 and 50 parallel registration requests, exactly 10 succeed and 40 get a clear "full" response (409).
- AC-3.2 A second registration by the same user for the same event is rejected by a DB unique constraint.
- AC-3.3 An expired or wrong invitation code is rejected without revealing whether the code exists.
- AC-3.4 A team cannot exceed the maximum size under concurrent joins.
- AC-3.5 Repeating a request with the same `Idempotency-Key` returns the original result and creates one registration.

> **As built (2026-10-27):** individual and team registration, invitation codes (random, hashed, expiring, revocable, reusable until the team is full), cancellation that frees the seat, `Idempotency-Key`, rate limits, event-cancel integration. AC-3.1 to AC-3.5 are implemented and tested (`registrations.test.ts`, `registration-concurrency.test.ts`). FR-3.6 (waitlist) is built for individual events (first come first served, automatic promotion, W-1 to W-6). Many rules were assumed while the product owner was away and most are now confirmed: `docs/decisions.md` section 10; design and limits: `docs/registration-design.md`.

## 4. Hall booking, availability, conflict detection, concurrency safety — R1 [P]

> **As built (2026-10-23):** halls, availability search, booking with its own Faculty → (HOD or Admin) approval, warnings the organizer acknowledges (capacity, facilities, calendar, event time), database-enforced no-overlap (exclusion constraint), automatic cancellation with the event. FR-4.5 is met as an advisory warning; AC-4.5 ("a failed calendar guard creates no booking") is replaced by "calendar overlaps need acknowledgement". Details and limits: `docs/booking-design.md`.

**Functional requirements**
- FR-4.1 Hall catalogue: name, capacity, location, features, active flag (admin-managed).
- FR-4.2 Availability query by hall and date range.
- FR-4.3 Booking request for a time range tied to an event; statuses `pending`, `confirmed`, `cancelled`, `released`.
- FR-4.4 No two active bookings for the same hall may overlap. The database enforces this; application checks are only hints. [P: concurrency safety] [R: mechanism]
- FR-4.5 Booking passes the academic calendar guard (feature 20) before being accepted.
- FR-4.6 Hall capacity is compared with expected attendance; a mismatch produces a warning (blocking is a policy choice, **Unresolved U-10**).
- FR-4.7 Buffer time between bookings (setup/teardown). **Unresolved U-11**, default 0 minutes.

**Workflow:** organizer picks hall + slot → availability pre-check (hint) → calendar guard → insert booking inside a transaction → DB rejects overlap → API returns 201 or 409 with alternative slots (best effort).

**Edge cases:** back-to-back bookings (end of one equals start of next, which must be allowed: half-open ranges); bookings that span midnight; time zone/DST input; two organizers submitting the same slot at the same millisecond; booking for an event later rejected or cancelled (booking must be released).

**Acceptance criteria**
- AC-4.1 With 50 parallel requests for the same hall and slot, exactly 1 succeeds and 49 receive 409. Zero overlapping rows exist afterwards.
- AC-4.2 Adjacent slots (10:00–12:00 and 12:00–14:00) are both accepted.
- AC-4.3 Overlap is rejected even when inserted by a path that skips the service-layer check (verified by a direct-SQL test).
- AC-4.4 Cancelling a booking makes the slot bookable again.
- AC-4.5 A booking request that fails the calendar guard creates no booking row.

## 5. Equipment and resource management — R1 [P]

> **As built (2026-10-23):** resource catalogue, quantity-aware reservations for approved events, peak-usage allocation under a row lock, release on event cancel/revise. FR-5.5 (condition tracking) is limited to a status (available / maintenance / retired). Details: `docs/booking-design.md`.

**Functional requirements**
- FR-5.1 Equipment catalogue with total quantity; admin-managed.
- FR-5.2 Per-event reservation for a time window and quantity.
- FR-5.3 Reserved quantity for any overlapping window never exceeds stock.
- FR-5.4 Reservations are released on cancellation or closure.
- FR-5.5 Return/condition tracking after the event. [R: R1-lite, status flag only]

**Edge cases:** partial overlaps of windows that together exceed stock; equipment taken out of service; reservation for an event that gets cancelled.

**Acceptance criteria**
- AC-5.1 With stock 5, concurrent requests for 3 + 3 over overlapping windows: exactly one succeeds.
- AC-5.2 Non-overlapping windows may each reserve the full stock.
- AC-5.3 Cancelling an event frees all its reservations.

## 6. Multi-level approvals: Organizer → Faculty → HOD → Admin — R1 [P]

> **As built (2026-10-23):** rejection returns the event to draft and resubmission starts a new round at Faculty (U-5); always three levels in order (U-4); one person per level per round (U-16); Faculty = any active faculty of the event's department (U-17).

**Functional requirements**
- FR-6.1 Submitting an event creates an approval request that goes to Faculty, then HOD, then Admin, in that order. [P]
- FR-6.2 Each level can approve or reject, with a mandatory comment on rejection.
- FR-6.3 Approvers see only requests within their scope (faculty assigned to the event/department, HOD of the department). [R]
- FR-6.4 Rejection behaviour (final vs. return to organizer for edit/resubmit) **Unresolved U-5**. Default if unanswered: rejection returns the event to `draft` with the comment visible.
- FR-6.5 Whether every event needs all four levels, or the chain varies by type/budget, is **Unresolved U-4**. Default: always four.
- FR-6.6 Full approval history is retained and audited.

**Edge cases:** approver is the organizer (self-approval forbidden); approver acts twice (idempotent); approver role revoked while a request is pending; request already decided at the same level by someone else (concurrent decision); no faculty or HOD configured for the department (request blocked, admin alerted).

**Acceptance criteria**
- AC-6.1 HOD cannot approve before Faculty has approved (409/403).
- AC-6.2 A user cannot approve their own event.
- AC-6.3 Two concurrent decisions on the same step: one succeeds, one fails; the history has a single decision.
- AC-6.4 Final admin approval moves the event to `approved` and confirms its pending booking in one transaction.
- AC-6.5 Every decision creates an audit record with actor, decision, comment and time.

## 7. QR check-in, attendance, PDF gate passes — R1 [P]

**Functional requirements**
- FR-7.1 Each confirmed registration gets a signed QR code payload (HMAC-signed, includes registration id and event id, with expiry). [R: mechanism]
- FR-7.2 A volunteer/organizer scans it; the server verifies the signature and records attendance exactly once.
- FR-7.3 Gate pass PDF generated asynchronously and downloadable by the registrant (and emailed).
- FR-7.4 Manual check-in fallback for organizers with a reason logged.
- FR-7.5 Live attendance count per event.

**Edge cases:** the same QR scanned twice (second response says "already checked in" with time); QR for another event; QR for a cancelled registration; scanner offline (out of R1 scope; manual fallback only); screenshot shared with someone else (one-time use limits damage).

**Acceptance criteria**
- AC-7.1 A tampered QR payload is rejected (400/403).
- AC-7.2 Two simultaneous scans of one QR create exactly one attendance row.
- AC-7.3 A QR from event A is rejected at event B.
- AC-7.4 A user without the volunteer/organizer scope for the event cannot perform check-in (403).
- AC-7.5 The gate pass PDF contains event name, date, venue, holder name and QR code and is generated by the worker, not the request thread.

## 8. Certificates and post-event feedback — R1 [P]

**Functional requirements**
- FR-8.1 Feedback form per event (ratings + comments), only for checked-in attendees. Anonymity and form fields **Unresolved U-12**.
- FR-8.2 Certificates are generated asynchronously for eligible attendees. Eligibility rule **Unresolved U-6** (default: checked in).
- FR-8.3 One certificate per attendee per event, with a verification code/URL. [R]
- FR-8.4 Certificate delivery by email and in-app download.

**Edge cases:** attendee checked in but did not submit feedback (certificate not blocked unless U-6 says so); certificate regeneration after a name correction; mass generation for hundreds of attendees.

**Acceptance criteria**
- AC-8.1 A retried or re-run certificate job produces no duplicate certificate (unique constraint on event + user).
- AC-8.2 A user who did not attend gets no certificate.
- AC-8.3 A user can submit feedback only once per event.
- AC-8.4 Certificate verification returns valid for a genuine code and not found for a random code.

## 9. Budget tracking, event analytics, reports — R1-lite [P]

**Functional requirements**
- FR-9.1 Budget estimate and actual expenses per event (line items with category and amount). [P]
- FR-9.2 Analytics: registrations over time, attendance rate, hall utilization, feedback averages. [P]
- FR-9.3 Admin/department summary reports, exportable as CSV. [R: CSV; PDF only for feature 19]

**Edge cases:** actuals above budget (flag, not block); currency/rounding (store integer minor units, ASM-3); edits after event closure (audited).

**Acceptance criteria**
- AC-9.1 Totals equal the sum of line items (no float rounding errors).
- AC-9.2 An organizer cannot see another organizer's budget (403).
- AC-9.3 Attendance rate = checked-in / confirmed registrations, verified against fixture data.

## 10. Email notifications and background job processing — R1 [P]

**Functional requirements**
- FR-10.1 Notifications: approval requested, decision made, registration confirmed, reminder, certificate ready, report ready, job failure alert.
- FR-10.2 All email, PDF and report work runs in a worker via a queue, never in the request path.
- FR-10.3 Retry with exponential backoff, bounded attempts, then a failed/dead-letter state visible to admins.
- FR-10.4 Jobs are idempotent (deterministic job id + unique business constraint).
- FR-10.5 Queue technology **OPEN (D-02/D-03)**.

**Acceptance criteria**
- AC-10.1 When the mail server is down, the job retries the configured number of times with increasing delay, then lands in the failed state and a metric/log shows it.
- AC-10.2 Delivering the same job twice results in one email.
- AC-10.3 A job enqueued for a transaction that rolled back never runs.
- AC-10.4 The API responds without waiting for the email to be sent.

## 11. Audit trails and administrative management — R1 [P]

**Functional requirements**
- FR-11.1 Append-only audit log: actor, action, target type/id, time, request id, IP, before/after summary.
- FR-11.2 Audited actions: login/failed login, role/user changes, event transitions, approvals, bookings and cancellations, check-ins, calendar changes, budget edits, report generation.
- FR-11.3 Admin can search and filter the log; no UI or API can edit or delete rows.
- FR-11.4 Admin screens for users, halls, equipment and academic calendar.

**Acceptance criteria**
- AC-11.1 Each audited action creates exactly one record.
- AC-11.2 The application DB user lacks UPDATE/DELETE on the audit table.
- AC-11.3 Non-admins receive 403 on audit endpoints.

## 12. Event risk/health scoring, conflict prediction, intelligent allocation — R1-lite [P]

**Functional requirements**
- FR-12.1 Rule-based risk score (0–100) from weighted checks, e.g. approvals pending close to event date, hall capacity vs. expected attendance, equipment shortfall, calendar warnings, budget overrun, low registration rate. [R: rules]
- FR-12.2 Conflict "prediction" = detecting upcoming clashes (hall, equipment, calendar) before submission and suggesting alternatives. [R: rule-based]
- FR-12.3 Allocation suggestion = ranked list of free halls that fit the capacity and avoid calendar warnings. [R]
- FR-12.4 Predictive machine learning is **[F]**.

**Acceptance criteria**
- AC-12.1 The score is deterministic: same inputs → same score; each contributing rule is shown to the user.
- AC-12.2 A fixture event with a known set of problems scores within the documented band.
- AC-12.3 Suggested halls never include an overlapping booking or a restricted date.

## 13. Security, concurrency, reliability — R1 [P]

Standing rules live in `CLAUDE.md`. Testable items:
- AC-13.1 Every route has an automated authorization test (allowed, wrong role, wrong scope, unauthenticated).
- AC-13.2 All inputs are schema-validated; unknown fields rejected.
- AC-13.3 Login, registration and invitation-code endpoints are rate-limited.
- AC-13.4 No secret is present in the repository (secret scan in CI). [R]
- AC-13.5 Dependency audit runs in CI. [R]
- AC-13.6 Concurrency tests exist for booking, capacity, equipment and check-in (see `testing-strategy.md`).

## 14. Frontend, REST APIs, database integration — R1 [P]

- FR-14.1 React single-page app consuming a documented REST API (OpenAPI spec kept in the repo). [P: React, REST] [R: OpenAPI]
- FR-14.2 Role-aware navigation; forms with client-side and server-side validation; loading, empty and error states.
- FR-14.3 Database access only through repositories; versioned migrations.
- AC-14.1 The OpenAPI spec validates, and contract tests confirm responses match it. [R]
- AC-14.2 Main flows work on mobile screen widths (responsive). [R]

## 15. Git, Docker, CI/CD — R1 [P]

- FR-15.1 GitHub repository with protected `main`, PR reviews. [P: Git/GitHub]
- FR-15.2 Dockerfiles for API, worker and web; Docker Compose for the local stack. [P]
- FR-15.3 GitHub Actions: lint, tests, build, image build on every PR. [P]
- AC-15.1 A fresh clone runs the stack with one documented command.
- AC-15.2 A PR with a failing test cannot be merged.
- Continuous deployment to a cloud environment is **[R]**, dependent on the cloud decision (D-07).

## 16. Monitoring and observability — R1-lite [P]

- FR-16.1 `/metrics` endpoint on API and worker (request rate, latency, errors, queue depth, failed jobs). [P: Prometheus/Grafana planned]
- FR-16.2 Structured JSON logs with a correlation id per request/job. [R]
- FR-16.3 At least one Grafana dashboard and one alert rule. [R]
- FR-16.4 Where Prometheus/Grafana are deployed **OPEN (D-06)**.
- AC-16.1 The dashboard shows live request rate and failed-job count in the demo environment.
- AC-16.2 A health endpoint reports DB and queue connectivity.

## 17. Future scalability — Future [P, design only]

Load balancing, microservices, Kubernetes, cloud scaling and disaster recovery. R1 delivers a written scalability and DR note only (stateless API, externalised state, backup/restore procedure that is actually tested). Nothing here is implemented without explicit approval. **[F]**

- AC-17.1 A document describes bottlenecks, the scaling path, and a backup/restore runbook.
- AC-17.2 One database restore from backup is performed and recorded.

## 18. Testing, documentation, deployment, project delivery — R1 [P]

- FR-18.1 Test strategy per `testing-strategy.md`; CI-enforced.
- FR-18.2 README (setup, run, test), API docs, architecture docs, user guide, deployment guide, final report and demo.
- AC-18.1 A teammate who did not write the code can set up and run the project from the README.
- AC-18.2 The demo script exercises the full lifecycle: create → approve → book → register → check in → certificate → report.

## 19. Automatic post-event report generation — R1 [N]

**Functional requirements**
- FR-19.1 When an event transitions to `closed`, a report job is enqueued automatically (after the transaction commits or via an outbox).
- FR-19.2 The worker compiles into one formatted PDF: event details, speaker information, attendance (registered vs. checked in, rate), photographs, outcomes, and available feedback summary (averages and selected comments).
- FR-19.3 Photographs are uploaded by the organizer (type/size limited) before or after closure; the report includes those present at generation time.
- FR-19.4 Missing inputs do not fail the job: the report states "not provided" per section.
- FR-19.5 One current report per event; regeneration (e.g. after late photos) creates a new version and keeps the old.
- FR-19.6 The organizer and admin are notified when the report is ready or has failed; the report is downloadable by authorized roles only.
- FR-19.7 Report template/layout, outcome fields and photo limits are **Unresolved U-7**; default is a simple internal layout.

**Workflow:** organizer closes event → state `closed` + report job enqueued → worker gathers data → renders PDF → stores file + DB record → notification → download.

**Edge cases:** event closed twice; zero attendees; no feedback; no photos; very large or corrupt photo; worker crash mid-render; event reopened after closure (**Unresolved U-7**: default: reopening is not permitted; regeneration is a separate action); special characters or very long text in the PDF; PDF storage failure.

**Acceptance tests**
- AT-19.1 *Given* an approved event with speakers, 10 registrations and 8 check-ins, *when* it is closed, *then* exactly one report job is enqueued and a PDF is stored; the PDF shows 10 registered, 8 attended and an 80% attendance rate.
- AT-19.2 *Given* an event with no photos and no feedback, *when* it is closed, *then* the report is still generated with "no photographs provided" and "no feedback received" sections.
- AT-19.3 *Given* a closed event, *when* the close action is invoked twice (or the job is delivered twice), *then* only one report version exists for that close.
- AT-19.4 *Given* the PDF renderer fails the first two times, *when* the job runs, *then* it is retried with backoff and succeeds on the third attempt; after the maximum attempts it is marked failed, a metric increments, and the organizer/admin are alerted.
- AT-19.5 *Given* a transaction that closes the event is rolled back, *then* no report job exists.
- AT-19.6 *Given* a user without access to the event, *when* they request the report, *then* they get 403.
- AT-19.7 *Given* an event title containing HTML/script characters and very long text, *then* the PDF renders it as inert text without breaking the layout.
- AT-19.8 *Given* late-uploaded photos, *when* an authorized user triggers regeneration, *then* version 2 includes them and version 1 is retained.
- AT-19.9 Closing the event returns before the PDF exists (the request is not blocked by generation).

## 20. Academic calendar guard — R1 [N]

> **As built (2026-10-23, revised):** the calendar is **advisory everywhere**. Event submission and hall bookings show overlapping entries as suggestions and record them for approvers; nothing is refused (U-3 revised). Acceptance tests AT-20.1–20.9 are implemented for event submission in `apps/api/test/calendar.test.ts` with that meaning (the entry is recorded, the submission succeeds). AT-20.10 (parallel bookings on a blocked date) no longer applies: bookings on restricted dates are allowed after acknowledgement. Hall-scoped entries were not built.

**Functional requirements**
- FR-20.1 Admins create, edit, deactivate and delete calendar entries: type (`exam_period`, `holiday`, `major_fest`, `academic_date`, other configurable), title, date range, optional scope (all halls / specific halls / specific departments), and a severity of `block` or `warn`.
- FR-20.2 Booking validation checks the requested range against active entries. A `block` entry rejects the booking. A `warn` entry accepts it but returns the warning, which is stored with the booking and shown to approvers.
- FR-20.3 Which entry types default to `block` vs. `warn` is configured per entry by the admin (so the policy is data, not code). The defaults and any admin-override-of-a-block are **Unresolved U-3**; default if unanswered: exam periods and holidays = `block`, major fests = `warn`, no override.
- FR-20.4 Calendar changes are audited. Adding a `block` entry over existing confirmed bookings does not delete them; it produces a conflict report for admins. [R]
- FR-20.5 The guard is a shared service used by booking (feature 4) and the allocation suggestions (feature 12).

**Edge cases:** booking partly overlapping an entry; multi-day entry; booking spanning two entries (one block, one warn → block wins); scoped entry that does not apply to the requested hall/department; entries edited after bookings exist; time zone boundaries at midnight; deactivated entry ignored.

**Acceptance tests** *(original wording. Superseded in part: the calendar is now advisory, see the as-built note above; where a test says "422" or "no booking row", the implemented behaviour is "the overlap is recorded / shown as a warning and the action succeeds")*
- AT-20.1 *Given* a `block` entry for 10–15 Nov (exam period), *when* an organizer books a hall on 12 Nov, *then* the API returns 422 with the entry's title and no booking row is created.
- AT-20.2 *Given* a `warn` entry for a fest on 20 Nov, *when* a booking is made on 20 Nov, *then* the booking is created and the response includes the warning; the warning is visible to approvers.
- AT-20.3 *Given* a booking range overlapping both a `warn` and a `block` entry, *then* the booking is rejected and both entries are reported.
- AT-20.4 *Given* a booking that ends exactly when a block entry starts (half-open ranges), *then* it is accepted.
- AT-20.5 *Given* a block entry scoped to Hall A only, *when* Hall B is booked on those dates, *then* it is accepted.
- AT-20.6 *Given* an admin deactivates the block entry, *then* the same booking now succeeds.
- AT-20.7 *Given* a non-admin user, *when* they try to create/edit/delete a calendar entry, *then* they get 403.
- AT-20.8 *Given* a block entry added over an existing confirmed booking, *then* the booking stays intact and the admin conflict report lists it.
- AT-20.9 Every calendar create/update/delete creates an audit record.
- AT-20.10 Parallel booking requests on a restricted date all fail; none slips through (guard check and booking insert occur in the same transaction).

---

## Explicit assumptions

| ID | Assumption |
|---|---|
| ASM-1 | The five roles listed above are sufficient; one user may hold several. |
| ASM-2 | Single college time zone, `Asia/Kolkata`. |
| ASM-3 | Money is stored as integer minor units in one currency (INR). |
| ASM-4 | A single institution and campus (no multi-tenancy). |
| ASM-5 | R1 UI is English only; email is the only notification channel (no SMS/push). |
| ASM-6 | Event photos are uploaded by organizers; no external photo source. |
| ASM-7 | Scale is college level (hundreds of concurrent users at peak), sized for a single-VM deployment. Needs confirmation (U-13). |
| ASM-8 | QR scanning uses a phone browser camera in the web app; no native app. |

## Unresolved policy items (details and defaults in `decisions.md`)

U-1 onboarding method · U-2 approver delegation · U-3 calendar block/warn defaults and admin override · U-4 approval chain per event type or budget · U-5 rejection and edit-after-approval behaviour · U-6 certificate eligibility · U-7 report template, photo limits, reopening · U-8 who may check people in · U-9 invitation-code reuse · U-10 hall-capacity mismatch: warn or block · U-11 buffer time between bookings · U-12 feedback fields and anonymity · U-13 scale target · U-14 data retention · U-15 team ownership.
