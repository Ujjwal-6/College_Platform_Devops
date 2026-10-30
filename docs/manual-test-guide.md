# Manual test guide

A step-by-step script to check the whole platform by hand with real accounts of every type. Each test says **who** does it, **what** to do and **what you should see**. Mark every test Pass or Fail; the result sheet is at the end.

> **Honest note:** this script was written from the code and the design documents and has **not yet been run by a person**. If a step's wording or result differs slightly from what you see, say so in the result sheet: it may be the guide that is wrong, not the program.

Times: the application works in **India time (IST)**. Everything below uses what the screen shows.

---

## 0. Before you start

### 0.1 Start the system
```bash
npm install
npm run setup:env            # creates .env with generated secrets (only if you have none)
docker compose up -d db mailpit   # PostgreSQL + a fake mailbox at http://localhost:8025
npm run migrate
npm run dev                  # API :4000, worker, web :5173
```
No Docker? Install PostgreSQL 16 yourself (README, "Without Docker") and use the mail catcher in appendix A instead of Mailpit.

Open http://localhost:5173. Use **a fresh database** for a clean run (drop and recreate `events_dev`, then `npm run migrate`).

### 0.2 Create the first administrator
```bash
ADMIN_EMAIL=admin@college.test ADMIN_NAME="Priya Sharma" ADMIN_PASSWORD='violet-river-lantern-4821' npm run create-admin
```
Password rules (used everywhere): at least 12 characters, not a very common password, must **not contain the name part of the email** (so `admin-...` is refused for `admin@...`), not made of few repeated characters.

### 0.3 Create the departments (there is no screen for this yet)
```bash
set -a; source .env; set +a
psql "$DATABASE_URL" -c "insert into departments(name) values ('Computer Science'),('Electronics')"
```

### 0.4 Create the test users
Sign in as the admin → **Users** → **Create user** (email, name, password, department, roles). Use the password `violet-river-lantern-4821` for all of them.

| Email | Name | Role(s) | Department | Used for |
|---|---|---|---|---|
| `admin@college.test` | Priya Sharma | admin | none | (exists) administration, final approval |
| `admin2@college.test` | Vikram Rao | admin | none | second admin |
| `hod.cs@college.test` | Prof. Mehta | hod | Computer Science | approvals, budgets, analytics |
| `faculty.cs@college.test` | Dr. Rao | faculty | Computer Science | first approval |
| `faculty2.cs@college.test` | Dr. Iyer | faculty | Computer Science | a second approver |
| `organizer.cs@college.test` | Aarav Kapoor | organizer | Computer Science | creates events |
| `organizer2.cs@college.test` | Sara Khan | organizer | Computer Science | a competing organizer |
| `hod.ec@college.test` | Prof. Nair | hod | Electronics | other-department checks |
| `faculty.ec@college.test` | Dr. Shah | faculty | Electronics | other-department checks |
| `student1@college.test` … `student8@college.test` | Isha, Rohan, Meera, Kabir, Ananya, Dev, Zoya, Neel | student | Computer Science | registration, attendance |
| `volunteer@college.test` | Tara Menon | student | Computer Science | volunteer at the door |
| `walkin@college.test` | Yash Gupta | student | Computer Science | walk-in |

**Test U1.** After creating each account, sign out and sign in with it.
Expected: you reach the dashboard, the greeting shows the name and a role badge, and the top menu only shows what the role may use (students do not see Approvals, Analytics, Users, Jobs…).

### 0.5 The "time machine" (needed because events must start in the future)
Events can only be created and published with a start in the future, but check-in, certificates, feedback, reports and analytics need events that are running or over. Move an event's times in the database with these commands (replace the title):
```bash
set -a; source .env; set +a
# running now (check-in is open): started 10 min ago, ends in 2 hours
psql "$DATABASE_URL" -c "update events set start_at = now() - interval '10 minutes', end_at = now() + interval '2 hours' where title = 'Tech Symposium'"
# just ended: started 3 hours ago, ended 10 minutes ago
psql "$DATABASE_URL" -c "update events set start_at = now() - interval '3 hours', end_at = now() - interval '10 minutes' where title = 'Tech Symposium'"
# ended 30 hours ago (for automatic closing)
psql "$DATABASE_URL" -c "update events set start_at = now() - interval '32 hours', end_at = now() - interval '30 hours' where title = 'Tech Symposium'"
```
Reload the page after each command.

