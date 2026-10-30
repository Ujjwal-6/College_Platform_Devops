# Post-event report (feature 19)

Status: **implemented and tested** (`docs/feature-status.md` lists exactly what was run). The layout, content and limits were not specified (U-7), so **the product owner has answered the questions about it (marked *confirmed* or *changed* in `docs/decisions.md` section 13); the rest were chosen by the engineer and await confirmation** (RPT-1 to RPT-12). It builds on registration, attendance, feedback and certificates.

## 1. What exists

| Part                          | Where                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Reports, photos, outcomes     | `modules/reports`, tables `event_reports`, `event_photos`, `event_report_inputs` (migration `038`) |
| Making a report (worker)      | `reports/{handlers,service,pdf}.ts`, job `report.generate`                                 |
| Starting it when an event closes | `reports/hooks.ts` (event lifecycle hook, inside the closing transaction)               |
| Screen                        | the "Post-event report" section of the event page (organizer, department staff, admins)    |

No new libraries (`pdfkit` from the gate pass).

## 2. How it works

1. **Closing queues it** (FR-19.1, AT-19.5, AT-19.9). When the event is closed, the same database transaction creates version 1 (reason `close`, status `pending`) and queues one job. If anything makes the close roll back, no report and no job exist. The request returns without waiting for the PDF.
2. **The worker draws it.** It gathers the data through the other modules' public interfaces, draws the PDF, stores it, marks the version `ready`, and emails **the organizer and the admin who gave the event's final approval** (and whoever asked for that version) a link to the event page (RPT-8). Other admins are not emailed.
3. **Missing information never fails the report** (FR-19.4, AT-19.2). Every section is always present; when its information is missing it says so: "No photographs provided.", "No feedback received.", "No outcomes provided.", "No speakers listed.", "No certificates have been issued yet.", "Not available (nobody registered)".
4. **Failures are retried** (AT-19.4): the job runs again with the queue's backoff, up to 5 attempts. After the last attempt (or an error retrying cannot fix) the version is marked `failed` with a short reason, an audit record is written and the same people are emailed. A failed version can be replaced by asking for a new one. *The "failure metric" in AT-19.4 is not built: there is no metrics system yet (feature 16).*
5. **Versions** (FR-19.5, AT-19.8). Asking for a new version after the event closed makes version n+1 and keeps every older one downloadable. One report is drawn at a time per event (a second request while one is pending is 409 `REPORT_IN_PROGRESS`). The automatic report of a close exists once: a unique index makes closing twice, or delivering the job twice, harmless (AT-19.3). Two workers drawing the same version end with one stored file and one set of emails.

## 3. What the report contains (A4, as many pages as needed)

1. **Event details:** title, when, venue (the confirmed hall booking, else "Not provided"), department, organizer, category, registration type, seat limit, description.
2. **Speakers:** name, designation, organization.
3. **Attendance:** registered, checked in, **attendance rate = checked in ÷ registered** (one decimal, as in AC-9.3), registered but did not come, walk-ins, by-hand check-ins and, when the organizer required check-out, stayed to the end / left early / not checked out. Walk-ins count as registered (they are registered at the gate).
4. **Outcomes:** the organizer's text (up to 3000 characters).
5. **Photographs:** two per row with captions.
6. **Feedback:** responses, average, how the ratings were spread, and up to 10 comments, **anonymous** (no names, no identifiers).
7. **Certificates:** how many were issued and withdrawn.

Deliberately **not** in the report: names of attendees; budget (feature 9 is not built); equipment used; calendar warnings.

Titles, comments and names are drawn as text, so HTML or script characters stay inert (AT-19.7); long text wraps and flows onto more pages. Only the standard PDF fonts are used (English; other scripts are not drawn correctly). A heading is never left alone at the foot of a page: the photographs heading moves with its first photos.

## 4. What the organizer provides

