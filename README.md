# HFJ Volunteers

Credentialing and (later) call scheduling for HFJ volunteers. It replaces the
`DD_BPM_Response_Vol_List` spreadsheet with a roster that knows license
numbers, expiration dates and who verified them, and reminds people before
anything lapses.

Google Apps Script + Google Sheets. **No PHI**, only volunteer data.

| Phase | Scope | State |
|---|---|---|
| 1 | Roster, credentials, requirement matrix, eligibility, reminders, admin dashboard, migration | **This build** |
| 2 | Onboarding: invite → tokenized volunteer link → upload + e-signature → Drive | Next |
| 3 | Call calendar: month grid, claim/release, Google Calendar sync, gap alerts | Later |

## What Phase 1 does

- **One roster** (`Volunteers`), one row per person, with `Category`
  (LIP / NurseCNA / BehavioralHealth) set from the credential.
- **Credentials** tab: one row per license/registration, each with its own
  expiration. Recording a credential shows the volunteer's capture next to a
  link to the board's own lookup. One click records *verified against primary
  source by [name] on [date]*, and the admin's own board capture is kept as
  `SourceDocUrl`. Editing a verified credential's number, state or expiry
  clears the verification, and recording an annual attestation asks for every
  credential to be verified again.
- **Requirements** are generated from the spec's matrix for each credential
  (plus Addendum B or C when *Does telehealth* or *Precepts* is ticked).
  Changing the credential regenerates them, and items already started are
  kept for the record.
- **Eligibility**: a volunteer is eligible on a date when they are Active,
  every requirement is complete, and no credential has expired or expires
  before that date. The license item is never ticked by hand. It's complete
  when a *verified* credential of the right type is current. NPs need both an
  RN license and an NP certificate.
- **Dashboard** shows five blocks: Needs your review, Expiring soon (30/60 days),
  Expired / not eligible, Onboarding in progress, and Coverage gaps (live once
  the Phase 3 calendar has data).
- **Daily job** refreshes the calculated statuses and sends reminders: 60
  days before a credential expires, then every 30 days while it's expired,
  and 30 days before the annual attestation is due. Each reminder is sent
  once; `ReminderLog` keeps track.
- A Prospective volunteer becomes **Active automatically** once everything is
  complete.
- **AuditLog** records every change, verification, reminder and import.

## Setup (one time)

1. **Create the Sheet.** In the hfjvc.org Google Drive, create a blank Google
   Sheet named *HFJ Volunteers*. Then go to **Extensions → Apps Script**.
2. **Load the code.** Choose one way:
   - *clasp:* `npm i -g @google/clasp`, then `clasp login`. Copy
     `.clasp.json.example` to `.clasp.json` and paste in the script ID from
     **Project Settings**. Then run `clasp push`.
   - *By hand:* create each file from `src/` in the editor with the same name
     (`.gs` → Script, `.html` → HTML). In Project Settings, tick *Show
     appsscript.json* and paste in `src/appsscript.json`.
3. **Create the tabs.** Reload the Sheet and choose **HFJ Volunteers → Set up
   tabs**, then approve the permissions. You're added to `Admins`
   automatically.
4. **Add the admins.** On the `Admins` tab, fill in your `Name` (it's what
   appears in "verified by") and add Anthony Walls and Arni Jill Board with
   their hfjvc.org addresses, with `Active` ticked.
5. **Deploy the web app.** In the Apps Script editor, go to **Deploy → New
   deployment → Web app**. Set *Execute as: Me* and *Who has access: Anyone
   within hfjvc.org*. The URL it gives you is the admin dashboard.
6. **Start the reminders.** Choose **HFJ Volunteers → Install daily reminder
   trigger**. It runs at about 6am, Pacific time.

## Migrating the old roster

1. Copy the old roster's tabs into this Sheet. The app can only open its own
   Sheet, so it reads copies. In `DD_BPM_Response_Vol_List`, right-click each
   of the three tabs, choose **Copy to → Existing spreadsheet**, and pick
   *HFJ Volunteers*. The copies arrive named "Copy of …", and those are what
   the import reads. If you rename them, list their names, separated by
   commas, in `Settings → MigrationSourceTabs`.
2. Choose **HFJ Volunteers → Migration: dry run**. This writes a
   `MigrationReport` tab with two sections:
   - **Column mapping:** what each source column became. *notes* means it was
     kept as text in the volunteer's Notes.
   - **Volunteers:** every row as it will be imported, with warnings.
3. Fix anything wrong. You can correct the source, set a credential by hand
   later, or map a column explicitly in `MIGRATION_HEADER_OVERRIDES` at the
   top of `src/Migration.gs`. Then run the dry run again.