### 0.6 Handy facts
- **Check-in** opens 15 minutes before the start and closes at the end.
- **Feedback** opens when the event ends and stays open 14 days.
- A published event **closes automatically 24 hours after it ended** (the worker runs the check every 5 minutes). Set `EVENT_AUTO_CLOSE_INTERVAL_SECONDS=10` in `.env` while testing to see it quickly.
- Five wrong passwords lock an account for 15 minutes.

---

## 1. Sign-in and accounts

| # | Who | Steps | Expected |
|---|---|---|---|
| 1.1 | anyone | Open http://localhost:5173 while signed out | Redirected to "Sign in" |
| 1.2 | admin | Wrong password once | "Invalid email or password." No hint whether the email exists |
| 1.3 | admin | Unknown email with any password | The same message as 1.2 |
| 1.4 | student1 | Enter a wrong password 5 times, then the right one | Sixth attempt refused (account locked 15 minutes); the message stays generic |
| 1.5 | student1 | Click **Forgot your password?**, enter the email, send | A neutral message ("If that address has an account…"). An email arrives in Mailpit with a link |
| 1.6 | student1 | Enter an unknown email on the same page | The **same** neutral message; **no** email arrives |
| 1.7 | student1 | Open the link, set a new password (twice), submit | "Password changed"; sign in works with the new password, not with the old one |
| 1.8 | student1 | Open the same link again | "This link is invalid, expired or already used" with an offer to ask for a new one |
| 1.9 | student1 | Choose a too-short or too-common new password on a fresh link | The rule that was broken is shown; the link still works afterwards |
| 1.10 | student1 | Ask for a link, then ask again; try the **first** link | First link refused, second works |
| 1.11 | any | Sign in, close the browser tab, reopen the site | Still signed in (session restored); **Sign out** returns to "Sign in" and the back button does not show private pages |
| 1.12 | admin | Users → deactivate student2 → student2 tries to sign in | Refused. Reactivate afterwards |
| 1.13 | admin | Try to deactivate or remove the admin role from the **only** admin | Refused (last-admin protection) |

## 2. Users (admin)

| # | Steps | Expected |
|---|---|---|
| 2.1 | Admin opens **Users** | List of all users with roles and status; **Create user** form |
| 2.2 | Create a user with two roles (e.g. faculty + hod) | Created; both roles listed |
| 2.3 | Create a user with an email that exists (different capitals) | Refused (duplicate) |
| 2.4 | Create a user with a weak password | Refused with the rule |
| 2.5 | HOD opens **Users** | Sees only users of their own department |
| 2.6 | Student / organizer / faculty try http://localhost:5173/users | Redirected away; the menu has no Users entry |

## 3. Academic calendar (admin)

| # | Who | Steps | Expected |
|---|---|---|---|
| 3.1 | admin | **Calendar** → Add entry: a restricted date (exam day) about 6 days from now | Appears in the list |
| 3.2 | organizer | Create an event on that date and submit it (section 4) | A calendar warning is shown to the approvers and acknowledged by the organizer; the event is **not blocked** (the calendar only advises) |
| 3.3 | student | Open **Calendar** | Can read, cannot add entries |

## 4. Events and approvals

Create all events as **organizer.cs** unless stated.

