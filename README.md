# HFJ Volunteers

Credentialing and (later) call scheduling for HFJ volunteers. It replaces the
`DD_BPM_Response_Vol_List` spreadsheet with a roster that knows license
numbers, expiration dates and who verified them, and reminds people before
anything lapses.

Google Apps Script + Google Sheets. **No PHI**, only volunteer data.

| Phase | Scope | State |
|---|---|---|
| 1 | Roster, credentials, requirement matrix, eligibility, reminders, admin dashboard, migration | Done |
| 2 | Onboarding: invite → personal link → upload + e-signature → Drive | **This build** |
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

## What Phase 2 adds: onboarding

- **Invites.** On **Invite**, paste *name, email, credential* lines; each
  person gets a personal link by email. You can also send one from **Add
  volunteer**, or **Send / Resend / Revoke** on a volunteer's page. A link is
  a 64-character random token. Only its SHA-256 hash is stored, so the
  spreadsheet alone can't open anyone's portal. A new link replaces the old
  one, and links stop working for Departed volunteers.
- **The volunteer portal**, behind the link, needs no login. Volunteers:
  - confirm their details
  - enter each license (number, state, expiry) and upload a copy
  - read and acknowledge the PHI policy
  - sign the documents that apply to them
  - do their annual attestation

  Every action is logged, and the server only ever touches the record the
  token belongs to.
- **Their own folder.** The first visit creates *HFJ Volunteers / Lee, Ann
  (HFJV-00001)* in Drive. Signed PDFs, uploads and filed documents land
  there with names like `2026-10-09 Lee, Ann – Volunteer Provider Agreement
  v1.0.pdf`. The old per-volunteer folder stays linked as *Previous folder*.
- **Signing.**
  - The volunteer types their name, draws a signature, and agrees to sign
    electronically.
  - Agreements then wait for an **HFJ countersignature**. They appear on the
    dashboard, and one drawn signature can countersign several at once.
  - A BH trainee's **supervising clinician** signs first, through their own
    one-time emailed link.
  - Only when every signature is in is the PDF filed and the requirement
    marked complete.
  - The text signed is snapshotted, so editing the Documents tab later can't
    change a signed agreement.
- **Background check authorization.** Date of birth, address and other names
  go only into the signed PDF, never into the spreadsheet. It's signed once.
  The determination is still recorded by an admin, and reports can't be
  uploaded.
- **Existing paperwork.** Each requirement on a volunteer's page has a
  drag-and-drop box. Drop last year's signed agreement there, give the date it
  was signed, and it's filed and marked complete. The volunteer then sees it
  as *On file with HFJ* and isn't asked to sign again. Credentials have the
  same for the volunteer's copy and for your board capture.
- **Admins are emailed immediately** when a license needs verifying, when a
  document needs countersigning, and when a volunteer finishes their part.
- **A Prospective volunteer becomes Active** automatically once everything is
  complete.

### The Documents tab

The text volunteers read and sign lives in the **Documents** tab, not in this
repository. The PHI policy describes how the EHR is stored, and this repo is
public. There's one row per document:

| Column | |
|---|---|
| DocKey | Fixed key the app knows: `phi_policy`, `confidentiality`, `background_auth`, `vpa`, `add_a_supervision`, `add_b_telehealth`, `add_c_education`, `bh_agreement`, `attestation` |
| Title, Version, EffectiveDate | Shown to volunteers and stamped on every signature |
| Body | The text. `# Title`, `## Heading`, `- bullet`, `1. numbered`, blank line = new paragraph, `{{Name}}` / `{{Date}}` / `{{SupervisingPhysician}}` etc. = filled-in blanks |
| Notes | For you; not shown |

**Change the Version whenever the wording changes.** Fixing a typo? Leave
the Version alone. A new Version asks everyone who acknowledged or signed an
older one to do it again, from its EffectiveDate (blank = right away):

- Their portal shows the document as *To do* again, with a note saying what changed.
- The dashboard lists them under **Needs to re-acknowledge**.
- The daily job emails each of them a fresh personal link, which replaces their
  old one. It repeats every `DocumentUpdateReminderDays` (14) until they're done.
  Set `SendDocumentUpdateEmails` to FALSE to stop the emails.
- Call eligibility isn't affected.
- The background check authorization and the annual attestation never ask
  for this: one is signed once, the other is yearly anyway.

A document missing
from the tab shows volunteers *HFJ is finalizing this document* (that's how
the Nurse/CNA agreement appears until it exists). The **Documents** page in
the dashboard previews each one.

To load the starting text: open the Documents tab, then **File → Import →
Upload** the CSV I provided. Choose **Replace current sheet**, and untick
**Convert text to numbers, dates, and formulas**.

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

## Automatic deploys

Once this is set up, merging a pull request into `main` deploys it.
`.github/workflows/deploy.yml` runs the tests, runs `clasp push`, and then
moves the existing web app deployment to the new version, so the dashboard
URL never changes. Pull requests run the tests too (`test.yml`).

