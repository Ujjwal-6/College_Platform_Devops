# Event contract

For: hall and resource booking (Member 2), registration and attendance (Member 3), reports and certificates (later). This document describes what **is implemented** in the events, approvals and calendar modules. Items marked **Proposal** are suggestions for another feature owner; they are not implemented and not decided.

Code entry point: `apps/api/src/modules/events/index.ts`. Rules and decisions behind it: `docs/decisions.md` (U-3, U-5, U-16–U-18, D-16).

## 1. Identity and ownership

| Field                 | Meaning                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `events.id`           | UUID. Reference it with a foreign key from your own tables.                                |
| `department_id`       | The owning department (FK `departments`). Decides which faculty/HOD approve and who sees the event. |
| `organizer_id`        | The creating user (FK `users`). Only the organizer edits, submits, withdraws and revises.  |
| `status`, `approval_level` | Lifecycle state (section 3). `approval_level` is set **if and only if** `status = 'pending_approval'` (database constraint). |
| `submission_round`    | Counts submissions. Approval decisions belong to one round.                                |

Event rows are never deleted; cancelling is a state. Use `ON DELETE RESTRICT` (the default) on references to `events`.

## 2. Dates, times and time zones

- Stored as `timestamptz` (UTC): `start_at`, `end_at`, `registration_deadline`. `end_at > start_at` is a database constraint.
- The API accepts only ISO-8601 instants **with an explicit offset** (e.g. `2031-03-01T10:00:00+05:30`) and returns UTC (`...Z`).
- The college time zone is `APP_TIMEZONE` (default `Asia/Kolkata`, assumption ASM-2). The web app shows and accepts India time; academic-calendar dates are whole local days in this zone.
- **Convention for all time ranges: half-open `[start, end)`.** Back-to-back bookings (one ends when the next starts) must be allowed. Use the same convention for hall bookings.
- A past `start_at` can be saved on a draft but cannot be submitted or published.

## 3. Lifecycle

```
draft ──submit──▶ pending_approval ──(faculty → hod → admin)──▶ approved ──publish──▶ published ──close──▶ closed
  ▲                  │      │                                      │  ▲                     │
  │                  │      └──────────────── cancel ──────────────┼──┼─────────▶ cancelled │
  ├── withdraw ──────┘                                              │  └── unpublish ────────┘
  ├── reject (any level; the event returns to draft with the comment)
  └── revise (from approved or published)
```

| Action      | From                                             | To                 | Who                         | Notes                                                                 |
| ----------- | ------------------------------------------------ | ------------------ | --------------------------- | --------------------------------------------------------------------- |
| `submit`    | draft                                            | pending_approval   | organizer                   | Starts a new round at the faculty level. Calendar and approver checks apply (section 6). |
| `approve`   | pending_approval                                 | next level / approved | person of that level      | The admin approval moves the event to `approved`.                     |
| `reject`    | pending_approval                                 | draft              | person of the current level | Comment required. The next submission starts a new round at faculty.  |
| `withdraw`  | pending_approval                                 | draft              | organizer                   |                                                                       |
| `publish`   | approved                                         | published          | organizer or admin          | Start must be in the future.                                          |
| `unpublish` | published                                        | approved           | organizer or admin          |                                                                       |
| `revise`    | approved, published                              | draft              | organizer                   | The way to change material fields. Needs approval again.              |
| `cancel`    | draft, pending_approval, approved, published     | cancelled          | organizer or admin          | Reason required. Terminal.                                            |
| `close`     | published                                        | closed             | organizer or admin          | Only after `end_at`. Closing twice is a no-op. Terminal. Triggers (future) report generation. |

There is no stored `rejected` state: a rejected event is a `draft` whose `last_rejection_*` columns describe the rejection. The first-submission and "rejected" paths therefore use the same editing and resubmission flow.

## 4. Approval, publication and hall booking are different things

| Concept          | Meaning                                                                                     | Where                          |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------ |
| **Approved**     | Faculty, HOD and Admin all agreed the event may happen.                                     | `status = approved` (events/approvals) |
| **Published**    | The event is visible to every signed-in user and, until the deadline, open for registration. | `status = published`           |
| **Hall booked**  | A specific hall is reserved for a time range. Independent of the two above.                 | Member 2 (`bookings`)          |

An event does not need a booking to be approved or published.

**Implemented by Member 2** (`docs/booking-design.md`): a booking can be requested while the event is `draft`, `pending_approval`, `approved` or `published`, and before it starts. A booking has **its own two-step approval** (faculty, then HOD or admin) and is confirmed by that, independently of the event's approval. When the event is cancelled its bookings are cancelled; when it is revised (back to draft) bookings stay, and resource reservations are released.

## 5. Registration eligibility (for Member 3)

```ts
import { isEligibleForRegistration } from '../events/index.js';
isEligibleForRegistration(event, now); // true only if status === 'published' and now < (registration_deadline ?? start_at)
```

- Capacity, duplicate registration and team rules are the registration feature's responsibility. The event provides the configuration: `capacity` (null = unlimited; **defined here as a limit on people, not teams**), `registration_mode` (`individual` | `team`), `team_size_min`/`team_size_max` (2–50, only for team events), `registration_deadline` (null = the start time).
- `registration_mode`, team sizes and `capacity` are **material**: they cannot change while the event is approved or published without `revise`. Only `registration_deadline` can still be moved (earlier or later, never after the start).
- The `unpublish`, `revise` and `cancel` actions may be **vetoed** by a hook (for example, refuse to unpublish an event that already has registrations) and cancellation should notify registrants. Both belong in your hook.

## 6. What changes approval status