| # | Who | Steps | Expected |
|---|---|---|---|
| 4.1 | organizer | **Events → New event**: title "Tech Symposium", category technical, department Computer Science, description, start in 2 days 10:00, end 14:00, expected attendance 100, capacity 5, Individuals, add one speaker → Save | Event page, status **Draft**, history shows "Created" |
| 4.2 | organizer | Save with the end before the start, an empty title, or a start in the past | Each is refused with a message next to the field |
| 4.3 | organizer | Edit the draft (change the description) | Saved |
| 4.4 | organizer | **Submit for approval** | Status "Pending approval: awaiting Faculty"; edit buttons disappear |
| 4.5 | student1 | Open the event URL directly | Cannot see the draft or the pending event (not found/forbidden). After publishing (4.12) they see it |
| 4.6 | faculty.ec (other department) | Look at **Approvals** | The event is **not** listed; opening its URL is refused |
| 4.7 | hod.cs | Open **Approvals** | Not yet listed (the faculty level comes first); approve attempts by URL are refused: **no skipping levels** |
| 4.8 | faculty.cs | **Approvals** → open the event → **Reject** without a comment | Refused: a comment is required |
| 4.9 | faculty.cs | **Reject** with the comment "Please add the budget" | Status back to **Draft**; the organizer sees "Rejected at the Faculty level…" with the comment |
| 4.10 | organizer | Edit, **Submit for approval** again | Pending approval, Faculty again (a new round) |
| 4.11 | faculty.cs → hod.cs → admin | Each opens **Approvals** and clicks **Approve** in turn | After each: next level awaits; after admin: status **Approved**; the Approvals table lists three approvals with names and times |
| 4.12 | organizer | **Publish** | Status **Published**; visible to everyone in **Events → Upcoming** |
| 4.13 | organizer | Try to approve their own event (if they also hold faculty) | Impossible: nobody approves their own event; one person approves at only one level |
| 4.14 | organizer | **Unpublish**, then **Publish** again | Works; history records both |
| 4.15 | organizer | Make a second event, **Submit**, then **Withdraw** (confirm) | Back to Draft |
| 4.16 | organizer | On a published event: **Cancel event** with no reason, then with a reason | Refused without a reason; with one, status **Cancelled**, registrants (if any) are emailed |
| 4.17 | organizer2 | Open organizer.cs's event; try **Publish/Cancel/Edit** | No such buttons; the API refuses if forced |
| 4.18 | admin | Open the same event | Admin may cancel/publish any event |

## 5. Halls, equipment and hall booking

| # | Who | Steps | Expected |
|---|---|---|---|
| 5.1 | admin | **Halls → Add a hall**: "Main Auditorium", capacity 300, facilities projector/ac | Listed |
| 5.2 | admin | Add a second hall "Seminar Hall A", capacity 60 | Listed |
| 5.3 | admin | **Resources → Add a resource**: "Projector", quantity 3 | Listed |
| 5.4 | organizer | Event page → **Book a hall**: Main Auditorium, the event's time | Booking created, status **Pending** (needs approval) |
| 5.5 | organizer | Book a hall smaller than the expected attendance | A warning is shown (capacity), booking can still be requested |
| 5.6 | organizer2 | Their own event, the **same hall and an overlapping time**, while the first booking is still pending or confirmed | **Refused with a conflict (409)**: pending and confirmed bookings both hold the hall; two active bookings of one hall can never overlap |
| 5.7 | faculty.cs → hod.cs/admin | **Bookings** → open organizer's booking → approve in turn | Status **Confirmed** after the last approval |
| 5.8 | organizer2 | Book the same hall at a time that starts exactly when the first booking ends | Allowed (ranges are half-open: back to back is fine) |
| 5.9 | organizer | Open **Halls → Find a hall** and search the first booking's time | Main Auditorium shows **taken**, Seminar Hall A **free** |
| 5.10 | organizer | Change a pending booking's time / cancel a booking | Works; history lists it; a cancelled booking frees the hall |
| 5.11 | organizer | Event page → Equipment and resources → reserve 2 Projectors | Reserved |
| 5.12 | organizer2 | Reserve 2 Projectors for an overlapping time | Refused: only 1 left (quantity is enforced) |
| 5.13 | organizer | Cancel the event | Hall booking and equipment are released automatically |

## 6. Registration and waitlist

Use an event **published** with capacity 5 (from 4.12). Students are student1…student8.