The deploy runs as a **dedicated account** (`volunteers@hfjvc.org`) that can
edit only this Sheet and its script. Its login is stored as a GitHub secret,
so even a leak of that secret couldn't reach any other Apps Script project
(the EHR's included). The web app and the daily reminders also run as that
account, so reminder emails come from it.

One-time setup:

| Where | What |
|---|---|
| Google Workspace admin | Create `volunteers@hfjvc.org`. |
| The Sheet (as an admin) | Share it with `volunteers@hfjvc.org` as **Editor**, and add that address to the `Admins` tab (Name: *HFJ Volunteers*, Active ✓). |
| https://script.google.com/home/usersettings (as volunteers@) | Turn on **Google Apps Script API**. |
| PowerShell | `clasp logout`, then `clasp login` as volunteers@. Copy the login with `Get-Content $HOME\.clasprc.json \| Set-Clipboard`, then delete it with `Remove-Item $HOME\.clasprc.json`. |
| GitHub → Settings → Secrets and variables → Actions | **Secret** `CLASPRC_JSON` = the copied login. **Variable** `SCRIPT_ID` = the script ID. **Variable** `DEPLOYMENT_ID` = the web app's deployment ID (below). |
| The Sheet (as volunteers@) | Run **HFJ Volunteers → Install daily reminder trigger** and approve. |
| Apps Script editor (as volunteers@) | **Deploy → New deployment → Web app**, *Execute as: Me*, *Anyone within hfjvc.org*. Copy the **Deployment ID** into the `DEPLOYMENT_ID` variable. The **URL** is the dashboard. |
| GitHub → Actions → Deploy | The first run after Phase 2 creates the **volunteer portal** deployment and prints its ID. Add it as the variable `VOLUNTEER_DEPLOYMENT_ID` and re-run the job. |

Notes:

- The job does nothing until `SCRIPT_ID` is set. Without `DEPLOYMENT_ID` it
  pushes code but leaves the web app on its old version.
- **A change that asks for a new permission** (Drive, for uploads) still
  needs a person to approve it once, signed in as volunteers@. Run any *HFJ
  Volunteers* menu item and accept. Until then, the web app and the reminders
  fail with an authorization error.
- If a deploy fails with `invalid_grant`, the stored login has expired or
  been revoked. Repeat the `clasp login` row and update the secret.
- There are **two web apps from one script.** The dashboard is open to
  *anyone within hfjvc.org*. The volunteer portal is open to *anyone, even
  anonymous*, because volunteers use personal email and have no HFJ login.
  Access is set per version, so each deploy pushes twice: once per access
  setting. Admin pages still refuse anyone who isn't a signed-in hfjvc.org
  admin, whichever URL they use.
- If the deploy says *"ANYONE access has been disabled by your domain
  administrator"*, or the portal link asks volunteers to sign in, Workspace
  isn't letting web apps be opened from outside hfjvc.org. Allow it **only
  for volunteers@**: put that account in its own organizational unit, then in
  the admin console go to **Apps → Google Workspace → Drive and Docs →
  Sharing settings**. For that unit, turn on *Sharing outside of hfjvc.org*
  and allow files and published web content to be visible to anyone with
  the link. Everyone else keeps the current rules.
- Each deploy creates two Apps Script versions, and Google allows 200 per
  project. To clear old ones, go to **Project History** in the editor.
- To redeploy without a code change, go to GitHub → **Actions → Deploy →
  Run workflow**.

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
| See, edit, create and delete **only the Drive files this app created** (`drive.file`) | Volunteer folders, uploads and signed PDFs. It can't see any other Drive content, including the HFJ EMR. |
| Show menus in the Sheet | The *HFJ Volunteers* menu |
| See your email address | The admin check |

**Nothing is ever shared publicly.** All Drive sharing goes through one
guarded function (`assertAllowedShare` in `src/DriveStore.gs`). It allows
only "this named person can edit" for an active admin on the admin domain,
and never "anyone with the link", a whole domain or a group. Tests fail if
any other sharing call appears in the code. The volunteer portal never
returns Drive links. So the public part is the portal page itself, and it
shows nothing without a valid personal link.

Because the app only sees files it created, it can't write into the old
per-volunteer folders. New documents go into the app's own folder tree, and
the old folder stays linked from each record.

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

## Open items

- **Annual attestation wording** in the starting Documents text is a draft I
  wrote. Review it, ideally with your lawyer.
- **Background check form and the FCRA:** if HFJ uses a third-party
  screening company, federal and California law generally require the
  *disclosure* to be a standalone document. The current form combines the
  disclosure, the authorization and a release. Worth raising with your lawyer
  alongside the recheck interval.
- **The Nurse/CNA agreement** doesn't exist yet. Add a `nurse_agreement` row
  to `DOC_FORMS` and the Documents tab when it does.

## Development

```
npm test        # Node 20+, no dependencies
```

- `test/logic.test.mjs` and `test/phase2-logic.test.mjs` cover the pure
  modules: the matrix, eligibility, dashboard, reminders, migration parsing,
  document rendering, the onboarding checklist, upload checks and invite
  parsing.
- `test/flow.test.mjs` and `test/onboarding-flow.test.mjs` run whole flows
  against an in-memory stand-in for SpreadsheetApp, Drive, mail and
  hashing (`test/fake-gas.mjs`):
  - setup → roster → migration → daily job
  - invite → portal → upload → sign → countersign, plus a supervisor's
    signature, link revocation and admin uploads
