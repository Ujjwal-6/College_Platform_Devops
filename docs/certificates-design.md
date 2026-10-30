# Certificates and feedback (feature 8)

Status: **implemented and tested** (`docs/feature-status.md` lists exactly what was run). Rules marked **C-n** (certificates) and **F-n** (feedback): the product owner has answered the questions about them (marked *confirmed* or *changed*); the rest were chosen by the engineer and await confirmation (`docs/decisions.md` section 12). They build on attendance (`docs/attendance-design.md`).

## 1. What exists

| Part                         | Where                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Certificates                 | `modules/certificates`, table `certificates` (migration `036`)                              |
| Issuing, PDF drawing (worker)| `certificates/{service,handlers,pdf}.ts`, jobs `certificate.issue_event`, `certificate.generate` |
| The college's design         | table `certificate_template` (migration `037`), admin page `/admin/certificate-design`       |
| Feedback                     | `modules/feedback`, table `feedback` (migration `036`)                                      |
| Screens                      | Feedback and Certificates sections on the event page; "My certificates"; the public page `/verify/:code` |

No new libraries (the PDF and QR libraries come from the gate pass). Migrations `036` (certificates, feedback) and `037` (withdrawal, design).

## 2. Certificates

- **C-1 Who gets one:** a person whose attendance counts as **completed** (`attendanceReport`): checked in and, while the organizer requires check-out (the default), checked out within 15 minutes of the end or later. If the organizer does not require check-out, being checked in is enough. People who were absent, cancelled, waiting, still inside at the end, or left early get none (AC-8.2). Only a **participation** certificate exists; there are no winner or other types (U-6 default).
- **C-2 When** (*changed by the product owner*): certificates are made **only when the organizer (or an admin) presses "Issue certificates"** on the event page, once the event has ended; nothing is issued automatically when the event is closed. Pressing it again later picks up people who became eligible since (for example late check-outs); people who already have one are skipped. An event that is cancelled, not yet over, or not published/closed issues nothing.
- **C-3 Not blocked by feedback** (FR-8 edge case, U-6 default): a certificate does not depend on giving feedback.
- **C-4 One per person per event** (AC-8.1): a unique constraint on `(event_id, user_id)`; the insert is `ON CONFLICT DO NOTHING`, so a job that is retried, run twice, or run by two workers at once cannot make a second one. Each certificate also queues its own PDF job once.
- **C-5 The PDF:** drawn by the worker (A4 landscape): the person's name, the event, dates (India time), **the organising department's name** (from the event), the certificate code, and a QR code that opens the verification address. When the college has supplied them (C-10), also its **logo, its name and a signature block** (signature image, signatory name and title). The person gets an **email with a link** to "My certificates" (never the code or the file) and downloads the PDF there while signed in. Standard PDF fonts only: names in other scripts are not drawn correctly (accepted, English only); very long names and event titles are shrunk or wrapped to fit.
- **C-6 Verification** (FR-8.3, AC-8.4): every certificate has a random code of 80 bits (`7K2M-QX9D-4HT8-WB3N`, typed forgivingly). `GET /api/certificates/verify/:code` and the page `/verify/:code` need **no sign-in** and show only what is printed on the certificate: the name, the event and its date. A genuine code is `valid`; a **withdrawn** one answers `valid: false, revoked: true` with nothing else; a wrong, malformed or non-existent one is the same 404. It is **rate limited per address** (60 per 15 minutes, `VERIFY_RATE_LIMIT_MAX`), so valid codes cannot be found by trying.
- **C-7 Correcting a name:** an admin presses "Redraw" on a certificate: the PDF is drawn again with the person's **current** name, the **code stays the same**, the old file is deleted, the person is not emailed again, and the verification page shows the new name. Only admins can do this.
- **C-8 Participation only** (*confirmed*): there are no winner, volunteer or other types.
- **C-9 Withdrawing** (*requested by the product owner*): the organizer of the event or an admin can **withdraw** a certificate with a reason (3 to 300 characters), and **reinstate** it later. A withdrawn certificate keeps its row and code (so the code answers "withdrawn", not "not found"), cannot be downloaded (409 `CERTIFICATE_REVOKED`), is not made again by issuing, and its holder is shown "Withdrawn" without the reason. Two people withdrawing at once: one succeeds, the other gets 409 `ALREADY_REVOKED`. The holder is not emailed about a withdrawal (confirmed by the product owner). The database requires who, when and a reason together (`certificates_revoked_check`).
- **C-10 The college's design** (*the product owner will supply the logo and signature later*): an admin sets the college or organisation name, the signatory's name and title, and uploads a **logo** and a **signature image** (PNG or JPEG, at most 1 MB, checked by their content, not their file name or type) on the page `/admin/certificate-design`. One design for all certificates. It is used for every certificate drawn **after** it was saved; to change certificates that already exist an admin presses "Redraw all certificates" on the event (or "Redraw" for one), which draws them again with the current design and the people's current names, keeping the codes and without emailing anyone again. If a stored image goes missing, certificates are still made without it. A preview before saving is not built (drawing a PDF is the worker's job, not the request's).

## 3. Feedback

- **F-1 Form** (U-12 default): a rating of 1 to 5 stars (required) and an optional comment (up to 1000 characters). **One per person per event**, enforced by a unique constraint (AC-8.3); it cannot be edited or withdrawn.
- **F-2 Who and when:** only people who were **checked in** (any way, even if they left early or never checked out). It opens **when the event ends** and stays open **14 days**. Cancelled events are hidden, so nobody can give feedback on them.
- **F-3 Anonymity** (U-12 default, "tied to the user but hidden from organizers"): the person's identity is stored only so that "once" can be enforced. What the organizer, the department's faculty/HOD and admins see is the count, the average, how the ratings are spread, and the comments with their rating: **no names, no times, and no identifiers**, in a stable shuffled order (by a hash of the row) rather than the order they were written. The audit log records that feedback was given, never what it said or its rating.
- **F-4 No reminders:** nobody is emailed to ask for feedback.
- **F-5 No minimum number of responses** before results are shown. With very few responses (one person) the author can be guessed; see the limits.