| # | Who | Steps | Expected |
|---|---|---|---|
| 6.1 | student1 | Open the event → **Register** | "You are registered"; seats "1 of 5 taken"; a gate pass appears (section 7) |
| 6.2 | student1 | Register again (double click, or second tab) | Still only **one** registration |
| 6.3 | student2…student5 | Register | Seats "5 of 5": the event is full |
| 6.4 | student6 | Open the event | "This event is full" and **Join the waitlist** |
| 6.5 | student6 | **Join the waitlist** | "You are on the waitlist (place 1)" |
| 6.6 | student1 | **Cancel registration** | Seat freed; **student6 is registered automatically** and gets an email |
| 6.7 | organizer | Event page → "Registered people" and "Waiting list" tables | Correct names and emails; a student cannot see these tables |
| 6.8 | any | Try to register after the event started or after the registration deadline | Not offered / refused |
| 6.9 | organizer | Create a **team** event (Registration: Teams, minimum 2, maximum 3), publish | — |
| 6.10 | student1 | **Create team** "Alpha" | Registered as leader; an **invitation code** is shown once |
| 6.11 | student2 | **Join team** with the code | Joined; team page lists both |
| 6.12 | student3 | Join with a wrong code several times quickly | Refused each time, then rate limited ("Too many attempts") |
| 6.13 | student1 | **New invitation code**, then **Turn off code**; student4 tries the old code | Old code refused |
| 6.14 | student1 | Fill the team to the maximum; student5 tries to join | Refused: team is full |
| 6.15 | student1 (leader) | **Leave the team and cancel** | Per the rules in `docs/registration-design.md` |

## 7. Attendance: gate pass, check-in, check-out

Use the published event with registrations (section 6). Move it with the time machine to "running now" (0.5).

| # | Who | Steps | Expected |
|---|---|---|---|
| 7.1 | student2 | **My registrations** → the event | "Your gate pass" with a QR code; "Download gate pass (PDF)" gives a PDF with the same QR (it may say "being prepared" for a few seconds) |
| 7.2 | organizer | Event page → **Open check-in for this event** (or **Check-in** in the menu) | Check-in page for the event |
| 7.3 | organizer | Event **more than 15 minutes before** the start | Check-in says it is not open yet |
| 7.4 | organizer | Arriving → paste/type the pass code from 7.1 (**Code as text**) → submit | "Checked in", name shown; listed under **Latest check-ins** |
| 7.5 | organizer | Submit the **same** code again | Refused: a pass works once |
| 7.6 | organizer | Type a code with one character changed | Refused: invalid pass (signed codes cannot be forged) |
| 7.7 | organizer | **Start camera** and hold a phone/printed pass in front of it (needs a camera and HTTPS or localhost) | Same result as typing the code |
| 7.8 | student3 | Look at their own pass after check-in | "You were checked in at …" |
| 7.9 | organizer | Settings → tick **Allow walk-ins**; **Walk-in** → email `walkin@college.test` → **Check in walk-in** | Checked in without registration |
| 7.10 | organizer | Settings: leave walk-ins off, try a walk-in | Refused |
| 7.11 | organizer | With the event **full**, try a walk-in; then tick **Let walk-ins take seats beyond the seat limit** and retry | Refused, then allowed |
| 7.12 | organizer | **Record by hand**: choose a person and a reason → **Check in by hand** | Recorded with the reason |
| 7.13 | organizer | Tick **Require check-out**; Leaving → scan student2's code | "Checked out"; the list shows the time in the **Out** column |
| 7.14 | organizer | Check out someone more than 15 minutes before the end | Counted as **left early** |
| 7.15 | organizer | **Volunteers** → email `volunteer@college.test` → **Add volunteer** | Listed |
| 7.16 | volunteer | Sign in → **Check-in** → the event | Can scan, cannot change settings or add volunteers |
| 7.17 | student4 (not staff) | Open the check-in page URL | Refused |
| 7.18 | organizer2 | Open the check-in page of another organizer's event | Refused |

