# How to apply, commit and push the zip deliveries

For the team members who will push the work. Read it once from top to bottom before starting.

## 1. What the zips are

The features were built in one working copy and handed over as **zip files, one per feature**. Each zip contains **only the files that feature adds or changes**, stored at their real paths (`apps/api/src/...`, `docs/...`). Unzipping a zip into the repository root therefore:

- **adds** the new files, and
- **replaces** the changed files with their newer version.

Nothing is duplicated and nothing has to be merged by hand, **as long as the zips are applied in order** (they build on each other: a later zip contains the final version of files that an earlier zip first created).

> Do **not** keep both versions of a file, do **not** copy files into a second folder, and do **not** unzip into a different directory and "compare". Always unzip over a clean checkout of `main` with *replace* turned on.

## 2. The order (one pull request per zip)

Start at row 1 if the events (Member 1) and hall-booking (Member 2) pull requests are already merged into `main`. If they are not, merge those first. Those two zips are stored inside a folder called `devops/`, so unzip them one level up (`unzip -o file.zip -d ..` from inside the repo, or unzip anywhere and copy the contents of the `devops/` folder over the repo).

| # | Zip | Branch | Commit message | Adds migration? |
|---|---|---|---|---|
| 1 | `admin-tools.zip` | `feature/admin-tools` | Add audit-log search and failed-jobs admin screens | no |
| 2 | `registration-complete.zip` | `feature/registration` | Add individual and team registration with waitlist | yes (030–032) |
| 3 | `attendance.zip` | `feature/attendance` | Add QR check-in, walk-ins and gate-pass PDFs | yes (033) |
| 4 | `attendance-update.zip` | `feature/attendance-checkout` | Add check-out and left-early detection | yes (034) |
| 5 | `attendance-update2.zip` | `feature/attendance-volunteers` | Add volunteers and organizer-controlled walk-ins | yes (035) |
| 6 | `certificates-complete.zip` | `feature/certificates` | Add certificates, verification and anonymous feedback | yes (036, 037) |
| 7 | `report.zip` | `feature/post-event-report` | Add automatic post-event PDF report | yes (038) |
| 8 | `report-update.zip` | `feature/report-update` | Add report versions, photos and outcomes | no |
| 9 | `scope-update.zip` | `docs/scope-update` | Record dropping of risk scoring (feature 12) | no |
| 10 | `budget-analytics.zip` | `feature/budget-analytics` | Add budget tracking, analytics and CSV export | yes (040) |
| 11 | `lifecycle-reset-monitoring.zip` | `feature/lifecycle-reset-monitoring` | Add automatic closing, password reset and metrics | yes (041) |
| 12 | `ui-refresh.zip` | `feature/ui-refresh` | Refresh the interface (design system, dark mode) | no |

**Ignore** these old zips if you see them: `registration.zip`, `registration-waitlist.zip`, `certificates.zip`, `certificates-update.zip` and `certificates-docs.zip`. The `-complete` zips already contain everything in them (`certificates-complete.zip` includes the newest certificate documents). The `-complete` zips already contain everything in them.

Only **one person** applies the zips and pushes. The others review. Never apply two zips in parallel: they touch shared files (`app.ts`, `audit.ts`, the docs).

## 3. The steps for every zip

Do these in a terminal at the repository root.

```bash
# 1. start from an up-to-date main
git checkout main
git pull

# 2. new branch for this zip (name from the table)
git checkout -b feature/registration

# 3. apply the zip: -o replaces existing files without asking
unzip -o ~/Downloads/registration-complete.zip -d .

# 4. look at what changed: this MUST be only this feature's files
git status
```

**Stop at step 4 if `git status` shows anything unexpected** (for example files of another feature, or `node_modules`, `.env`, `storage/`). That means a previous pull request is not merged yet or the zip was unzipped in the wrong place. Do not commit; ask.

```bash
# 5. install dependencies (the zips add pdfkit, qrcode and jsqr along the way)
npm ci

# 6. apply database migrations to your local database (only if the table above says yes)
npm run migrate

# 7. run all the checks: they must all pass before you commit
npm run lint
npm run typecheck
npm run format:check
npm test
npm run build

# 8. commit with the message from the table, push, open the pull request
git add -A
git commit -m "Add individual and team registration with waitlist"
git push -u origin feature/registration
```

Then on GitHub:

1. Open a pull request from the branch into `main`. Title = the commit message. In the description write: the feature number (see `docs/feature-status.md`), what it adds, and "tests: all pass locally".
2. Wait for the CI checks to go green. If a check fails, copy the error text and send it to the project lead; do not edit files by hand to make it pass.
3. One teammate reviews and approves.
4. Merge (use "Squash and merge" or "Create a merge commit": either is fine, just be consistent).
5. **Only now** go back to step 1 for the next zip.

## 4. Special cases

- **Deleted file.** `certificates-complete.zip` replaces an older arrangement; if you earlier applied the old `certificates.zip`, also delete `apps/api/src/modules/certificates/hooks.ts` by hand. If you start from the table above you do not have it, so nothing to do.
- **`booking-concurrency.test.ts` timeouts on CI.** Member 2's branch already contains a longer timeout. No zip overwrites it. Leave it.
- **`.env` is never committed.** `git status` must never show `.env` or `infra/monitoring/metrics-token`. If it does, they are not ignored: tell the lead.
- **Migrations complain "sorts before an applied one".** Your local database already has a later migration. Drop and recreate your local `events_dev` database, then run `npm run migrate` again.
- **Merge conflict.** It should not happen if the order above is followed. If it does, do not resolve it by hand: stop and ask.
- **Docker/Compose steps in CI fail.** The Docker and Compose files and the GitHub Actions workflow have never been run by the author (no Docker on that machine). Send the exact error; it is probably a small fix.

## 5. After the last zip

1. `git checkout main && git pull`.
2. `npm ci && npm run migrate && npm test`.
3. Follow `docs/manual-test-guide.md` once from top to bottom.
4. Update `README.md` ("Current state" is out of date) and `docs/feature-status.md` with what you saw.

## 6. Rules the project asks of everybody (from `CLAUDE.md`)

- Never commit directly to `main`; one concern per pull request; at least one reviewer.
- Never force-push a shared branch or rewrite shared history.
- Never commit `.env`, keys, passwords, `node_modules`, build output or generated files.
- Do not claim tests pass unless you ran them and saw the result.