| Change                                                                          | Effect                                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Any edit while `draft`                                                          | None.                                                                  |
| Edit while `pending_approval`                                                   | Refused (409). Withdraw first.                                         |
| Non-material edit while `approved`/`published`: `title`, `description`, speakers, `registration_deadline` | Applied in place, audited. Approval stays.                              |
| Material edit while `approved`/`published`: `startAt`, `endAt`, `departmentId`, `category`, `capacity`, `expectedAttendance`, `registrationMode`, `teamSizeMin`, `teamSizeMax` | Refused (409 `MATERIAL_CHANGE_REQUIRES_REVISION`). Use `revise`, edit, submit again. |
| Edit while `closed`/`cancelled`                                                  | Refused (409).                                                         |

## 7. Hooks: reacting to lifecycle changes

```ts
import { registerEventHook } from '../events/index.js';

registerEventHook(async (tx, { event, previousStatus, action, actorId }) => {
  if (action === 'cancel') await releaseBookings(tx, event.id); // runs in the same transaction
});
```

- Called after every lifecycle action (`submit`, `approve`, `reject`, `withdraw`, `publish`, `unpublish`, `revise`, `cancel`, `close`) with the event **after** the change.
- Runs inside the action's database transaction. If a hook throws, the whole action rolls back. Throw an `AppError` (409/422) to veto with a clear message.
- Use the `tx` you are given for all queries; do not open another connection.
- Registration point: call your `registerXHooks()` from `createApp` in `apps/api/src/app.ts` (a new line per feature). Hooks do not run in the worker process.
- Tests: `registerEventHook` returns an unregister function.

## 8. Academic calendar (advisory)

- Table `calendar_entries` (migration `012`): `type`, `title`, inclusive `start_date`/`end_date` (local dates), `severity` (`block` = *restricted period*, `warn` = *notice*), optional `department_id` (null = all), `is_active`.
- Function `checkRange(db, timezone, { startAt, endAt, departmentId })` → `{ blocks, warnings }`. **Both lists are suggestions.** Nothing in the platform refuses an action because of the calendar (decision of 2026-10-23, supersedes the earlier hard block).
- **Events:** on submission every overlapping entry is stored on the event (`calendar_warnings`, each with its `severity`) and shown to approvers. Drafts show the live result to the owner.
- **Hall bookings:** overlaps are returned as `CALENDAR` warnings that the organizer acknowledges ("Book anyway"); they are stored on the booking for the approvers.
- Changing the calendar never changes existing events or bookings; the admin gets a list of overlapping events (`GET /api/calendar/entries/:id/conflicts`, also returned when creating or editing an entry).

## 9. API summary

| Method and path                                                     | Who                                              |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /api/events?scope=published\|mine\|department\|approvals`      | any user (`department` and `approvals`: faculty/HOD/admin) |
| `POST /api/events`                                                  | organizer, faculty, HOD, admin                   |
| `GET /api/events/:id`                                               | anyone who may view it (else 404)                |
| `PATCH /api/events/:id`                                             | organizer (owner)                                |
| `POST /api/events/:id/{submit,withdraw,revise}`                     | owner                                            |
| `POST /api/events/:id/{publish,unpublish,close}` and `/cancel`      | owner or admin                                   |
| `POST /api/events/:id/{approve,reject}` with `{ level, comment? }`  | the approver of the event's current level        |
| `GET /api/calendar/entries`, `GET /api/calendar/check`              | any signed-in user                               |
| `POST/PATCH/DELETE /api/calendar/entries`, `GET .../:id/conflicts`  | admin                                            |

`level` in a decision is the level the user was looking at; a mismatch means the screen is stale and the answer is 409 `STALE_DECISION`.

**Visibility:** admin sees everything; the owner sees their events; faculty/HOD see non-draft events of their department; everyone sees `published` and `closed`. Anything else is a 404. Approval history, comments and calendar details are shown only to the owner, admins and the department's faculty/HOD.

## 10. Audit and notifications

- Audit actions: `event.created`, `event.updated`, `event.submitted`, `event.withdrawn`, `event.approval_granted` (metadata `level`, `final`), `event.approval_rejected`, `event.published`, `event.unpublished`, `event.revised`, `event.cancelled`, `event.closed`, `calendar.entry_created|updated|deleted`. Add your own to `AUDIT_ACTIONS` (`modules/audit/audit.ts`).
- Emails (templates in `modules/notifications/templates.ts`): `event.approval_requested` (to everyone who can decide the current level), `event.decision` (to the organizer), `event.cancelled` (to the organizer when an admin cancels). Jobs use stable keys, so a repeated step never sends twice.
- `event_history` is a user-facing timeline; `audit_log` remains the admin-only record.

## 11. Migration ranges

Used: `010_events`, `011_event_approvals`, `012_calendar` (Member 1); `020_halls_resources`, `021_hall_bookings`, `022_resource_reservations` (Member 2). Member 1 reserves `010–019`. Proposed (D-16): Member 2 `020–029`, Member 3 `030–039`. The migration runner refuses a file that sorts before one already applied locally, so after pulling a lower-numbered migration, rebuild your local database (`npm run migrate -- down <n>` then `npm run migrate`).

## 12. Test helpers you can reuse

`apps/api/test/helpers.ts`: `buildTestApp`, `resetDb`, `buildOrg` (two departments with organizer, faculty ×2, HOD ×2, admin ×2, cross-department staff and a student, all signed in), `createDraft`, `approveFully`, `as(t, session)`, `futureRange`, `istDate`, `eventBody`. Add your tables to the `TRUNCATE` list in `resetDb` unless they reference `users` or `departments`.

## 13. Not covered here (explicitly out of scope of the events feature)

Hall and equipment booking and release on cancellation (Member 2), registrations, waitlists, notifying registrants, attendance, certificates, and the automatic post-event report (Member 3 and later). Automatic closing of events after their end time is not implemented: `close` is an explicit action.