## 8. Certificates and feedback

Move the event to "just ended" (0.5).

| # | Who | Steps | Expected |
|---|---|---|---|
| 8.1 | organizer | Event page → Certificates | Counts of people who may get one (checked in, and stayed to the end if check-out was required) |
| 8.2 | organizer | Press **Issue certificates** | Certificates appear one per eligible person with a code; they become "ready" after the worker draws them |
| 8.3 | organizer | Press it twice | No duplicates |
| 8.4 | student2 | **Certificates** (menu) → download | A PDF with the name, event, organising department and (if an admin set them) the college name, logo and signature |
| 8.5 | anyone, **signed out** | `/verify` → enter the certificate code | "Valid" with name and event; no private data |
| 8.6 | anyone | Verify a wrong code many times | "Not found", then rate limited |
| 8.7 | organizer | **Withdraw** a certificate with a reason | Status withdrawn; verifying its code says "withdrawn" |
| 8.8 | organizer | **Reinstate** it | Valid again |
| 8.9 | admin | **Certificate design**: set organisation name, signatory, title; upload a PNG logo and signature | Saved; redraw an event's certificates and look at the new PDF |
| 8.10 | admin | Upload a file that is not an image (rename a .txt to .png) | Refused |
| 8.11 | student2 (attended) | Event page → **Feedback**: 4 stars + a comment → submit | "Thank you" |
| 8.12 | student2 | Try to submit a second time | Refused (once per person) |
| 8.13 | student7 (did not attend) | Open the event | No feedback form |
| 8.14 | organizer | Read "What attendees said" | Ratings and comments **without names or times**; the order is shuffled |
| 8.15 | student3 | Try feedback before the event ended / after 14 days | Not offered |

## 9. Closing the event and the report

| # | Who | Steps | Expected |
|---|---|---|---|
| 9.1 | organizer | Event page → Post-event report → write **Outcomes** → **Save outcomes** | Saved |
| 9.2 | organizer | **Add a photograph** (JPEG/PNG under 2 MB), with a caption | Listed; a 3 MB or non-image file is refused |
| 9.3 | organizer | Press **Close event** on a **running** event | Refused: it can only be closed after it ended |
| 9.4 | organizer | Move the event to "just ended"; **Close event** | Status **Closed** |
| 9.5 | organizer | Wait a few seconds; reload | The Reports table shows version 1, status ready; **Download** opens a PDF with details, speakers, attendance (registered vs checked in, rate), outcomes, photos, feedback summary and certificate counts. The organizer and the admin who gave the final approval get "report ready" emails |
| 9.6 | organizer | Edit the outcomes, ask for a **new version** | Version 2 appears; version 1 stays downloadable |
| 9.7 | student | Try to download a report | Refused |
| 9.8 | organizer | Create and publish another event; move it to "ended 30 hours ago"; wait up to 5 minutes (or 10 s with the faster setting) | **Closes by itself**; history says "Closed automatically after the event ended", actor "system"; a report is made |
| 9.9 | organizer | Close an event by hand while a closed one exists | Closing twice does nothing harmful |
| 9.10 | admin | **Audit log**: filter action `event.closed` | Both closes are listed; the automatic one has no actor and `automatic: true` |

## 10. Budget

Use an event of organizer.cs.

