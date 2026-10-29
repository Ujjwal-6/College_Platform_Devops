# Registration (individual and team): design

Status: **implemented and tested** (see `docs/feature-status.md` for exactly what was run). The rules below marked **R-n** were chosen by the engineer while the product owner was away; the owner has since confirmed most of them and asked for a waitlist (`docs/decisions.md` section 10 shows what is confirmed and what is still an assumption). How registration plugs into events: `docs/event-contract.md`.

## 1. What exists

| Part                      | Where                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Registrations, teams      | `modules/registrations`, tables `registrations`, `teams` (migration `030`)                      |
| Safe retries              | `platform/idempotency.ts`, table `idempotency_keys` (migration `031`)                           |
| Invitation codes          | `modules/registrations/codes.ts` (random, hashed, expiring)                                     |
| Waitlist                  | `waitlisted` registrations (migration `032`), promotion in `service.ts` (`promoteFromWaitlist`)    |
| Event integration         | `modules/registrations/hooks.ts` (event lifecycle hook); uses only `modules/events/index.ts`    |
| Public surface for others | `modules/registrations/index.ts` (see section 7)                                                |
| Screens                   | a Registration section on every event page; "My registrations" page                            |

## 2. Rules (assumptions R-1 to R-15)

- **R-1 Who:** any signed-in, active user of any role (the organizer too) may register for a published event they can see. Drafts and other non-public events answer 404.
- **R-2 When:** the event is `published` and the registration deadline (default: the start time) has not passed (`isEligibleForRegistration`). Otherwise 409 `REGISTRATION_CLOSED`.
- **R-3 Capacity counts people.** Every registered person takes one seat, team leaders and members alike. No capacity means no limit. A full event answers 409 `EVENT_FULL`.
- **R-4 Individual and team events are different flows.** Individual: one request. Team: a leader creates a team (name 2 to 60 characters, unique within the event ignoring case) and takes a seat; others join with the invitation code. Using the wrong flow is 409 `WRONG_REGISTRATION_MODE`. One registration per person per event, so nobody can be in two teams (409 `ALREADY_REGISTERED`).
- **R-5 Invitation codes:** 16 characters from a 32-symbol alphabet without I, L, O, U (80 bits of randomness; the requirement is 64), shown as `7K2M-QX9D-4HT8-WB3N`. **Reusable until the team is full**, the code expires, or the leader turns it off (U-9 default). Typing is forgiving (lower case, spaces, I/L/O). Only a SHA-256 hash is stored, so the code is shown once, when it is created or renewed; the leader can renew it (the old one stops working) or turn it off. A wrong, malformed, expired, revoked or dissolved-team code all give the same answer (404 `INVALID_INVITATION`, one message), so a guess reveals nothing.
- **R-6 Code lifetime:** 7 days, or until registration closes if that is sooner.
- **R-7 Cancelling:** only the registrant, until the event starts (409 `EVENT_STARTED` afterwards). Repeating a cancel is harmless. A cancelled person can register again (the same row is reused, a new confirmation email goes out, the unique constraint still holds). Not even an admin cancels someone else's registration (404).
- **R-8 Leader leaves:** leadership passes to the member who has been in the team longest; if nobody is left, the team is dissolved and its code stops working.
- **R-9 Minimum team size is informational.** A team below the minimum is shown as "needs N more members" but is never removed or blocked automatically.
- **R-10 Who sees whom:** the event's organizer, its department's faculty/HOD and admins see names and emails of registrants; everyone signed in sees only seat counts; team members see teammates' names (no emails).
- **R-11 Event changes:** cancelling the event cancels every registration, dissolves the teams and emails each person (same transaction). **Unpublishing or sending the event back to draft is refused (409 `EVENT_HAS_REGISTRATIONS`) while anyone is registered**, because those actions close registration or change what people signed up for. The organizer cancels the event or asks people to cancel first.
- **R-12 Safe retries:** `POST` register, create team and join accept an `Idempotency-Key` header (8 to 64 letters, digits, `-`, `_`). Repeating the request with the same key returns the original answer (header `Idempotent-Replayed: true`) and does nothing twice. Same key with a different request is 422 `IDEMPOTENCY_KEY_REUSED`. Keys are per person and remembered for 24 hours. Failures are not remembered, so a corrected retry is evaluated fresh.
- **R-13 Rate limits** (per signed-in person, not per address): 60 registration writes and 20 invitation-code attempts per 15 minutes (`REGISTRATION_RATE_LIMIT_MAX`, `INVITATION_CODE_RATE_LIMIT_MAX`, `REGISTRATION_RATE_LIMIT_WINDOW_SECONDS`).
- **R-14 Waitlist: built, see section 3b.**
- **R-15 Email:** one confirmation per registration, and one notice per person when the event is cancelled. No reminder, and the leader is not emailed when someone joins.

