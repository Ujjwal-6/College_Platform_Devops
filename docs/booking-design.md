# Hall booking and resource management: design

Status: **implemented and tested** (see `docs/feature-status.md` for exactly what was run). Policy decisions are in `docs/decisions.md` section 9. How this feature plugs into events: `docs/event-contract.md`.

## 1. What exists

| Part                    | Where                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Halls (venues)          | `modules/halls`, table `halls` (migration `020`)                                            |
| Resources (equipment)   | `modules/resources`, tables `resources` (`020`) and `resource_reservations` (`022`)         |
| Hall bookings           | `modules/bookings`, tables `hall_bookings`, `booking_approvals`, `booking_history` (`021`)  |
| Event integration       | `modules/bookings/hooks.ts` (event lifecycle hooks), uses only `modules/events/index.ts`    |
| Academic calendar       | reuses `checkRange` from `modules/calendar`; advisory only                                  |
| Screens                 | Halls, Resources, Bookings, Booking form/detail, and a section on every event page          |

## 2. Hall booking lifecycle

```
            request                faculty approves          HOD or admin approves
(none) ────────────▶ pending ─────────────────────▶ pending ───────────────────────▶ confirmed
                  (step: faculty)                (step: hod_admin)
                       │                              │                                  │
                       ├── reject (either step) ──────┴──▶ rejected                      │
                       └── cancel (organizer / admin) ───────────────────────────────────┴──▶ cancelled
```

- **Pending and confirmed bookings hold the slot.** Rejected and cancelled ones do not.
- **Two approval steps:** a faculty member of the event's department, then the HOD of that department **or** any admin (either is enough). The booking requester and the event's organizer can never approve, and one person cannot decide both steps of the same request. At request time the booking is refused (409 `NO_APPROVER_AVAILABLE`) if these rules could never be satisfied.
- **Changing the hall or time** of a pending or confirmed booking sends it back to the first step with a new approval round (earlier decisions are kept in the history). Changing only notes does not.
- **Independent of the event's approval.** Confirming a booking does not approve or publish the event, and approving the event does not confirm a booking.
- **Before the event starts:** bookings can be requested, changed and approved only while the event has not started and is `draft`, `pending_approval`, `approved` or `published`.
- **Who:** the event's organizer or an admin requests, changes and cancels. Faculty/HOD of the department and admins see and decide. An admin cancelling someone else's booking must give a reason, and the organizer is emailed.
- **Idempotent requests:** repeating an identical request (same event, hall, time, person) returns the existing booking (200) instead of a conflict, including when the retry races with its own first attempt.

### Warnings the organizer can accept

These never refuse a booking. The first request returns 409 `WARNINGS_NEED_ACKNOWLEDGEMENT` with the list; nothing is stored. Sending the request again with `acknowledgeWarnings: true` books it, and the accepted warnings are stored and shown to the approvers.

| Code         | When                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| `CAPACITY`   | the event's expected attendance is more than the hall's capacity                  |
| `FACILITIES` | the booking asks for a facility the hall does not list                            |
| `CALENDAR`   | the time overlaps an academic-calendar entry (restricted period or notice)        |
| `EVENT_TIME` | the booking does not cover the whole event time                                   |

A **taken slot is different**: it is a hard 409 `HALL_UNAVAILABLE` (with who holds it) and cannot be acknowledged away. An **inactive hall** is a hard 409 `HALL_INACTIVE` for new bookings; existing bookings are not touched.

## 3. Preventing double bookings (halls)

**Rule:** two *active* bookings (pending or confirmed) of the same hall must never overlap in time. Ranges are half-open `[start, end)`, so a booking may begin exactly when the previous one ends.

**Mechanism:** a PostgreSQL exclusion constraint on the table itself (migration `021`):

```sql
CONSTRAINT hall_bookings_no_overlap EXCLUDE USING gist (
  hall_id WITH =,
  tstzrange(start_at, end_at, '[)') WITH &&
) WHERE (status IN ('pending', 'confirmed'))
```

