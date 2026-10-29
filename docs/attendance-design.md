# Attendance: QR check-in, manual check-in and gate passes (feature 7)

Status: **implemented and tested** (`docs/feature-status.md` lists exactly what was run). Rules marked **A-n** were chosen by the engineer while the product owner was away and are assumptions awaiting confirmation (`docs/decisions.md` section 11). Registrations this builds on: `docs/registration-design.md`.

## 1. What exists

| Part                         | Where                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Signed check-in code (QR)    | `modules/attendance/qr.ts`                                                                      |
| Check-in, volunteers, live count | `modules/attendance/{service,repository,routes}.ts`, tables `attendance`, `event_volunteers` (migration `033`) |
| Gate-pass PDF (worker job)   | `modules/attendance/{gatepass,pdf}.ts`, table `gate_passes`, job `gate_pass.generate`           |
| "Checked in people keep their seat" | `modules/attendance/hooks.ts` using the cancel guard in `modules/registrations/guards.ts` |
| Public surface               | `modules/attendance/index.ts` (section 8)                                                       |
| Screens                      | the person's pass on the event page; `/check-in` (my events) and `/events/:id/check-in` (the gate screen) |

New libraries (approved 2026-10-27): `pdfkit` (D-10), `qrcode` and `jsqr` (D-19).

## 2. Rules (assumptions A-1 to A-10)

- **A-1 Who scans:** the event's organizer, admins, and **volunteers** the organizer (or an admin) assigns to that event by account email (U-8 default). A volunteer is an ordinary account with no new role, and works for that one event. Department faculty and HODs can see the live numbers but cannot scan.
- **A-2 Manual check-in** (FR-7.4): only the organizer or an admin, with a **reason (3 to 300 characters)** that is stored and audited. The database requires it (`attendance_reason_check`).
- **A-3 Check-in window:** open from **two hours before the start until the event ends**, and only while the event is `published`. Outside it: 409 `CHECK_IN_CLOSED` with the window times.
- **A-4 The pass:** every confirmed registration has its own signed QR code (team members each have theirs). It is valid until the event ends and is the same code every time the person looks at it. Only a `registered` person has one: cancelled and waiting people are refused (409 `REGISTRATION_NOT_ACTIVE`).
- **A-5 One check-in per person, ever.** A second scan answers 409 `ALREADY_CHECKED_IN` with the time and how. There is no "undo". **A checked-in person can no longer cancel their registration** (otherwise their seat would be freed, and given to someone waiting, while they are at the event).
- **A-6 Gate-pass PDF** (FR-7.3): made by the worker, never in the request. It shows the event, date and time (India time), venue, holder, team and the QR code. The **venue** is the confirmed hall booking (several halls are joined with commas), or "To be announced". The person is **emailed a link** to the event page (not the PDF itself, and never the code) and downloads it there while signed in.
- **A-7 Fonts:** the PDF uses the standard PDF fonts, which cover Western European characters. **Names in other scripts (for example Devanagari) are not drawn correctly.** Fixing that needs a Unicode font file bundled with the app.
- **A-8 No offline scanning, no exit or re-entry tracking, no walk-ins:** a person must be registered before they can be checked in.
- **A-9 Attendance means "was checked in".** It is the fact later features (certificates, reports) read; what counts for a certificate is decided there (U-6).
- **A-10 Signing key:** `QR_SIGNING_SECRET` if set (at least 32 characters), otherwise a separate key derived from `JWT_SECRET` with HMAC, so the raw JWT key is never used for two purposes.

## 3. The check-in code

`EQ1.<payload>.<signature>`: the payload is `{ r: registration id, e: event id, x: expiry }` (base64url); the signature is HMAC-SHA256 over `EQ1.<payload>`.

- The **signature is checked first** (constant-time comparison), before the payload is read; then the payload shape, then the expiry.
- A changed registration, event or expiry fails the signature. A pass for another event is refused at this one (400, "different event"). An expired pass says so (400).
- The code proves the pass was issued for that registration; it cannot prove who is holding it. **Single use is the defence against a shared screenshot:** the first scan wins and every later scan is refused.
- The check is made against the database too: the registration must still exist, belong to this event and be `registered`.

## 4. Exactly one check-in per pass (AC-7.2)