## 4. API summary

| Method and path                                                        | Who                                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/certificates/verify/:code`                                   | anyone (no sign-in), rate limited                                 |
| `GET /api/certificates`                                                | the signed-in person (their own)                                  |
| `GET /api/certificates/:id/download`                                   | the holder (PDF, or 202 while it is being drawn)                  |
| `POST /api/certificates/:id/regenerate`                                | admins (redraw one)                                               |
| `POST /api/certificates/:id/revoke` with `{ reason }`, `…/reinstate`   | the event's organizer, admins                                     |
| `POST /api/events/:eventId/certificates/redraw`                        | admins (redraw all of an event)                                   |
| `GET/PUT /api/certificate-template`, `PUT/DELETE …/logo`, `…/signature` | admins (the design; images sent as the raw image)                 |
| `GET /api/events/:eventId/certificates`                                | organizer, department faculty/HOD, admins (who has one, counts)   |
| `POST /api/events/:eventId/certificates/issue`                         | organizer, admins (once the event is over; the only way certificates are made) |
| `GET /api/events/:eventId/feedback/mine`                               | any signed-in person (may I, did I, is it open)                   |
| `POST /api/events/:eventId/feedback` with `{ rating, comment? }`       | people who were checked in                                        |
| `GET /api/events/:eventId/feedback`                                    | organizer, department faculty/HOD, admins (anonymous results)     |

Errors: 403 `FEEDBACK_ATTENDEES_ONLY`; 409 `ALREADY_SUBMITTED`, `FEEDBACK_CLOSED`, `EVENT_NOT_OVER`, `ALREADY_REVOKED`, `NOT_REVOKED`, `CERTIFICATE_REVOKED`; 413, 415 and 422 for a bad image; 404 `CERTIFICATE_NOT_FOUND`; 429 when verifying too often.

## 5. Evidence

Real PostgreSQL and real HTTP requests (`certificates.test.ts`, `feedback.test.ts`; stable over 3 runs):

- Pressing Issue gives certificates to exactly the people who stayed (not to absent, cancelled, left-early or still-inside people); with check-out not required, to everyone checked in. Closing the event issues nothing.
- Running the issue job again, retrying, or running it 6 times at once never makes a second certificate, PDF, email or audit record; 60 attendees get 60 distinct certificates, PDFs and codes.
- A raw SQL insert of a second certificate for a person, a repeated code, or a "ready" certificate without a file is refused by the database.
- 10 simultaneous feedback submissions by one person: exactly one is stored.
- Genuine codes verify (also typed with spaces, lower case or no dashes) and reveal no email or id; random and malformed codes are the same 404; the 4th check in a row is 429.
- Withdrawing: 3 admins at once → exactly one succeeds; a withdrawn code answers "withdrawn" with no name; issuing again never revives or duplicates it; reinstating restores it. The design: images that are not really PNG/JPEG (a script in an `image/png` request, a PDF), empty or over 1 MB are refused; a logo, organisation, signature and signatory appear on certificates drawn afterwards; redrawing all of an event keeps the codes, replaces the files and emails nobody.
- **Sensitivity checks:** making certificates go to everyone checked in, removing the one-per-person protection, letting anyone download any certificate, letting non-admins redraw, issuing before the event is over, letting anyone give feedback, ignoring the feedback window, showing results to attendees, and adding the writer to the comments each make tests fail; so do letting anyone withdraw, showing a withdrawn code as valid, letting a withdrawn certificate be downloaded, allowing a double withdrawal, letting non-admins change the design or redraw, and ignoring the supplied design when drawing.
- **Run once, not automated:** a real certificate drawn with `pdfkit` opens as one A4 page with the right text (`pdftotext`), and the QR code on the rendered page decodes to the exact verification address (`jsqr`). Certificates with a placeholder logo, signature and organisation name, including a worst case with a 60-character name and a two-line event title, were rendered and looked at: nothing overlaps. **The real logo and signature have not been seen yet** (they will be supplied later).

## 6. Limits and trade-offs

- **Small events weaken anonymity:** with one or two responses the organizer can often tell who wrote them (and the shuffle cannot help). No minimum is enforced (F-5).
- Identity is stored with each feedback row (needed for "once"); someone with direct database access could read it. The application never returns it.
- A wrong attendance record is fixed by withdrawing the certificate; there is no undo for check-ins themselves.
- A certificate shows the name as it was when issued; only an admin redraw updates it.
- One design for all certificates, which the product owner confirmed for now (no per-department logo or signatory). Very wide or tall logo and signature images are scaled to fit a fixed space, so odd proportions may look small.
- The public verification page shows a person's name to anyone who has the code. That is what verification means, and the code is 80 bits, but the code on a shared certificate reveals it.
- Names in non-Latin scripts are not drawn correctly (see C-5).
- Losing stored PDFs requires redrawing them (admin, per event or one by one).

## 7. What other features can use

```ts
import { listCertificatesForEvent } from '../certificates/index.js';
import { feedbackSummary } from '../feedback/index.js';
```

The post-event report (feature 19) can show the number of certificates issued and the feedback summary (count, average, distribution), never the individual comments' authors.

## 8. Sources and how things were verified

No external sources were consulted; the PDF and QR libraries were approved and first used for the gate pass. The certificate PDF and QR were checked once with `pdftotext`, `pdftoppm` and `jsqr` as described above.