- The `btree_gist` extension lets the plain `hall_id` column take part in the GiST index (PostgreSQL documents exactly this `room WITH =, during WITH &&` pattern). It is a *trusted* extension, so a non-superuser with `CREATE` on the database can install it (migration `020` does `CREATE EXTENSION IF NOT EXISTS btree_gist`).
- The check is made by the database for every `INSERT` and `UPDATE`, whoever sends it. If two transactions try to insert overlapping rows at the same moment, the second waits for the first to finish, then fails with SQLSTATE `23P01`. This does not depend on the isolation level, on application locks, or on the order of requests.
- The service maps `23P01` to 409 `HALL_UNAVAILABLE` with the conflicting bookings.
- An earlier "is the slot free?" query in the service exists **only to give a clear message** (and to report a taken slot before asking about warnings). It is not relied on: under READ COMMITTED each statement sees its own snapshot, so a read followed by an insert is not safe by itself (PostgreSQL transaction-isolation documentation).
- **Deadlocks:** two overlapping inserts can each wait for the other's uncommitted row; PostgreSQL detects this (after its one-second deadlock timeout) and aborts one with `40P01`. We saw this happen in testing. The first fix was to re-run the aborted request (up to 5 attempts, short random pause), as the PostgreSQL locking documentation recommends. **That was not enough under load:** with the machine's CPUs kept busy, 3 of 12 runs of the concurrency tests failed (identical simultaneous requests answered `409 TRY_AGAIN` instead of the existing booking, and one run timed out at 90 seconds). So writing a booking (creating one, or moving one to another hall or time) now **locks the hall row exclusively first** (`SELECT … FOR UPDATE`), which makes everyone who writes a booking for one hall go one after another and removes the deadlock. The exclusion constraint is unchanged and still the guard against a double booking; the retry stays as a safety net. After the change the same load test failed 0 of 12 times. Cost: bookings for the same hall are processed one at a time (other halls are unaffected), which is fine at college scale.
- **Pool safety:** work inside a transaction uses that transaction's connection only. (An early version borrowed a second connection inside the transaction and, with 20 simultaneous requests and a pool of 10, every request waited for a connection held by another: a real deadlock. Fixed and covered by the 20-request test.)

**Evidence (all run against the real PostgreSQL test database):**

- 20 simultaneous requests for one hall and slot, repeated over 5 rounds: exactly one `201`, nineteen `409`, one active row each time.
- Partly overlapping windows in parallel (`10–12`, `11–13`, `12–14`): never two overlapping active rows.
- Simultaneous back-to-back requests all succeed; 10 identical simultaneous requests produce one booking.
- A new request racing with a change of another booking into the same slot: never both.
- Raw SQL that bypasses the service is rejected with `23P01`; adjacent ranges, other halls and overlaps with rejected/cancelled rows are accepted; reviving a cancelled booking into a taken slot is rejected.
- **Sensitivity check:** with the constraint temporarily dropped from the test database, 6 of these tests fail (including "exactly one of 20"); with it restored all pass. So the tests really depend on the constraint, not on the service's early check.
- The concurrency file was run 5 times in a row without a failure.

## 4. Preventing over-allocation (resources)

A resource has a total quantity. Many reservations may overlap in time as long as, **at every instant, the units in use never exceed the total**. That cannot be written as a table constraint, so:

1. Every change to a resource's reservations (reserve, change, release, shrink the total) first **locks the resource row** (`SELECT … FOR UPDATE`). Concurrent requests for the same resource therefore run one at a time. Different resources do not block each other.
2. Under that lock the service computes the **peak usage** inside the requested window and inserts only if `peak + requested ≤ total`.
3. Peak, not sum: usage only rises where a reservation starts, so it is enough to evaluate the window's start and every reservation start inside it. A plain sum of everything that overlaps the window would wrongly reject, for example, a request for 2 units across `10–12` when 3 units are reserved for `10–11` and another 3 for `11–12` with stock 5 (the real maximum is 5).
4. Lock order is always *resource row, then reservation row*, so changes cannot deadlock each other.
5. Shrinking a resource's total is refused (409 `RESOURCE_IN_USE`) if future reservations already need more.

**Evidence:** 12 simultaneous single-unit requests against stock 5: exactly 5 succeed and the busiest instant never exceeds 5. 6 simultaneous requests for 3 units against stock 5: exactly one succeeds, over 3 rounds. Identical simultaneous requests: one reservation. Two simultaneous increases that would together exceed the stock: one is refused. Replacing the peak query with a plain sum makes the peak test fail; removing the quantity check makes 6 tests fail; removing the row lock makes 3 fail.