4. Choose **Migration: import volunteers**. Running it again is safe, because
   anyone already present (matched by email, or by name when there's no email)
   is skipped.
5. Delete the "Copy of …" tabs and the `MigrationReport` tab once you're
   happy with the import.

What the import does with the known problems:

- The three tabs merge into one roster. Duplicates are matched by email.
- `Added to HFJ Google Acct?` and `Added to GDrive?` both map to *Athena
  access*. It's only marked complete when every mapped column is checked.
- `Desired Frequency of 24hr call availability per month` keeps only plain
  whole numbers. Dates (the Sheets autoformat of "1/2") and anything else are
  left blank, with a "re-collect" warning in the report and in the
  volunteer's Notes. Text columns in the new tabs are formatted as plain text,
  so this can't happen again.
- Phone numbers stored as floats (`8052084439.0`) become `(805) 208-4439`.
- `Y` / `y` / `Yes` become checked.
- An old checkbox for the background check is imported as complete, with the
  note "confirm the determination". Reports and criminal history are never
  stored.

## Go-live checklist

On day one, nobody has license data, so everybody shows as not eligible.
That's expected:

1. Backfill each volunteer from their Drive folder: add their credentials,
   look each one up on the board site, mark it verified, and record the
   attestation date if you have one.
2. When the *Expired / not eligible* block shows only real problems, set
   `Settings → BlockIneligibleClaims` to `TRUE` (this matters once the Phase 3
   calendar exists).
3. Set `SendVolunteerReminders` to `TRUE`. Until then, reminders go only to
   the admins, so volunteers aren't emailed about gaps that are really just
   unfinished backfill.
4. Fill in `BackgroundCheckIntervalMonths` when the lawyer answers. When it's
   set, any determination older than the interval, or with no date, counts
   as expired.

## Permissions

The script asks Google for only what it uses:

| Permission | Why |
|---|---|
| See, edit, create and delete **only this spreadsheet** (`spreadsheets.currentonly`) | The roster itself. It can't open any other spreadsheet, the EHR's included. |
| Send email as you | Reminders |
| Manage this project's triggers | The daily reminder job |
| Show menus in the Sheet | The *HFJ Volunteers* menu |
| See your email address | The admin check |

It has no Google Drive access. The Phase 2 upload feature will need to write
to volunteers' Drive folders, and that will be a deliberate permission change
when it comes.

## Settings

| Key | Default | Meaning |
|---|---|---|
| BackgroundCheckIntervalMonths | blank | Blank = background checks don't recur |
| CalendarHorizonDays | 180 | Phase 3 |
| BlockIneligibleClaims | FALSE | Warn only until backfill is done |
| ReminderLeadDays | 60 | First expiry reminder |
| OverdueReminderIntervalDays | 30 | Repeat interval while expired |
| AttestationReminderLeadDays | 30 | Attestation reminder lead |
| SendVolunteerReminders | FALSE | Email volunteers as well as admins |
| AdminDomain | hfjvc.org | Admin accounts must be on this domain |
| MigrationSourceTabs | blank | Old roster tabs to import. Blank = every "Copy of …" tab |

## Where this goes beyond or reads into the spec

These are judgment calls. Each is easy to change.

- **Extra columns:** `Volunteers.Telehealth` and `Volunteers.Precepting`,
  which decide whether the conditional addenda apply. `Requirements` also
  gets `RequirementKey`, `CompletedBy`, `Detail` (the background check
  determination, the supervisor's name, or the school) and `Notes`.
- **Extra tabs:** `Admins` (the allowlist) and `ReminderLog` (so reminders
  aren't repeated).
- **Eligibility also requires Status = Active**, so Prospective, Inactive and
  Departed volunteers can't take call.
- **A "Not cleared" background check blocks eligibility.** "Conditional"
  doesn't.
- **A lapsed BLS, DEA or other credential blocks eligibility too**, unless a
  later row of the same type exists (a renewal).
- **Board lookup links** point to the DCA License Search
  (`search.dca.ca.gov`) for the DCA boards, and to CDPH for CNAs. They're in
  `CREDENTIAL_TYPES` in `src/Config.gs`, so check them before go-live.
- **Call reminders** (on call tomorrow, coverage gaps) come with the Phase 3
  calendar.
- I didn't have the HFJ EHR code to copy from. The domain-plus-allowlist
  sign-in and the AuditLog columns follow the spec's description, so line
  them up with the EHR if it does things differently.

## Phase 2 note

The volunteer link has to work for people outside hfjvc.org. That means a
deployment with *Who has access: Anyone* (or a second deployment). Admin
checks still work there, because `requireAdmin_()` checks the signed-in
account, not the deployment. The `AccessToken` / `TokenIssuedAt` /
`TokenRevokedAt` columns are already in place and are never sent to the
browser.

## Development

```
npm test        # Node 20+, no dependencies
```

`test/logic.test.mjs` covers the pure modules: the matrix, eligibility,
dashboard, reminders and migration parsing. `test/flow.test.mjs` runs setup →
roster edits → migration → daily job against an in-memory stand-in for
SpreadsheetApp (`test/fake-gas.mjs`).