## 3. Keeping seats and team sizes correct (AC-3.1, AC-3.4)

Capacity and team size cannot be a plain table constraint, so the service serialises changes **per event**:

1. Every operation that changes registrations (register, create team, join, cancel, renew code) starts by loading the event with `getEventById(tx, id, true)`: `SELECT … FOR UPDATE` on the event row.
2. Under that lock it counts seats, counts the team, and only then inserts.
3. **The event's own actions take the same lock first** (publish, cancel, unpublish…), so a registration in progress and an event action cannot interleave: a registration that got in is seen by the cancel (and cancelled with it), or it starts afterwards and finds the event no longer open.
4. **One lock order everywhere:** event row, then team row, then registration rows. An earlier version used a separate advisory lock and then needed the event row for the foreign-key check, while event actions held the row and waited for the advisory lock: the concurrency test found that deadlock (`TRY_AGAIN`). Locking the event row for both removed it.
5. Everything inside the transaction uses the transaction's connection (never `ctx.pool`), and the transaction is wrapped in `retryTx`, as for hall bookings.

The database is the last guard for what it can express: `UNIQUE (event_id, user_id)` (one registration per person per event), a unique partial index on team names, and on invitation hashes.

**Evidence (real PostgreSQL, real HTTP requests):**

- 50 people at once, capacity 10: exactly 10 succeed and 40 get `EVENT_FULL`, over 3 rounds.
- One person, 10 simultaneous requests: exactly one registration. With one shared key, all 10 answer 201 with the same id, 9 flagged as replays, one registration, one audit row, one email.
- Team of at most 4, 15 simultaneous joiners: exactly 3 get in. 12 people each creating a team with capacity 5: exactly 5 succeed and refused requests leave no team behind. 8 people picking the same team name: one team.
- Leader leaving while 6 people join: the team always keeps a leader who is a registered member, never more than 4 members (3 rounds).
- Event cancelled while 20 people register: nobody stays registered, and everyone who got in before the cancellation got exactly one cancellation email (3 rounds).
- Both registration test files were run 5 times in a row without a failure.
- **Sensitivity checks:** removing the event lock fails 6 tests, removing the capacity check 8, the team-size check 4, ignoring idempotency keys 5, the unpublish/revise veto 2, honouring expired codes 1. Restored, all pass.

## 3b. Waitlist (individual events)

- **Joining:** when an individual event is full, `POST /api/events/:id/registrations` with `{ "waitlist": true }` puts the person in the queue (201, `status: "waitlisted"`, `waitlistPosition`). Without the flag the answer stays 409 `EVENT_FULL`. If a seat is free the flag is harmless: a normal registration. Team events have no waitlist.
- **No seat while waiting:** seats are counted from `registered` rows only. The queue is ordered by `waitlisted_at` (the real insertion moment, `clock_timestamp()`), then by id.
- **Promotion:** when a registered person cancels, `promoteFromWaitlist` runs in the same transaction and under the same event lock: the first waiting person becomes `registered` and gets the "A seat opened up" email (idempotent key per promotion). A freed seat is therefore never visible while someone waits, so newcomers cannot jump the queue. Once registration has closed (deadline passed) nobody is promoted.
- **Leaving:** a waiting person may leave (the same cancel endpoint); this frees nothing and promotes nobody; places behind them move up.
- **Event cancelled:** waiting people are cancelled (`cancel_reason = event_cancelled`) and emailed together with the registered ones.
- **Database:** `registrations_waitlist_check` makes a waiting row require `waitlisted_at` and forbids a team; the unique `(event_id, user_id)` still allows one row per person.
- **Evidence:** 20 simultaneous joins get distinct places 1 to 20 and take no seat; 3 holders leaving while 5 newcomers register: exactly the first 3 in line are promoted and every newcomer is refused; 8 holders leaving at once promote all 8 waiting people; an event cancelled during 15 simultaneous joins leaves nobody registered or waiting (3 rounds). Breaking promotion, queue order, the closed-registration rule, the seat count or the email each fails tests.