Resources can only be reserved for events that are **`approved` or `published`** and have not started. A reservation is confirmed immediately (no separate approval).

## 5. How it follows the event lifecycle

Registered once in `createApp` through `registerBookingHooks` (`modules/bookings/hooks.ts`), running inside the event action's transaction:

| Event action                    | Hall bookings                                                                  | Resource reservations              |
| ------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| `cancel`                        | all active bookings become `cancelled` (history + audit); organizer emailed if someone else cancelled | all released                       |
| `revise` (back to draft)        | stay (independent of approval); a time no longer covering the event is flagged | released (event no longer approved) |
| `submit`, `revise`              | department / organizer copied onto the booking is refreshed                    | none                               |
| `unpublish`, `withdraw`, `close`| unchanged                                                                      | unchanged                          |

## 6. Limits and trade-offs (read before relying on it)

- **Hall guarantee depends on the database object.** It needs the `btree_gist` extension and the constraint from migration `021`. Anyone who drops that constraint removes the protection; `migrations.test.ts` checks that it exists with the expected definition.
- **Resource totals are enforced by the service**, under a row lock, not by a database constraint. A writer that bypasses the service (raw SQL) could oversubscribe a resource. All application paths take the lock.
- **Per-resource serialization.** Reservations for one resource are processed one at a time. Fine at college scale; not designed for thousands of requests per second on a single resource.
- **Not atomic across halls.** An event with bookings in two halls is two independent bookings.
- **Calendar is advisory** by decision: the platform suggests, it never refuses. There are no hall "closure windows" (those would also be only suggestions); an inactive hall is the only hard block.
- **Not built:** recurring bookings, buffer time between bookings, a dedicated hall-manager role (admins manage halls), resource approvals, per-booking prices.
- **Time zone:** all instants are UTC in the database; calendar dates and the UI use `APP_TIMEZONE` (default `Asia/Kolkata`).
- **A rejected or cancelled booking is final**; the organizer makes a new request.

## 7. API summary

| Method and path                                                          | Who                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `GET /api/halls`, `GET /api/halls/:id`                                   | any signed-in user (inactive halls: admins only)              |
| `POST /api/halls`, `PATCH /api/halls/:id`                                | admin                                                         |
| `GET /api/bookings/availability?startAt&endAt&attendance&facilities&onlyAvailable` | any signed-in user (event names follow event visibility) |
| `POST /api/bookings`, `PATCH /api/bookings/:id`, `POST …/:id/cancel`      | the event's organizer, or an admin                            |
| `GET /api/bookings?scope=mine\|event\|department\|approvals`, `GET …/:id` | people allowed to see the booking                             |
| `POST /api/bookings/:id/approve` and `/reject` with `{ level, comment? }` | faculty step: faculty of the department; second step: its HOD or any admin |
| `GET /api/resources`, `GET /api/resources/availability`                  | any signed-in user (retired resources: admins only)           |
| `POST /api/resources`, `PATCH /api/resources/:id`                        | admin                                                         |
| `GET/POST /api/resource-reservations`, `PATCH …/:id`, `POST …/:id/release` | the event's organizer or an admin (department staff may read) |

`level` in a decision is the step the user was looking at (`faculty` or `hod_admin`); a mismatch means the screen is stale (409 `STALE_DECISION`).

## 8. Audit and email

Audit actions: `hall.created|updated`, `resource.created|updated|reserved|reservation_updated|released`, `booking.requested|updated|approval_granted|approval_rejected|cancelled`. Emails (idempotent jobs): `booking.approval_requested`, `booking.decision` (organizer), `booking.cancelled`. `booking_history` is the user-facing timeline.

## 9. Sources consulted

PostgreSQL 16 documentation: [Constraints (exclusion constraints)](https://www.postgresql.org/docs/16/ddl-constraints.html), [btree_gist](https://www.postgresql.org/docs/16/btree-gist.html), [Range types](https://www.postgresql.org/docs/16/rangetypes.html), [Explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html), [Transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html). Behaviour that the pages did not state (the `23P01` error code, partial exclusion constraints, deadlock behaviour of overlapping inserts) was verified by running it against PostgreSQL 16.15 and is covered by tests.