`attendance.registration_id` is `UNIQUE` (`attendance_registration_key`). The insert uses `ON CONFLICT DO NOTHING`; if nothing was inserted, the scan answers `ALREADY_CHECKED_IN`. So two scanners, a retry, or a scan racing a by-hand check-in can only ever produce one row. The check-in also locks the event row first (the same lock as registrations, see `registration-design.md` section 3), which makes a scan and a cancellation of the same registration happen one after the other: afterwards a registration is either checked in or cancelled, never both.

**Evidence (real PostgreSQL, real HTTP requests):** 12 simultaneous scans of one pass (by the organizer, an admin and four volunteers) produce exactly one check-in and 11 `ALREADY_CHECKED_IN`; 25 different people scanned at once all succeed with no loss; 10 scans racing 10 cancellations (3 rounds) never leave a registration both cancelled and checked in. Removing the event lock makes that last test fail every time; removing each of the following also fails tests: the signature check, the expiry check, the event match, the scanner permission, the window, the "registered only" rule, the cancel guard, the organizer-only manual check-in.

## 5. API summary

| Method and path                                                  | Who                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `POST /api/events/:eventId/check-ins` with `{ token }`           | organizer, admins, assigned volunteers                       |
| `POST /api/events/:eventId/check-ins/manual` with `{ registrationId, reason }` | organizer, admins                              |
| `GET /api/events/:eventId/attendance?limit&offset`               | scanners and the event's department faculty/HOD (counts, latest check-ins) |
| `GET/POST /api/events/:eventId/volunteers`, `DELETE …/:userId`   | organizer, admins                                            |
| `GET /api/check-in/events`                                       | anyone (events they can scan for now)                        |
| `GET /api/registrations/:id/qr`                                  | the registrant (code as text and as an image)                |
| `GET /api/registrations/:id/gate-pass`                           | the registrant (the PDF, or 202 while it is being made)      |

Errors: 400 for a bad, expired or other-event code; 403 for people who may not scan; 404 for events they cannot see; 409 `ALREADY_CHECKED_IN`, `CHECK_IN_CLOSED`, `REGISTRATION_NOT_ACTIVE`.

## 6. Gate-pass job

A `gate_pass.generate` job is queued (key `gate-pass:<registration id>`, so once per registration) whenever a registration becomes confirmed: individual registration, creating or joining a team, and promotion from the waitlist. The handler renders the PDF, stores it through the file-storage service, records it, and queues the "gate pass ready" email in one transaction. Running it twice, or two workers at once, ends with one file and one email (the loser deletes its copy). A registration cancelled before the job runs gets no pass; a malformed job fails at once instead of retrying.

## 7. Limits and trade-offs

- A QR code can be copied; single use limits the damage, it does not prevent impersonation. Checking a photo ID is outside the system.
- No undo of a check-in and no way to remove a check-in made by mistake (an admin would need database access). Not requested; see the open question in `decisions.md`.
- The window is fixed (two hours before the start to the end), not configurable per event.
- The gate screen reads the camera in the browser (`jsqr`); it needs HTTPS (or localhost) and the person's permission. A typed or pasted code is always available. Reading codes from a real camera was **not** tested (the camera is faked in tests); what was tested is that the image the server draws is read back by the same library, and that a rendered PDF page still scans.
- The screen refreshes the count every 5 seconds (polling), not instantly.
- `QR_SIGNING_SECRET` rotation: changing it invalidates every pass already issued (the PDFs contain the old code). Passes would have to be regenerated.

## 8. What other features can use

```ts
import { attendedUserIds, countAttendance, getAttendanceForRegistration } from '../attendance/index.js';
```

`attendedUserIds(db, eventId)` is the list of people who were checked in, in order. A person who was registered but not checked in is a no-show.

## 9. Sources and how things were verified

- Library choices were approved by the product owner (pdfkit, qrcode, jsqr). No documentation was fetched for them this session; their behaviour was checked by running them.
- **Run once, not automated:** the QR image the server draws decodes (with `jsqr`) back to the identical code and that code verifies; a generated PDF opens, has one A5 page and the right text (`pdftotext`), and the QR is found by `jsqr` on the page rendered by `pdftoppm`; the compiled production build renders a PDF.
- HMAC-SHA256 with a constant-time comparison (`crypto.timingSafeEqual`) is standard practice; no external source was consulted for it.