| # | Who | Steps | Expected |
|---|---|---|---|
| 10.1 | organizer | Event page → Budget → Type **Planned**, Category venue, Description "Hall decoration", Amount `15000.50` → **Add item** | Row "₹15,000.50"; totals update |
| 10.2 | organizer | Add Planned: catering `42000`, printing `6500` | Planned total **₹63,500.50** exactly |
| 10.3 | organizer | Add **Spent** items: venue `18000` (with a date), catering `45000` | Spent ₹63,000.00; the by-category table shows "(above plan)" on venue and catering |
| 10.4 | organizer | Make spending exceed the plan overall | A warning "Spending is ₹… above the planned amount" — **nothing is blocked** |
| 10.5 | organizer | Amount `1.234`, `abc`, `-5`, empty | Refused ("Enter the amount in rupees…") before sending |
| 10.6 | organizer | **Edit** an item (amount → `16000`), then **Remove** another | Totals follow |
| 10.7 | hod.cs, faculty.cs | Open the same event | See the budget but **no** Add/Edit/Remove |
| 10.8 | organizer2, student1, faculty.ec, hod.ec | Open the event / budget | No budget section (refused) |
| 10.9 | admin | Open the event | Can edit |
| 10.10 | organizer | Edit an item after the event is **closed** | Allowed; the audit log shows `budget.item_updated` with `afterClose: true` and before/after values |
| 10.11 | organizer | Cancel the event; try to edit the budget | Refused: read-only |
| 10.12 | organizer | Add 200 items (script) then one more | The 201st is refused |

## 11. Analytics and CSV

Needs events that already started (use the time machine) with registrations, check-ins, feedback and budget.

| # | Who | Steps | Expected |
|---|---|---|---|
| 11.1 | admin | **Analytics** | Totals, a registrations-per-day chart, the events table, departments (if more than one), hall utilization |
| 11.2 | admin | Check the **attendance rate** against your own count | checked in ÷ registered; an event that has not started shows "—" |
| 11.3 | admin | Choose From/To dates and a department → **Show** | Numbers change accordingly; a period over 366 days or From after To is refused |
| 11.4 | admin | **Download events (CSV)**, open in Excel/Sheets | One row per event; money in rupees with 2 decimals |
| 11.5 | organizer | Create an event titled `=1+1` or `+91 99999`, make it started, download the CSV | The title shows as text (with a leading `'`), never as a formula |
| 11.6 | admin | **Download halls (CSV)** | One row per hall; booked/available hours |
| 11.7 | hod.cs | **Analytics** | Only Computer Science; **no** halls section or halls download; the department filter is absent |
| 11.8 | faculty.cs / organizer / student | Open `/analytics` | Redirected away. Faculty see the numbers of **one event** on that event's page (Analytics section), not the summary |
| 11.9 | any role | On an event page, Analytics section | Organizer, department staff and admin see it; other roles do not |

## 12. Administration tools

| # | Who | Steps | Expected |
|---|---|---|---|
| 12.1 | admin | **Audit log** → filter by actor, action, dates | Matching records; every earlier test left records (login, approvals, bookings, budget, check-ins…) |
| 12.2 | admin | Try to change or delete an audit record | Impossible (append-only) |
| 12.3 | admin | Stop the mail catcher (or Mailpit), trigger an email (forgot password), wait | **Jobs** shows the job retrying, then **failed** with the error |
| 12.4 | admin | Start the mail catcher again → **Retry** on the failed job | Job succeeds; the email arrives |
| 12.5 | non-admin | Open `/admin/jobs`, `/admin/audit`, `/admin/certificate-design` | Redirected away |

## 13. Monitoring (optional)

1. Put `METRICS_TOKEN=some-long-random-text-1234` in `.env` and restart.
2. `curl -i http://localhost:4000/metrics` → **401**. Without a token configured it is **404**.
3. `curl -H "Authorization: Bearer some-long-random-text-1234" http://localhost:4000/metrics` → text with `http_requests_total`, `jobs{status="failed"}`, `database_up 1`.
4. Click around the site, repeat step 3: the request counters grow; ids in addresses appear as `:id`.
5. Set `WORKER_METRICS_PORT=4001`, restart, and fetch `http://localhost:4001/metrics` with the same token: `job_runs_total` and `events_auto_closed_total` are present.
6. (Needs Docker) `docker compose --profile app --profile monitoring up`: Prometheus on :9090 (Status → Targets both UP), Grafana on :3000 dashboard "College Events". **This has never been run: report what you see.**

## 14. Security spot checks

