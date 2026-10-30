# Budget, analytics and CSV reports (feature 9)

Status: **implemented and tested** (`docs/feature-status.md` lists exactly what was run). The requirements (FR-9.1 to FR-9.3) leave the categories, who sees what and the definitions open, so the choices below are partly **confirmed by the product owner and partly assumptions** (BA-1 to BA-14 in `docs/decisions.md` section 15).

## 1. What exists

| Part                       | Where                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Budget items               | `modules/budgets`, table `budget_items` (migration `040`)                                       |
| Analytics and CSV          | `modules/analytics` (read-only; no tables of its own)                                           |
| Screens                    | "Budget" and "Analytics" sections of the event page; the `/analytics` page (admins and HODs)    |
| Money helpers (screen)     | `apps/web/src/lib/money.ts`                                                                     |

No new libraries.

## 2. Budget (FR-9.1)

- An event has **line items**, each either a **plan** (`estimate`) or **money spent** (`actual`), with a category, a description (1 to 200 characters) and an amount. Actual items may carry the date they were spent.
- **Money is whole paise** in a `bigint` column (ASM-3, INR). One item is at most ₹100,00,00,000 (a database CHECK as well as a schema rule); an event has at most 200 items (checked under the event row lock, so parallel requests cannot go over). Sums are made by the database (`sum(...)`) and added as integers; nothing uses floating point. 10 paise + 20 paise is exactly 30 paise (AC-9.1).
- **Dates** are `date` columns read as text, so no machine's time zone can move a day.
- **Categories** are a fixed list: venue, equipment, catering, printing, speakers, prizes, travel, marketing, other (BA-1).
- **Who**: the organizer and admins can add, change and remove items; the HOD and the faculty of the event's department can read; everyone else (including other organizers and other departments' staff) gets 403 (AC-9.2). A cancelled event's budget is read-only (409 `EVENT_CANCELLED`).
- **Over budget is a warning, never a block** (edge case in section 9): the totals say `overBudget` per category and overall, and the screen shows a notice.
- **After the event closed**, edits are still allowed and each audit record says `afterClose: true` (edge case). Every add, change and remove is audited (`budget.item_added|item_updated|item_removed`) with the before and after of a change.

## 3. Analytics (FR-9.2)

All numbers are read-only aggregates computed on request.

| Number                | Definition                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Registered            | people with a `registered` registration (cancelled and waitlisted are not counted)                                  |
| Attendance rate       | **checked in ÷ registered** (AC-9.3), one decimal. Empty until the event has started or when nobody registered      |
| Did not come          | registered minus checked in; empty until the event has ended                                                        |
| Overall rate          | over events that have started only, so next week's event does not drag it down                                       |
| Feedback average      | exact from integer sums (total of ratings ÷ number of ratings), two decimals; the overall average is by response    |
| Certificates          | issued and not withdrawn                                                                                            |
| Registrations per day | registrations per local (India) day, zero-filled for the whole period                                               |
| Hall utilization      | confirmed bookings clipped to **08:00 to 20:00 each day** ÷ 12 hours × days in the period; at most 100% (BA-7)      |

- **Period**: events that started between two dates (`from`, `to`, India time, both included). Default: the last 90 days. At most 366 days; from after to, a bad date or an unknown parameter is 400.
- **Who** (BA-4): admins see every department and may narrow to one; a HOD sees only their own department (asking for another is 403) and no hall figures; organizers, faculty and students get 403. For one event, the organizer, the department's staff and admins see the event's numbers; the budget part only for those who may see the budget (the same people).
- Lists are limited to 500 events; the screen and the response say when the list was cut short.
- The module reads other modules' tables with aggregate queries instead of calling a service per event. That is a documented exception to "never read another module's tables" (BA-9): one set-based query is the only way to answer these questions without one query per event, and it writes nothing.

## 4. CSV (FR-9.3)

- `GET /api/analytics/events.csv` (admins and HODs, same period and scope rules) and `GET /api/analytics/halls.csv` (admins).
- RFC 4180: comma separated, CRLF line ends, quotes doubled, fields with commas, quotes or line breaks quoted. UTF-8.
- **Formula injection** (a title such as `=HYPERLINK(...)` would run in a spreadsheet): a text cell starting with `=`, `+`, `-`, `@`, tab or carriage return is written with a leading `'`. Numbers are never changed.
- Money columns are in rupees with two decimals, made from the integer paise.
- The response is sent as an attachment with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## 5. Interface

| Method and path                               | Who                                   |
| --------------------------------------------- | ------------------------------------- |
| `GET /api/events/:eventId/budget`             | organizer, HOD and faculty of the department, admin |
| `POST /api/events/:eventId/budget/items`      | organizer, admin                      |
| `PATCH` / `DELETE /api/events/:eventId/budget/items/:itemId` | organizer, admin       |
| `GET /api/events/:eventId/analytics`          | organizer, department staff, admin    |
| `GET /api/analytics/summary`                  | admin, HOD                            |
| `GET /api/analytics/events.csv`               | admin, HOD                            |
| `GET /api/analytics/halls.csv`                | admin                                 |

## 6. Not built

PDF summary reports (only the post-event report is a PDF), per-department budget limits or approval of spending, receipts or file attachments on items, charts beyond simple bars, a budget section in the post-event report (RPT-1 leaves it out), exporting the audit log.