## 4. Limits and trade-offs

- **Seat and team limits are enforced by the service under a row lock, not by a database constraint.** A writer that bypasses the service (raw SQL) could oversubscribe. All application paths take the lock.
- **Per-event serialisation:** registrations for one event are processed one at a time, and they wait for event actions on the same event. Fine at college scale; not designed for thousands of registrations per second for one event.
- **Not built (and, for the first two, deliberately not wanted):** removing a member (by the leader or the organizer), organizer cancelling someone's registration, a waitlist for team events, transferring leadership manually, reminders, export of registrants, per-registration extra fields (food, size…), approval of registrations.
- **Codes cannot be shown again.** If the leader loses it, they renew it.
- **Rate limits are in memory** per API process (as for login); behind several API instances each counts separately.
- **Idempotency keys** are stored in the database; there is no clean-up job. Old rows are ignored after 24 hours and replaced when the key is reused.
- Reading the registrants of one event is capped at 100 rows in the screen (the API pages).

## 5. API summary

| Method and path                                                       | Who                                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/events/:eventId/registration-summary`                       | anyone who can see the event (seats, open, my registration)      |
| `POST /api/events/:eventId/registrations` with optional `{ waitlist }` | any signed-in user (individual events)                           |
| `POST /api/events/:eventId/teams` with `{ name }`                     | any signed-in user (team events); answer includes the code once  |
| `POST /api/teams/join` with `{ code }`                                | any signed-in user                                               |
| `GET /api/teams/:id`                                                  | the team's members, event staff                                  |
| `POST /api/teams/:id/invitation` and `/invitation/revoke`             | the team leader                                                  |
| `GET /api/registrations`                                              | the signed-in user (their own)                                   |
| `POST /api/registrations/:id/cancel`                                  | the registrant                                                   |
| `GET /api/events/:eventId/registrations?status&limit&offset`          | organizer, department faculty/HOD, admins (`status` may be `waitlisted`) |

## 6. Audit and email

Audit actions: `registration.created|waitlisted|promoted|cancelled`, `team.created|leader_changed|dissolved|invitation_regenerated|invitation_revoked`. The invitation code never appears in audit metadata, jobs or logs. Emails (idempotent jobs): `registration.confirmed`, `registration.promoted`, `registration.event_cancelled`.

## 7. What other features can use (attendance, certificates, reports)

```ts
import { getRegistrationById, getRegistrationForUser, registeredUserIds, countRegistered } from '../registrations/index.js';
```

A registration is **confirmed** when `status = 'registered'`; a `waitlisted` person has no seat and must not be treated as confirmed. A cancelled registration keeps its row (`cancel_reason`: `self` or `event_cancelled`), so attendance must check the status, not only that a row exists. Teams are only a grouping: `registrations.team_id`.

## 8. Sources and how things were verified

- Consulted this session: PostgreSQL 16, [Explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html). It confirms that `FOR UPDATE` conflicts with `FOR KEY SHARE` (the row-lock conflict table) and that transaction-level advisory locks are released at the end of the transaction.
- **Not stated by that page, observed by running it:** that the foreign-key check on inserting a registration takes the key-share lock on the event row. The deadlock between the first design (advisory lock, then event row) and event actions (event row, then the advisory lock in the hook) was reproduced by the cancel-during-registration tests, and the one-lock-order design removed it.
- Also used, from earlier work and not re-fetched this session: PostgreSQL documentation on unique constraints and partial unique indexes, and `INSERT … ON CONFLICT`.
- The `Idempotency-Key` behaviour (header name, 422 for reuse with a different request, replaying the stored answer) follows the IETF draft *The Idempotency-Key HTTP Header Field*, which was **not** fetched in this session; the status codes are the engineer's reading of it.