| # | Steps | Expected |
|---|---|---|
| 14.1 | Signed out, open `/events`, `/analytics`, `/users` | Redirected to Sign in |
| 14.2 | As student, change the address to `/admin/jobs`, `/approvals`, `/analytics` | Redirected / refused |
| 14.3 | As organizer2, open organizer.cs's event URL and the check-in page URL | No edit/close/check-in powers |
| 14.4 | As faculty.ec, open a Computer Science event's budget and registrations | Refused |
| 14.5 | In a field (event title, comment, team name) type `<script>alert(1)</script>` | Shown as plain text, nothing runs; PDFs and emails show it as text |
| 14.6 | Sign in on two browsers, sign out of one | The other stays signed in until its own sign-out; after a password reset **all** sessions end |
| 14.7 | Wait 15 minutes idle, then act | Session renews silently, or asks to sign in again; no data is shown to a signed-out person |

## 15. Look and feel

| # | Steps | Expected |
|---|---|---|
| 15.1 | Resize the window to phone width (or use the device toolbar, 390 px) | No sideways scrolling of the page; menu scrolls sideways; tables scroll inside their frame |
| 15.2 | Switch your operating system to dark mode | Dark colours on every page, text readable |
| 15.3 | Use only the keyboard (Tab/Enter) on the login and event forms | A visible focus ring; every button reachable |
| 15.4 | Zoom the browser to 200% | Still usable |

---

## Result sheet

Copy this table into a spreadsheet. For every test write Pass / Fail, the tester, the date, and for a Fail the exact steps, what you expected, what happened and a screenshot.

| Section | Tests | Pass | Fail | Notes |
|---|---|---|---|---|
| 1 Sign-in | 1.1–1.13 | | | |
| 2 Users | 2.1–2.6 | | | |
| 3 Calendar | 3.1–3.3 | | | |
| 4 Events and approvals | 4.1–4.18 | | | |
| 5 Halls and equipment | 5.1–5.13 | | | |
| 6 Registration | 6.1–6.15 | | | |
| 7 Attendance | 7.1–7.18 | | | |
| 8 Certificates and feedback | 8.1–8.15 | | | |
| 9 Closing and report | 9.1–9.10 | | | |
| 10 Budget | 10.1–10.12 | | | |
| 11 Analytics and CSV | 11.1–11.9 | | | |
| 12 Administration | 12.1–12.5 | | | |
| 13 Monitoring | 1–6 | | | |
| 14 Security | 14.1–14.7 | | | |
| 15 Look and feel | 15.1–15.4 | | | |

### Bug report template
```
Title:
Test number:
Account used (role):
Steps (numbered):
Expected:
What happened:
Screenshot / error text:
Browser and version:
```

---

## Appendix A: a mail catcher without Docker

Save as `smtp-sink.mjs` and run `node smtp-sink.mjs mail.txt` (it listens on port 1025, the default `SMTP_PORT`). Every email the system sends is appended to `mail.txt` (the link in a password-reset email is split across lines with `=` at line ends: join them).

```js
import net from 'node:net';
import { appendFileSync } from 'node:fs';
const out = process.argv[2];
net.createServer((sock) => {
  let data = '', inData = false, buf = '';
  sock.write('220 sink ready\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { appendFileSync(out, data + '\n=====\n'); data = ''; inData = false; sock.write('250 queued\r\n'); }
        else data += line + '\n';
      } else if (/^EHLO|^HELO/i.test(line)) sock.write('250 sink\r\n');
      else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    }
  });
}).listen(1025, '127.0.0.1', () => console.log('smtp sink on 1025'));
```

## Appendix B: what is known not to be tested yet

The author could not run these, so please look closely and report: the screens in a real browser, the camera scanner on a real phone, real email through a real mail server, Docker/Compose, Prometheus and Grafana, and the GitHub Actions pipeline.

## Appendix C: open questions that affect expected results

Some rules are the author's assumptions awaiting the product owner (`docs/decisions.md`, sections 10 to 16). If a result differs from what you expected, check there before calling it a bug: who may register for an event (R-1), who the "chosen admin" is for report emails, the 24-hour automatic closing delay, and the 08:00 to 20:00 window for hall utilization.