- **Outcomes:** `PUT /api/events/:eventId/report/outcomes` with `{ outcomes }` (empty clears it).
- **Photographs** (FR-19.3, U-7 default): `POST /api/events/:eventId/report/photos?caption=…` with the raw image (`image/png` or `image/jpeg`). **At most 20 per event, 2 MB each** (lowered from 5 MB at the product owner's request). The type is checked by looking at the bytes, not the name or the declared type; a script sent as `image/png` is refused (422). Over 2 MB is 413; the 21st is 409 `TOO_MANY_PHOTOS` (also when many arrive at once, and refused uploads leave no stray file).
- **Before or after the event closes**, from the time it is published. The report uses what exists when it is drawn; late photographs need a new version.
- A photograph that cannot be read when drawing (a corrupt file that looks like a JPEG) is skipped with the note "1 photograph could not be included", and one whose file went missing is skipped quietly. Neither stops the report.

## 5. API summary

| Method and path                                                          | Who                                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `GET /api/events/:eventId/report`                                        | organizer, department faculty/HOD, admins (inputs, photos, versions, what the viewer may do) |
| `PUT /api/events/:eventId/report/outcomes`                               | organizer, admins                                                    |
| `POST /api/events/:eventId/report/photos`, `DELETE …/photos/:photoId`    | organizer, admins                                                    |
| `GET /api/events/:eventId/report/photos/:photoId`                        | organizer, department faculty/HOD, admins (the image)                |
| `POST /api/events/:eventId/reports`                                      | organizer, admins (new version; only for a closed event)             |
| `GET /api/event-reports/:id/download`                                    | organizer, department faculty/HOD, admins (PDF; 202 while pending; 409 if failed) |

Everyone else gets 403 (AT-19.6); a missing or malformed id is 404 or 400. Errors: 409 `EVENT_NOT_CLOSED`, `EVENT_NOT_ACTIVE`, `REPORT_IN_PROGRESS`, `REPORT_FAILED`, `TOO_MANY_PHOTOS`.

## 6. Evidence

Real PostgreSQL and real HTTP requests (`reports.test.ts`, 34 tests; stable over 3 runs):

- AT-19.1: 10 registered, 8 checked in → the PDF says "Registered: 10", "Checked in: 8", "80.0%". AT-19.2: no photos, no feedback, no outcomes → every section says so; an event nobody registered for is covered too.
- AT-19.3: closing twice, running the job 6 times (4 of them at once) → one version, one job, one file, one set of emails. AT-19.4: a renderer that fails twice succeeds on the third attempt (the job shows 3 attempts); one that always fails ends `failed` after 5 attempts with an audit record and emails to the organizer and the final approving admin, and a new version can then be made. AT-19.5: a close refused by another hook leaves no report and no job. AT-19.6: organizer, faculty, HOD and admins get the PDF; students, other departments, other organizers and a stranger get 403; no sign-in is 401. AT-19.7: a title with `<script>` and `<img onerror>`, 120 repeated sentences and 90-character speaker fields all draw, and the markup is in the file as plain text. AT-19.8: a photograph added after closing and a new version → version 2 contains it, version 1 is unchanged and still downloadable. AT-19.9: after the close request there is no PDF yet and the report is pending.
- Who is told: the organizer and the final approving admin only (the other admin, faculty and HOD are not); the person who asks for a new version as well, once; no duplicate when the organizer asks; deactivated accounts are skipped; the final approval of the latest round counts. Letting every admin be emailed, forgetting the requester, or emailing deactivated accounts each fail tests.
- 25 photographs uploaded at once leave exactly 20 rows and 20 files; five people asking for a new version at once get exactly one `202`.
- **Sensitivity checks:** each of these makes tests fail: closing queuing nothing, every error being final (no retries), nobody told of a failure, only the organizer told, anyone downloading, no photo limit, an inverted rate, asking before closing, a bad photograph stopping the report, ignoring the one-pending rule.
- **Run once, not automated:** realistic reports (speakers, numbers, outcomes, five photos, comments; and a worst case where the page break falls right before the photographs) were drawn with `pdfkit`, converted with `pdftoppm` and looked at. That found an orphaned "5. Photographs" heading at the foot of page 1, which is fixed.

## 7. Limits and trade-offs

- **File size:** photographs are embedded as they are, so a report with 20 photographs of 2 MB can be around 40 MB. Reports are limited to 60 MB and held in memory while drawn. Resizing photographs would need an image library (not approved).
- The attendance numbers are as of when the report is drawn; a new version is needed for later changes.
- Attendance names, budget and equipment are not in the report (see section 3). The budget needs feature 9.
- No failure counter/metric (feature 16 is not built). An admin sees failed jobs on the Jobs page, and the organizer and admins are emailed.
- "The chosen admin" is read as the admin who gave the final approval of the event. If that account is deactivated, or the event has no final approval, only the organizer (and whoever asked for the version) is emailed, so a failure may reach nobody but the organizer.
- One plain layout, no logo or signature (the certificate design is separate).
- Only the standard PDF fonts: English text.
- A closed event is final (no reopening), so the report cannot become stale because of an edit to the event itself.

## 8. What other features can use

`listEventReports(db, eventId)` (`modules/reports/index.ts`) returns the versions. The dashboard and analytics (feature 9) can link to the current version (the highest ready one).

## 9. Sources and how things were verified

No external sources were consulted. The acceptance tests are `AT-19.1` to `AT-19.9` in `docs/requirements.md`.
